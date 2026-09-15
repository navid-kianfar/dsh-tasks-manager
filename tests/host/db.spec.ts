/**
 * The board file's layout across versions: a board written by the previous build is upgraded in
 * place with every row intact, and a board from a build this one does not know is refused.
 *
 * Run against real files, because the upgrade path is exactly what a fixture built by today's schema
 * cannot exercise: `CREATE TABLE IF NOT EXISTS` leaves an old table's columns alone.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { TASKS_SCHEMA_VERSION, TaskStoreError, openBoardDatabase } from '../../src/host/db.ts'
import { TaskStore, TaskStoreRegistry, type TaskStoreOptions } from '../../src/host/store.ts'
import { currentRunOwner } from '../../src/host/run-owner.ts'
import { legacyFinishRun } from './legacy-build.ts'

const OPTIONS: TaskStoreOptions = {
  newTaskPlacement: 'top',
  defaultStatus: 'backlog',
  journalMode: 'wal',
  busyTimeoutMs: 1000,
}

/** The version-1 layout, verbatim from the build that wrote it. */
const V1_SCHEMA = readFileSync(new URL('./fixtures/board-v1.sql', import.meta.url), 'utf8')

/** The version-2 layout, verbatim from the build that wrote it. */
const V2_SCHEMA = readFileSync(new URL('./fixtures/board-v2.sql', import.meta.url), 'utf8')

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-tasks-db-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

/**
 * Write a board the way the version-1 build did, with one card mid-run and one comment.
 * @returns the database path.
 */
function versionOneBoard(): string {
  const path = join(directory, 'tasks.db')
  const db = new DatabaseSync(path)
  try {
    db.exec(V1_SCHEMA)
    db.exec('PRAGMA user_version = 1')
    db.exec("INSERT INTO meta (key, value) VALUES ('revision', '7'), ('next_ref', '3')")
    db.prepare(`
      INSERT INTO tasks (id, ref, title, body, status, priority, labels, assignee, rank, archived,
        created_at, updated_at, completed_at, archived_at, due_at, created_by, session_id, running_job_id, last_run)
      VALUES (?, ?, ?, '', ?, 'normal', '[]', NULL, ?, 0, 1, 1, NULL, NULL, NULL, 'user', NULL, ?, NULL)
    `).run('t_0000000000000000000001', 1, 'kept card', 'todo', 'U', 'task-4')
    db.prepare(`
      INSERT INTO tasks (id, ref, title, body, status, priority, labels, assignee, rank, archived,
        created_at, updated_at, completed_at, archived_at, due_at, created_by, session_id, running_job_id, last_run)
      VALUES (?, ?, ?, '', ?, 'normal', '[]', NULL, ?, 0, 1, 1, NULL, NULL, NULL, 'user', NULL, NULL, NULL)
    `).run('t_0000000000000000000002', 2, 'finished card', 'done', 'U')
    db.prepare('INSERT INTO comments (id, task_id, body, author, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)')
      .run('c_0000000000000000000001', 't_0000000000000000000001', 'a comment', 'user')
  } finally {
    db.close()
  }
  return path
}

describe('upgrading a version-1 board', () => {
  it('adds the run owner column, keeps every row, and stamps the new version', () => {
    const path = versionOneBoard()
    const store = new TaskStore(path, OPTIONS)
    try {
      expect(store.detail('t_0000000000000000000001').task.title).toBe('kept card')
      expect(store.detail('t_0000000000000000000001').comments.map(comment => comment.body)).toEqual(['a comment'])
      expect(store.revision()).toBe(7)
      expect(store.create({ title: 'new' }, { actor: 'user' }, 2).ref).toBe(3)
    } finally {
      store.close()
    }

    const db = new DatabaseSync(path)
    try {
      const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
      expect(version.user_version).toBe(TASKS_SCHEMA_VERSION)
      const columns = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(column => column.name)
      expect(columns).toContain('run_owner')
      // The hand-query view now orders columns the way the board does.
      const cards = (db.prepare('SELECT card FROM board').all() as { card: string }[]).map(row => row.card)
      expect(cards).toEqual(['#3', '#1', '#2'])
    } finally {
      db.close()
    }
  })

  it('keeps a running marker the old build left, which may still be live in a process on that build', () => {
    const path = versionOneBoard()
    const registry = new TaskStoreRegistry(path, OPTIONS)
    try {
      const board = registry.open(directory, 10)
      const { task, activity } = board.detail('t_0000000000000000000001')
      expect(task.runningJobId).toBe('task-4')
      expect(task.runOwnerUnknown).toBe(true)
      expect(activity.some(entry => entry.kind === 'run-finished')).toBe(false)
    } finally {
      registry.close()
    }
  })

  it('still lets a process on the old build settle its own run after the upgrade', () => {
    const path = versionOneBoard()
    const store = new TaskStore(path, OPTIONS)
    try {
      legacyFinishRun(path, 't_0000000000000000000001', { jobId: 'task-4', status: 'completed', startedAt: 1, finishedAt: 2 }, 20)
      expect(store.detail('t_0000000000000000000001').task.runningJobId).toBeUndefined()
      expect(store.detail('t_0000000000000000000001').task.lastRun?.status).toBe('completed')
    } finally {
      store.close()
    }
  })

  it('refuses a stale settlement from the old build once a newer run holds the card', () => {
    const path = versionOneBoard()
    const store = new TaskStore(path, OPTIONS)
    try {
      const taskId = 't_0000000000000000000001'
      store.clearUnknownRun(taskId, 'task-4', { actor: 'user', sessionId: 's1' }, 20)
      const owner = currentRunOwner('s1')
      store.startRun(taskId, 'task-1', owner, { actor: 'user', sessionId: 's1' }, 21)

      // The old process's run finally settles and clears the card by id, as that build did.
      expect(() => { legacyFinishRun(path, taskId, { jobId: 'task-4', status: 'completed', startedAt: 1, finishedAt: 22 }, 22) })
        .toThrow(/run_owner/u)

      expect(store.runMarker(taskId)).toMatchObject({ jobId: 'task-1', owner })
      expect(store.detail(taskId).task.lastRun).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('upgrades a board still open in a version-1 process without breaking that process\'s writes', () => {
    const path = versionOneBoard()
    // What the old build keeps doing: inserts that name the version-1 columns only.
    const old = new DatabaseSync(path)
    const store = new TaskStore(path, OPTIONS)
    try {
      old.prepare(`
        INSERT INTO tasks (id, ref, title, body, status, priority, labels, assignee, rank, archived,
          created_at, updated_at, completed_at, archived_at, due_at, created_by, session_id, running_job_id, last_run)
        VALUES ('t_0000000000000000000009', 9, 'from the old build', '', 'todo', 'normal', '[]', NULL, 'k', 0, 1, 1, NULL, NULL, NULL, 'user', NULL, NULL, NULL)
      `).run()
      expect(store.detail('t_0000000000000000000009').task.title).toBe('from the old build')
    } finally {
      store.close()
      old.close()
    }
  })

  it('is idempotent: reopening an upgraded board changes nothing', () => {
    const path = versionOneBoard()
    new TaskStore(path, OPTIONS).close()
    const store = new TaskStore(path, OPTIONS)
    try {
      const task = store.create({ title: 'after' }, { actor: 'user' }, 3)
      store.startRun(task.id, 'task-1', currentRunOwner('s1'), { actor: 'user' }, 4)
      expect(store.runMarker(task.id)?.owner?.sessionId).toBe('s1')
    } finally {
      store.close()
    }
  })
})

/**
 * Write a board the way the version-2 build did, with one card carrying an owned run.
 * @param owner - the owner JSON to record.
 * @returns the database path.
 */
function versionTwoBoard(owner: string): string {
  const path = join(directory, 'tasks-v2.db')
  const db = new DatabaseSync(path)
  try {
    db.exec(V2_SCHEMA)
    db.exec('PRAGMA user_version = 2')
    db.prepare(`
      INSERT INTO tasks (id, ref, title, body, status, priority, labels, assignee, rank, archived,
        created_at, updated_at, completed_at, archived_at, due_at, created_by, session_id, running_job_id, last_run, run_owner)
      VALUES (?, 1, 'owned run', '', 'in_progress', 'normal', '[]', NULL, 'U', 0, 1, 1, NULL, NULL, NULL, 'user', NULL, 'task-1', NULL, ?)
    `).run('t_0000000000000000000001', owner)
    // After the card, so the version-2 revision trigger does not move the seeded value.
    db.exec("INSERT INTO meta (key, value) VALUES ('revision', '3'), ('next_ref', '2')")
  } finally {
    db.close()
  }
  return path
}

/**
 * The layout objects a file carries, in a form that is the same however the file got there.
 * @param path - the database file.
 * @returns every table's columns and every index, trigger, and view's SQL, by name.
 */
function layoutOf(path: string): Record<string, unknown> {
  const db = new DatabaseSync(path)
  try {
    const objects = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as { type: string; name: string; sql: string | null }[]
    // A column added by ALTER TABLE is spelled differently in the stored CREATE TABLE text, so tables
    // are compared by their columns; everything else by its SQL.
    return Object.fromEntries(objects.map(object => [
      `${object.type}:${object.name}`,
      object.type === 'table'
        ? db.prepare(`PRAGMA table_info(${object.name})`).all().map(column => ({ ...column }))
        : object.sql,
    ]))
  } finally {
    db.close()
  }
}

describe('upgrading a version-2 board', () => {
  it('installs the running-marker guard, keeps the owned run, and stamps the new version', () => {
    const owner = currentRunOwner('s1')
    const path = versionTwoBoard(JSON.stringify(owner))
    const store = new TaskStore(path, OPTIONS)
    try {
      expect(store.runMarker('t_0000000000000000000001')).toMatchObject({ jobId: 'task-1', owner })
      expect(store.revision()).toBe(3)
    } finally {
      store.close()
    }

    const db = new DatabaseSync(path)
    try {
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(TASKS_SCHEMA_VERSION)
      // A hand clear that forgets the owner is refused, and says what to write instead.
      expect(() => db.exec("UPDATE tasks SET running_job_id = NULL WHERE ref = 1")).toThrow(/run_owner = NULL/u)
      db.exec('UPDATE tasks SET running_job_id = NULL, run_owner = NULL WHERE ref = 1')
      expect(db.prepare('SELECT running_job_id, run_owner FROM tasks WHERE ref = 1').get()).toEqual({ running_job_id: null, run_owner: null })
    } finally {
      db.close()
    }
  })

  it('arrives at the same layout as a new board and as an upgraded version-1 board', () => {
    const fresh = join(directory, 'fresh.db')
    new TaskStore(fresh, OPTIONS).close()
    const fromOne = versionOneBoard()
    new TaskStore(fromOne, OPTIONS).close()
    const fromTwo = versionTwoBoard('null')
    new TaskStore(fromTwo, OPTIONS).close()

    expect(layoutOf(fromOne)).toEqual(layoutOf(fresh))
    expect(layoutOf(fromTwo)).toEqual(layoutOf(fresh))
  })
})

describe('an unknown layout', () => {
  it('is refused rather than altered', () => {
    const path = join(directory, 'future.db')
    const db = new DatabaseSync(path)
    db.exec(`PRAGMA user_version = ${TASKS_SCHEMA_VERSION + 1}`)
    db.close()

    expect(() => openBoardDatabase(path, 'wal', 1000)).toThrow(TaskStoreError)
  })
})
