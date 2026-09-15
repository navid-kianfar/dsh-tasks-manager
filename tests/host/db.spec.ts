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

const OPTIONS: TaskStoreOptions = {
  newTaskPlacement: 'top',
  defaultStatus: 'backlog',
  journalMode: 'wal',
  busyTimeoutMs: 1000,
}

/** The version-1 layout, verbatim from the build that wrote it. */
const V1_SCHEMA = readFileSync(new URL('./fixtures/board-v1.sql', import.meta.url), 'utf8')

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

  it('clears a running marker the old build left, which no process running this build can settle', () => {
    const path = versionOneBoard()
    const registry = new TaskStoreRegistry(path, OPTIONS)
    try {
      const board = registry.open(directory, 10)
      expect(board.detail('t_0000000000000000000001').task.runningJobId).toBeUndefined()
      expect(board.detail('t_0000000000000000000001').activity.at(-1)).toMatchObject({ kind: 'run-finished', to: 'interrupted' })
    } finally {
      registry.close()
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

describe('an unknown layout', () => {
  it('is refused rather than altered', () => {
    const path = join(directory, 'future.db')
    const db = new DatabaseSync(path)
    db.exec(`PRAGMA user_version = ${TASKS_SCHEMA_VERSION + 1}`)
    db.close()

    expect(() => openBoardDatabase(path, 'wal', 1000)).toThrow(TaskStoreError)
  })
})
