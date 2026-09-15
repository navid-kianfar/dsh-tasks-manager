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

/**
 * The on-disk layout version, stamped into `PRAGMA user_version`.
 *
 * Monotonic, with no migrations: a database stamped with any other version is refused rather than
 * altered in place, because silently reshaping a file the user may also be querying by hand is
 * worse than telling them the build and the file disagree.
 */
export const TASKS_SCHEMA_VERSION = 1

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

/** The board's physical layout: tables, indices, and the hand-query view. */
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
    last_run       TEXT
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

  -- A readable projection for people running sqlite3 against this file by hand. Timestamps are
  -- stored as epoch milliseconds because that is what both halves of the plugin speak; the view
  -- converts them so a hand query does not have to.
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
    ORDER BY archived, status, rank;
`

/**
 * Open the board database, creating its directory, file, and layout as needed.
 *
 * The version stamp is written last on a fresh database: the stamp asserts the layout is complete,
 * so a failure part-way through leaves an unstamped file that the next open rebuilds from scratch
 * rather than a stamped file missing half its tables.
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
    if (stamped !== 0 && stamped !== TASKS_SCHEMA_VERSION) {
      throw new TaskStoreError(
        `the task board at "${path}" was written with layout version ${stamped}, which this build (${TASKS_SCHEMA_VERSION}) cannot read. `
        + 'Move it aside to start a fresh board, or run a build that matches it.',
      )
    }
    db.exec(SCHEMA)
    if (stamped === 0) db.exec(`PRAGMA user_version = ${TASKS_SCHEMA_VERSION}`)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
