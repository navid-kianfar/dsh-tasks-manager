/** The board store against a real in-memory SQLite database: lifecycle, ordering, and history. */

import { afterEach, describe, expect, it } from 'vitest'
import { TaskStore, TaskNotFoundError, type TaskStoreOptions } from '../../src/host/store.ts'
import { TaskValidationError } from '../../src/domain/validate.ts'
import type { Task, TaskStatus } from '../../src/domain/types.ts'

const OPTIONS: TaskStoreOptions = {
  newTaskPlacement: 'top',
  defaultStatus: 'backlog',
  journalMode: 'wal',
  busyTimeoutMs: 1000,
}

const open: TaskStore[] = []

/**
 * A throwaway board.
 * @param overrides - options differing from the test defaults.
 * @returns the store, closed automatically after the test.
 */
function board(overrides: Partial<TaskStoreOptions> = {}): TaskStore {
  const store = new TaskStore(':memory:', { ...OPTIONS, ...overrides })
  open.push(store)
  return store
}

/** A stable clock so timestamps in assertions are exact. */
let clock = 1_700_000_000_000

/**
 * Advance and read the test clock.
 * @returns the next epoch-ms stamp.
 */
function tick(): number {
  clock += 1000
  return clock
}

afterEach(() => {
  for (const store of open.splice(0)) store.close()
})

describe('create', () => {
  it('stores the canonical card and its first history entry', () => {
    const store = board()
    const task = store.create(
      { title: '  Ship   the  board  ', body: '  detail\n\n  ', labels: ['UI', 'ui', ' Board '], priority: 'high' },
      { actor: 'user', sessionId: 's1' },
      tick(),
    )
    expect(task.title).toBe('Ship the board')
    expect(task.body).toBe('detail')
    expect(task.labels).toEqual(['board', 'ui'])
    expect(task.priority).toBe('high')
    expect(task.status).toBe('backlog')
    expect(task.ref).toBe(1)
    expect(task.archived).toBe(false)
    expect(task.createdBy).toBe('user')
    expect(task.sessionId).toBe('s1')
    expect(task.id).toMatch(/^t_[0-9a-z]{22}$/u)

    const detail = store.detail(task.id)
    expect(detail.activity).toHaveLength(1)
    expect(detail.activity[0]?.kind).toBe('created')
    expect(detail.activity[0]?.to).toBe('Ship the board')
    expect(detail.activity[0]?.sessionId).toBe('s1')
  })

  it('never reuses a display number, even after a delete', () => {
    const store = board()
    const first = store.create({ title: 'one' }, { actor: 'user' }, tick())
    const second = store.create({ title: 'two' }, { actor: 'user' }, tick())
    expect([first.ref, second.ref]).toEqual([1, 2])
    store.remove(second.id)
    const third = store.create({ title: 'three' }, { actor: 'user' }, tick())
    expect(third.ref).toBe(3)
  })

  it('stamps completedAt when a card is created already done', () => {
    const store = board()
    const at = tick()
    const task = store.create({ title: 'already finished', status: 'done' }, { actor: 'user' }, at)
    expect(task.completedAt).toBe(at)
  })

  it('rejects an empty title without writing anything', () => {
    const store = board()
    expect(() => store.create({ title: '   ' }, { actor: 'agent' }, tick())).toThrow(TaskValidationError)
    expect(store.read().tasks).toHaveLength(0)
    expect(store.revision()).toBe(0)
  })
})

describe('ordering', () => {
  it('places new cards at the top when configured to', () => {
    const store = board({ newTaskPlacement: 'top' })
    const first = store.create({ title: 'first' }, { actor: 'user' }, tick())
    const second = store.create({ title: 'second' }, { actor: 'user' }, tick())
    expect(store.read().tasks.map(task => task.id)).toEqual([second.id, first.id])
  })

  it('places new cards at the bottom when configured to', () => {
    const store = board({ newTaskPlacement: 'bottom' })
    const first = store.create({ title: 'first' }, { actor: 'user' }, tick())
    const second = store.create({ title: 'second' }, { actor: 'user' }, tick())
    expect(store.read().tasks.map(task => task.id)).toEqual([first.id, second.id])
  })

  it('drops a card between the two neighbours a drag named', () => {
    const store = board({ newTaskPlacement: 'bottom' })
    const a = store.create({ title: 'a' }, { actor: 'user' }, tick())
    const b = store.create({ title: 'b' }, { actor: 'user' }, tick())
    const c = store.create({ title: 'c' }, { actor: 'user' }, tick())
    store.update(c.id, { place: { after: a.id, before: b.id } }, { actor: 'user' }, tick())
    expect(store.read().tasks.map(task => task.title)).toEqual(['a', 'c', 'b'])
  })

  it('moves a card into another column at the named position', () => {
    const store = board({ newTaskPlacement: 'bottom' })
    const a = store.create({ title: 'a', status: 'todo' }, { actor: 'user' }, tick())
    const b = store.create({ title: 'b', status: 'todo' }, { actor: 'user' }, tick())
    const dragged = store.create({ title: 'dragged', status: 'backlog' }, { actor: 'user' }, tick())

    const moved = store.update(
      dragged.id,
      { status: 'todo', place: { after: a.id, before: b.id } },
      { actor: 'user' },
      tick(),
    )
    expect(moved.status).toBe('todo')
    const todo = store.read({ status: ['todo'] }).tasks.map(task => task.title)
    expect(todo).toEqual(['a', 'dragged', 'b'])
  })

  it('lands at an end when a named neighbour has since left the column', () => {
    const store = board({ newTaskPlacement: 'bottom' })
    const a = store.create({ title: 'a' }, { actor: 'user' }, tick())
    const b = store.create({ title: 'b' }, { actor: 'user' }, tick())
    store.remove(a.id)
    // `after` no longer resolves: the drop still lands, rather than throwing the gesture away.
    const placed = store.update(b.id, { place: { after: a.id } }, { actor: 'user' }, tick())
    expect(placed.id).toBe(b.id)
    expect(store.read().tasks).toHaveLength(1)
  })

  it('keeps every column independently ordered', () => {
    const store = board({ newTaskPlacement: 'bottom' })
    const statuses: TaskStatus[] = ['backlog', 'todo', 'in_progress', 'blocked', 'done']
    for (const status of statuses) {
      for (let index = 0; index < 3; index++) {
        store.create({ title: `${status}-${index}`, status }, { actor: 'user' }, tick())
      }
    }
    const view = store.read()
    for (const status of statuses) {
      const column = view.tasks.filter(task => task.status === status)
      expect(column.map(task => task.title)).toEqual([`${status}-0`, `${status}-1`, `${status}-2`])
    }
    expect(view.counts).toEqual({ backlog: 3, todo: 3, in_progress: 3, blocked: 3, done: 3 })
  })
})

describe('update', () => {
  it('logs only the fields that actually changed', () => {
    const store = board()
    const task = store.create({ title: 'title', priority: 'normal' }, { actor: 'user' }, tick())
    store.update(task.id, { title: 'title', priority: 'normal' }, { actor: 'user' }, tick())
    expect(store.detail(task.id).activity).toHaveLength(1)
    expect(store.revision()).toBe(1)

    store.update(task.id, { title: 'renamed' }, { actor: 'user' }, tick())
    const kinds = store.detail(task.id).activity.map(entry => entry.kind)
    expect(kinds).toEqual(['created', 'title'])
  })

  it('stamps and clears completedAt across the done boundary', () => {
    const store = board()
    const task = store.create({ title: 'work' }, { actor: 'user' }, tick())
    const doneAt = tick()
    expect(store.update(task.id, { status: 'done' }, { actor: 'user' }, doneAt).completedAt).toBe(doneAt)
    expect(store.update(task.id, { status: 'todo' }, { actor: 'user' }, tick()).completedAt).toBeUndefined()
  })

  it('clears a clearable field with null and leaves an absent key alone', () => {
    const store = board()
    const task = store.create(
      { title: 'card', assignee: 'nav', labels: ['x'], dueAt: 1_700_000_000_000, body: 'body' },
      { actor: 'user' },
      tick(),
    )
    const cleared = store.update(task.id, { assignee: null, labels: null, dueAt: null }, { actor: 'user' }, tick())
    expect(cleared.assignee).toBeUndefined()
    expect(cleared.labels).toEqual([])
    expect(cleared.dueAt).toBeUndefined()
    expect(cleared.body).toBe('body')
  })

  it('rolls the whole patch back when one field is invalid', () => {
    const store = board()
    const task = store.create({ title: 'original' }, { actor: 'user' }, tick())
    expect(() =>
      store.update(task.id, { title: 'renamed', priority: 'nonsense' as never }, { actor: 'user' }, tick()),
    ).toThrow(TaskValidationError)
    expect(store.detail(task.id).task.title).toBe('original')
    expect(store.detail(task.id).activity).toHaveLength(1)
  })

  it('refuses an unknown card', () => {
    const store = board()
    expect(() => store.update('t_0000000000000000000000', { title: 'x' }, { actor: 'user' }, tick()))
      .toThrow(TaskNotFoundError)
  })
})

describe('archive', () => {
  it('hides a card from the board while keeping everything attached to it', () => {
    const store = board()
    const task = store.create({ title: 'card' }, { actor: 'user' }, tick())
    store.addComment(task.id, 'a note', { actor: 'user' }, tick())

    const archivedAt = tick()
    const archived = store.setArchived(task.id, true, { actor: 'user' }, archivedAt)
    expect(archived.archived).toBe(true)
    expect(archived.archivedAt).toBe(archivedAt)
    expect(store.read().tasks).toHaveLength(0)
    expect(store.read({ archived: 'archived' }).tasks).toHaveLength(1)
    expect(store.read({ archived: 'all' }).tasks).toHaveLength(1)
    expect(store.counts().archivedCount).toBe(1)
    expect(store.detail(task.id).comments).toHaveLength(1)

    const restored = store.setArchived(task.id, false, { actor: 'user' }, tick())
    expect(restored.archived).toBe(false)
    expect(restored.archivedAt).toBeUndefined()
    expect(store.read().tasks).toHaveLength(1)
    expect(store.detail(task.id).activity.map(entry => entry.kind))
      .toEqual(['created', 'comment', 'archived', 'restored'])
  })

  it('is a no-op when the card is already in the requested state', () => {
    const store = board()
    const task = store.create({ title: 'card' }, { actor: 'user' }, tick())
    const before = store.revision()
    store.setArchived(task.id, false, { actor: 'user' }, tick())
    expect(store.revision()).toBe(before)
  })
})

describe('comments', () => {
  it('writes, edits, and deletes a comment', () => {
    const store = board()
    const task = store.create({ title: 'card' }, { actor: 'user' }, tick())
    const comment = store.addComment(task.id, '  first note  ', { actor: 'agent', sessionId: 's9' }, tick())
    expect(comment.body).toBe('first note')
    expect(comment.author).toBe('agent')
    expect(comment.createdAt).toBe(comment.updatedAt)

    const editedAt = tick()
    const edited = store.editComment(comment.id, 'revised note', editedAt)
    expect(edited.body).toBe('revised note')
    expect(edited.updatedAt).toBe(editedAt)
    expect(edited.createdAt).toBe(comment.createdAt)

    store.removeComment(comment.id, tick())
    expect(store.detail(task.id).comments).toHaveLength(0)
  })

  it('rejects an empty comment', () => {
    const store = board()
    const task = store.create({ title: 'card' }, { actor: 'user' }, tick())
    expect(() => store.addComment(task.id, '   ', { actor: 'user' }, tick())).toThrow(TaskValidationError)
  })

  it('refuses a comment on an unknown card', () => {
    const store = board()
    expect(() => store.addComment('t_0000000000000000000000', 'hi', { actor: 'user' }, tick()))
      .toThrow(TaskNotFoundError)
  })

  it('takes comments and history with the card when it is deleted', () => {
    const store = board()
    const task = store.create({ title: 'card' }, { actor: 'user' }, tick())
    store.addComment(task.id, 'note', { actor: 'user' }, tick())
    store.remove(task.id)
    expect(() => store.detail(task.id)).toThrow(TaskNotFoundError)
    expect(store.read({ archived: 'all' }).tasks).toHaveLength(0)
  })
})

describe('query', () => {
  /**
   * Seed a small board covering every filter dimension.
   * @param store - the board to fill.
   * @returns the created cards by name.
   */
  function seed(store: TaskStore): { alpha: Task; beta: Task; gamma: Task } {
    const alpha = store.create(
      { title: 'Alpha login flow', body: 'OAuth handshake', status: 'todo', priority: 'urgent', labels: ['auth'], assignee: 'Nav' },
      { actor: 'user' },
      tick(),
    )
    const beta = store.create(
      { title: 'Beta search', body: 'ranking', status: 'in_progress', priority: 'low', labels: ['search', 'ui'] },
      { actor: 'user' },
      tick(),
    )
    const gamma = store.create(
      { title: 'Gamma 100% coverage', status: 'done', priority: 'normal', labels: ['ui'] },
      { actor: 'user' },
      tick(),
    )
    return { alpha, beta, gamma }
  }

  it('filters by status, priority, assignee, and label', () => {
    const store = board()
    const { alpha, beta, gamma } = seed(store)
    expect(store.read({ status: ['todo'] }).tasks.map(t => t.id)).toEqual([alpha.id])
    expect(store.read({ priority: ['low', 'normal'] }).tasks.map(t => t.id).sort())
      .toEqual([beta.id, gamma.id].sort())
    expect(store.read({ assignee: 'nav' }).tasks.map(t => t.id)).toEqual([alpha.id])
    expect(store.read({ labels: ['ui'] }).tasks.map(t => t.id).sort()).toEqual([beta.id, gamma.id].sort())
    expect(store.read({ labels: ['ui', 'search'] }).tasks.map(t => t.id)).toEqual([beta.id])
  })

  it('searches title and body case-insensitively', () => {
    const store = board()
    const { alpha, beta } = seed(store)
    expect(store.read({ search: 'ALPHA' }).tasks.map(t => t.id)).toEqual([alpha.id])
    expect(store.read({ search: 'handshake' }).tasks.map(t => t.id)).toEqual([alpha.id])
    expect(store.read({ search: 'ranking' }).tasks.map(t => t.id)).toEqual([beta.id])
  })

  it('treats LIKE wildcards in a search as literal text', () => {
    const store = board()
    const { gamma } = seed(store)
    expect(store.read({ search: '100%' }).tasks.map(t => t.id)).toEqual([gamma.id])
    // A bare `%` would match everything if it reached SQLite unescaped.
    expect(store.read({ search: '%%%' }).tasks).toHaveLength(0)
    expect(store.read({ search: '_' }).tasks).toHaveLength(0)
  })

  it('does not let a label match by prefix', () => {
    const store = board()
    store.create({ title: 'card', labels: ['review'] }, { actor: 'user' }, tick())
    expect(store.read({ labels: ['rev'] }).tasks).toHaveLength(0)
    expect(store.read({ labels: ['review'] }).tasks).toHaveLength(1)
  })

  it('reports whole-board counts regardless of the filter', () => {
    const store = board()
    seed(store)
    const view = store.read({ status: ['todo'] })
    expect(view.tasks).toHaveLength(1)
    expect(view.counts).toEqual({ backlog: 0, todo: 1, in_progress: 1, blocked: 0, done: 1 })
  })

  it('caps a read at the requested limit', () => {
    const store = board()
    for (let index = 0; index < 10; index++) {
      store.create({ title: `card ${index}` }, { actor: 'user' }, tick())
    }
    expect(store.read({ limit: 4 }).tasks).toHaveLength(4)
    expect(() => store.read({ limit: 0 })).toThrow(TaskValidationError)
  })
})

describe('runs', () => {
  it('marks a card running and records how the run ended', () => {
    const store = board()
    const task = store.create({ title: 'card' }, { actor: 'user' }, tick())
    const running = store.startRun(task.id, 'task-1', { actor: 'user', sessionId: 's1' }, tick())
    expect(running.runningJobId).toBe('task-1')

    const finished = store.finishRun(
      task.id,
      { jobId: 'task-1', status: 'completed', detail: 'exit 0', startedAt: 1, finishedAt: 2 },
      { actor: 'system' },
      tick(),
    )
    expect(finished?.runningJobId).toBeUndefined()
    expect(finished?.lastRun).toEqual({
      jobId: 'task-1', status: 'completed', detail: 'exit 0', startedAt: 1, finishedAt: 2,
    })
    expect(store.detail(task.id).activity.map(entry => entry.kind))
      .toEqual(['created', 'run-started', 'run-finished'])
  })

  it('tolerates a card deleted while its run was live', () => {
    const store = board()
    const task = store.create({ title: 'card' }, { actor: 'user' }, tick())
    store.startRun(task.id, 'task-1', { actor: 'user' }, tick())
    store.remove(task.id)
    const settled = store.finishRun(
      task.id,
      { jobId: 'task-1', status: 'killed', startedAt: 1, finishedAt: 2 },
      { actor: 'system' },
      tick(),
    )
    expect(settled).toBeUndefined()
  })

  it('clears markers stranded by a previous process', () => {
    const store = board()
    const task = store.create({ title: 'card' }, { actor: 'user' }, tick())
    store.startRun(task.id, 'task-1', { actor: 'user' }, tick())
    expect(store.clearStaleRuns(tick())).toBe(1)
    expect(store.detail(task.id).task.runningJobId).toBeUndefined()
    expect(store.clearStaleRuns(tick())).toBe(0)
  })
})

describe('revision', () => {
  it('advances on every write and stands still on a read', () => {
    const store = board()
    expect(store.revision()).toBe(0)
    const task = store.create({ title: 'card' }, { actor: 'user' }, tick())
    expect(store.revision()).toBe(1)
    store.update(task.id, { title: 'renamed' }, { actor: 'user' }, tick())
    expect(store.revision()).toBe(2)
    store.read()
    store.detail(task.id)
    expect(store.revision()).toBe(2)
  })
})

describe('outstanding', () => {
  it('orders the model-facing digest by urgency, then by activity', () => {
    const store = board()
    store.create({ title: 'someday', status: 'backlog', priority: 'low' }, { actor: 'user' }, tick())
    store.create({ title: 'finished', status: 'done', priority: 'urgent' }, { actor: 'user' }, tick())
    store.create({ title: 'blocking', status: 'blocked', priority: 'urgent' }, { actor: 'user' }, tick())
    store.create({ title: 'doing', status: 'in_progress', priority: 'urgent' }, { actor: 'user' }, tick())

    expect(store.outstanding(10).map(task => task.title)).toEqual(['doing', 'blocking', 'someday'])
  })

  it('leaves archived cards out', () => {
    const store = board()
    const task = store.create({ title: 'card' }, { actor: 'user' }, tick())
    store.setArchived(task.id, true, { actor: 'user' }, tick())
    expect(store.outstanding(10)).toHaveLength(0)
  })
})

describe('byRef', () => {
  it('resolves the display number a person or model would quote', () => {
    const store = board()
    const task = store.create({ title: 'card' }, { actor: 'user' }, tick())
    expect(store.byRef(task.ref)?.id).toBe(task.id)
    expect(store.byRef(999)).toBeUndefined()
  })
})
