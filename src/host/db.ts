/**
 * The project board's SQLite medium: where the database lives, how it is opened, and the physical
 * layout it carries.
 *
 * SQLite rather than a JSON file because the board is meant to be queried directly — `sqlite3
 * .dsh/tasks.db "select * from board"` is a supported way to use this plugin, not a debugging
 * trick. The `board` view exists for exactly that reader.
 *
 * The driver is Node's built-in `node:sqlite`, the same one the harness's own storage, session
 * persistence, and session-query backends use, so this plugin adds no native dependency to an
 * installation that already has a working one.
 *
 * @module @achasoft/dsh-tasks-manager/host/db
 */

import { DatabaseSync } from 'node:sqlite'
import { closeSync, existsSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { TASK_STATUSES } from '../domain/types.ts'

/**
 * The on-disk layout version, stamped into `PRAGMA user_version`.
 *
 * Monotonic. A database stamped with a version this build does not know is refused rather than
 * altered, because silently reshaping a file the user may also be querying by hand is worse than
 * telling them the build and the file disagree. The one exception is an upgrade this build carries
 * a migration for ({@link MIGRATIONS}): those are additive, idempotent, and run in one transaction
 * with the new stamp, so a board is either wholly at the old layout or wholly at the new one.
 *
 * - 1: the original layout.
 * - 2: `tasks.run_owner`, which process and session a running marker belongs to; triggers that
 *   advance `meta.revision` on any change to a card or comment, whoever makes it; and a `board` view
 *   ordered by workflow position rather than alphabetically.
 */
export const TASKS_SCHEMA_VERSION = 2

/** Path of the board database relative to the project root. */
export const DEFAULT_DATABASE_PATH = '.dsh/tasks.db'

/** Journal modes the board will run under; `wal` unless the project lives on a filesystem without it. */
export type JournalMode = 'wal' | 'delete' | 'truncate' | 'persist'

/** Every journal mode this plugin accepts, for configuration validation. */
export const JOURNAL_MODES = ['wal', 'delete', 'truncate', 'persist'] as const

/** Raised when the medium itself is unusable, as opposed to a caller sending a bad value. */
export class TaskStoreError extends Error {
  /**
   * @param message - what is wrong with the database or its path.
   */
  constructor(message: string) {
    super(message)
    this.name = 'TaskStoreError'
  }
}

/**
 * Resolve the board database's absolute path.
 * @param projectRoot - absolute path of the project the board belongs to.
 * @param configured - the configured path; relative paths resolve against the project root.
 * @returns the absolute database path.
 */
export function resolveDatabasePath(projectRoot: string, configured: string): string {
  return isAbsolute(configured) ? resolve(configured) : resolve(projectRoot, configured)
}

/**
 * The one spelling of a board path that every route to the same file agrees on.
 *
 * Symlinks and — on a case-insensitive volume such as a default macOS disk — letter case name one
 * file under several strings, and a registry keyed on the raw string would open it twice. The
 * directory is created so it can be resolved; the file itself is resolved once it exists.
 * @param path - absolute database path, or `:memory:`.
 * @returns the canonical path, or `:memory:` unchanged.
 */
export function canonicalDatabasePath(path: string): string {
  if (path === ':memory:') return path
  const absolute = resolve(path)
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 })
  if (existsSync(absolute)) return realpathSync.native(absolute)
  return join(realpathSync.native(dirname(absolute)), basename(absolute))
}

/**
 * Create the database file owner-only if it does not exist yet.
 *
 * A board can name people and unreleased work, so it is created `0600` rather than inheriting the
 * process umask. An existing file keeps whatever mode the user gave it — including a mode they
 * widened deliberately to share the board with a group.
 * @param path - absolute database path.
 */
function createDatabaseFile(path: string): void {
  try {
    closeSync(openSync(path, 'wx', 0o600))
  } catch (error) {
    // EEXIST is the ordinary case on every open after the first; anything else is a real fault.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/**
 * An SQL expression ranking a status column by workflow position.
 *
 * `ORDER BY status` sorts the names alphabetically — `backlog, blocked, done, in_progress, todo` —
 * so a capped read dropped in-progress and to-do work before finished work. Every ordered read of
 * the board goes through this instead. Built from {@link TASK_STATUSES}, the same array the board
 * lays its columns out from, and from literals only: nothing a caller sends reaches it.
 * @param column - the column to rank; a fixed identifier in this package.
 * @returns the `CASE` expression, unknown (hand-edited) statuses last.
 */
export function statusOrderSql(column: string): string {
  const arms = TASK_STATUSES.map((status, index) => `WHEN '${status}' THEN ${index}`).join(' ')
  return `CASE ${column} ${arms} ELSE ${TASK_STATUSES.length} END`
}

/**
 * Triggers that advance the board's change counter on any write to a card or a comment.
 *
 * In the database rather than in this plugin's write path because the board promises to notice
 * changes it did not make: a `sqlite3` session, another dsh process, a script. A counter only the
 * plugin bumps is blind to all three. SQLite fires these for every connection that writes, so the
 * two-second poll sees a hand edit exactly as it sees its own. The counter moves by one per changed
 * row; its consumers compare it for equality and never read meaning into the step.
 */
const REVISION_TRIGGERS = (['tasks', 'comments'] as const)
  .flatMap(table => (['INSERT', 'UPDATE', 'DELETE'] as const).map(event => `
  CREATE TRIGGER IF NOT EXISTS ${table}_${event.toLowerCase()}_revision AFTER ${event} ON ${table}
  BEGIN
    UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'revision';
  END;`))
  .join('\n')

/**
 * The readable projection for people running `sqlite3` against the file by hand.
 *
 * Timestamps are stored as epoch milliseconds because that is what both halves of the plugin speak;
 * the view converts them so a hand query does not have to. Columns are ordered by workflow position,
 * the way the board shows them, not by the alphabetical order of their names.
 */
const BOARD_VIEW = `
  CREATE VIEW IF NOT EXISTS board AS
    SELECT
      '#' || ref                                                    AS card,
      title,
      status,
      priority,
      CASE WHEN archived = 1 THEN 'archived' ELSE 'active' END      AS state,
      assignee,
      labels,
      datetime(created_at / 1000, 'unixepoch', 'localtime')         AS created,
      datetime(updated_at / 1000, 'unixepoch', 'localtime')         AS updated,
      id
    FROM tasks
    ORDER BY archived, ${statusOrderSql('status')}, rank;
`

/** The board's physical layout: tables, indices, triggers, and the hand-query view. */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS tasks (
    id             TEXT    PRIMARY KEY,
    ref            INTEGER NOT NULL UNIQUE,
    title          TEXT    NOT NULL,
    body           TEXT    NOT NULL DEFAULT '',
    status         TEXT    NOT NULL,
    priority       TEXT    NOT NULL,
    labels         TEXT    NOT NULL DEFAULT '[]',
    assignee       TEXT,
    rank           TEXT    NOT NULL,
    archived       INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    completed_at   INTEGER,
    archived_at    INTEGER,
    due_at         INTEGER,
    created_by     TEXT    NOT NULL,
    session_id     TEXT,
    running_job_id TEXT,
    last_run       TEXT,
    run_owner      TEXT
  ) STRICT;

  CREATE TABLE IF NOT EXISTS comments (
    id         TEXT    PRIMARY KEY,
    task_id    TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    body       TEXT    NOT NULL,
    author     TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS activity (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    kind       TEXT    NOT NULL,
    actor      TEXT    NOT NULL,
    at         INTEGER NOT NULL,
    from_value TEXT,
    to_value   TEXT,
    session_id TEXT
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_tasks_board    ON tasks(archived, status, rank);
  CREATE INDEX IF NOT EXISTS idx_tasks_updated  ON tasks(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_comments_task  ON comments(task_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_activity_task  ON activity(task_id, seq);

  CREATE INDEX IF NOT EXISTS idx_tasks_running  ON tasks(running_job_id) WHERE running_job_id IS NOT NULL;

  INSERT OR IGNORE INTO meta (key, value) VALUES ('revision', '0');
${REVISION_TRIGGERS}
${BOARD_VIEW}
`

/**
 * Add a column when an older layout lacks it.
 *
 * Checked rather than attempted-and-caught, so a genuine failure is not mistaken for "already
 * there". Also covers a file a crashed first open left unstamped with an older table shape.
 * @param db - the open handle, inside the migration transaction.
 * @param table - a fixed table name in this module.
 * @param column - a fixed column name in this module.
 * @param definition - the column's type clause.
 */
function addColumnIfMissing(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (columns.some(entry => entry.name === column)) return
  // Identifiers cannot be bound as parameters; every argument here is a literal in this module.
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

/**
 * The upgrade from each older layout to the next, keyed by the version it upgrades FROM.
 *
 * Every step is additive and idempotent: it adds, it never drops or rewrites a user's rows, and it
 * can run against a file that already carries part of it. That is what makes an automatic upgrade
 * acceptable where the rule is otherwise to refuse — the old file's data is untouched, and a board
 * written by the previous build reads the same afterwards. The one replaced object is the `board`
 * view, which holds no data.
 */
const MIGRATIONS: Readonly<Record<number, (db: DatabaseSync) => void>> = {
  1: (db) => {
    addColumnIfMissing(db, 'tasks', 'run_owner', 'TEXT')
    db.exec('DROP VIEW IF EXISTS board')
  },
}

/**
 * Bring a database to the current layout, stamping the version in the same transaction.
 *
 * The stamp is written last: it asserts the layout is complete, so a failure part-way through rolls
 * back to a file still stamped with its old version (or unstamped), which the next open retries.
 * @param db - the open handle.
 * @param stamped - the version the file carries; `0` for a new or never-completed file.
 */
function ensureLayout(db: DatabaseSync, stamped: number): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    if (stamped === 0) {
      // A new file gets the whole layout at once. A file a crashed older build left unstamped may
      // already hold tables of an older shape, which `CREATE TABLE IF NOT EXISTS` would not widen,
      // so every migration runs over it too; each is a no-op against the fresh shape.
      db.exec(SCHEMA)
      for (let version = 1; version < TASKS_SCHEMA_VERSION; version++) MIGRATIONS[version]?.(db)
    } else {
      for (let version = stamped; version < TASKS_SCHEMA_VERSION; version++) {
        const migrate = MIGRATIONS[version]
        if (migrate === undefined) throw new TaskStoreError(`no upgrade from board layout version ${version}`)
        migrate(db)
      }
    }
    // Re-run the idempotent layout so objects a migration dropped (the view) or that are new in this
    // version (triggers, indices, the revision seed) exist, then stamp.
    db.exec(SCHEMA)
    db.exec(`PRAGMA user_version = ${TASKS_SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Open the board database, creating its directory, file, and layout as needed, and upgrading an
 * older layout this build knows how to upgrade.
 * @param path - absolute database path, or `:memory:` for a throwaway board (tests).
 * @param journalMode - the journal pragma to apply.
 * @param busyTimeoutMs - how long a write waits behind another writer before failing.
 * @returns the open handle, with pragmas applied and the layout ensured.
 * @throws TaskStoreError when the file carries a layout version this build cannot read.
 */
export function openBoardDatabase(
  path: string,
  journalMode: JournalMode,
  busyTimeoutMs: number,
): DatabaseSync {
  const inMemory = path === ':memory:'
  if (!inMemory) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    createDatabaseFile(path)
  }
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA foreign_keys = ON')
    // Both values come from a validated union and a validated integer, so neither can carry SQL;
    // PRAGMA arguments cannot be bound as parameters, which is why they are interpolated.
    db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`)
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
    db.exec('PRAGMA synchronous = NORMAL')

    const stamped = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (stamped > TASKS_SCHEMA_VERSION || stamped < 0) {
      throw new TaskStoreError(
        `the task board at "${path}" was written with layout version ${stamped}, which this build (${TASKS_SCHEMA_VERSION}) cannot read. `
        + 'Move it aside to start a fresh board, or run a build that matches it.',
      )
    }
    if (stamped !== TASKS_SCHEMA_VERSION) ensureLayout(db, stamped)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
