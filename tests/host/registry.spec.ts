/**
 * The board registry against real files: one board per database file however its project is named,
 * run markers that survive a settings rebuild, and a closed board whose main file is complete.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { TaskStoreRegistry, type TaskStoreOptions } from '../../src/host/store.ts'
import { currentRunOwner } from '../../src/host/run-owner.ts'

const OPTIONS: TaskStoreOptions = {
  newTaskPlacement: 'top',
  defaultStatus: 'backlog',
  journalMode: 'wal',
  busyTimeoutMs: 1000,
}

let root: string
let project: string
const registries: TaskStoreRegistry[] = []

/**
 * A registry closed automatically after the test.
 * @returns the registry.
 */
function registry(): TaskStoreRegistry {
  const created = new TaskStoreRegistry('.dsh/tasks.db', OPTIONS)
  registries.push(created)
  return created
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-tasks-registry-'))
  project = join(root, 'project')
  mkdirSync(project)
})

afterEach(() => {
  for (const created of registries.splice(0)) created.close()
  rmSync(root, { recursive: true, force: true })
})

describe('TaskStoreRegistry', () => {
  it('opens one board for a project reached through a symlink or a trailing slash', () => {
    symlinkSync(project, join(root, 'alias'))
    const boards = registry()
    const direct = boards.open(project, 1)
    expect(boards.open(join(root, 'alias'), 2)).toBe(direct)
    expect(boards.open(`${project}/`, 3)).toBe(direct)
    expect(boards.byPath(direct.databasePath)).toBe(direct)
  })

  it('keeps a live run marked when a rebuilt registry reopens the same board', () => {
    const before = registry()
    const board = before.open(project, 1)
    const task = board.create({ title: 'running card' }, { actor: 'user' }, 2)
    board.startRun(task.id, 'job-1', currentRunOwner('s1'), { actor: 'user' }, 3)

    // What a settings change does: close every board and build a fresh registry in the same process.
    before.close()
    const after = registry().open(project, 4)

    expect(after.detail(task.id).task.runningJobId).toBe('job-1')
  })

  it('settles a run on a board its registry has since closed', () => {
    const before = registry()
    const board = before.open(project, 1)
    const task = board.create({ title: 'running card' }, { actor: 'user' }, 2)
    const owner = currentRunOwner('s1')
    board.startRun(task.id, 'job-1', owner, { actor: 'user' }, 3)
    const path = board.databasePath
    before.close()

    // The settlement arrives after the rebuild, addressed by the path the run recorded.
    const settled = before.withBoardAt(path, open =>
      open.finishRun(task.id, { jobId: 'job-1', status: 'completed', startedAt: 3, finishedAt: 4 }, owner, { actor: 'system' }, 4))

    expect(settled?.current).toBe(true)
    const reopened = registry().open(project, 5)
    expect(reopened.detail(task.id).task.runningJobId).toBeUndefined()
    expect(reopened.detail(task.id).task.lastRun?.status).toBe('completed')
  })

  it('re-judges running markers every time a registry opens a board', () => {
    const first = registry()
    const board = first.open(project, 1)
    const task = board.create({ title: 'card' }, { actor: 'user' }, 2)
    board.startRun(task.id, 'job-1', currentRunOwner('s1'), { actor: 'user' }, 3)
    first.close()

    // A second registry in the same process — a rebuild — whose judge now knows the run is over.
    const second = new TaskStoreRegistry('.dsh/tasks.db', OPTIONS, () => ({ kind: 'interrupted' }))
    registries.push(second)

    expect(second.open(project, 4).detail(task.id).task.runningJobId).toBeUndefined()
  })

  it('folds the write-ahead log into the main file on close', () => {
    const boards = registry()
    const board = boards.open(project, 1)
    for (let i = 0; i < 50; i++) board.create({ title: `card ${i}` }, { actor: 'user' }, 10 + i)
    const path = board.databasePath
    boards.close()

    const wal = `${path}-wal`
    expect(!existsSync(wal) || statSync(wal).size === 0).toBe(true)
    // Copy just `tasks.db`, leaving any sidecar behind, and read the copy.
    const copy = join(root, 'copy.db')
    copyFileSync(path, copy)
    const alone = new DatabaseSync(copy)
    try {
      expect((alone.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n).toBe(50)
      expect((alone.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')
    } finally {
      alone.close()
    }
  })
})
