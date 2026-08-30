/**
 * The board screen rendered with plain data and no host.
 *
 * The whole presentational layer takes props and returns callbacks, which is what makes this
 * possible: these tests mount the real components a browser would and read the DOM they produce.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BoardScreen } from '../../src/client/board/BoardScreen.tsx'
import type { BoardScreenProps, BoardTranslate } from '../../src/client/board/contract.ts'
import { TaskId, type BoardView, type Task } from '../../src/domain/types.ts'

/** React 18 checks this before it will run effects in a test environment. */
declare global {
  // eslint-disable-next-line no-var -- the flag React reads is a global var, not a property.
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/** Echoes the key, so an assertion names the dictionary entry rather than a translation. */
const t: BoardTranslate = key => key

let root: Root | undefined
let host: HTMLElement | undefined

afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  root = undefined
  host = undefined
})

/**
 * A card with only the fields one assertion cares about.
 * @param over - fields to override.
 * @returns the card.
 */
function task(over: Partial<Task> & { ref: number }): Task {
  return {
    id: TaskId(`t_${String(over.ref).padStart(22, '0')}`),
    title: `card ${over.ref}`,
    body: '',
    status: 'backlog',
    priority: 'normal',
    labels: [],
    rank: String(over.ref),
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'user',
    ...over,
  }
}

/**
 * A board view containing the given cards, with counts derived from them.
 * @param tasks - the cards on the board.
 * @returns the view.
 */
function view(tasks: Task[]): BoardView {
  const counts = { backlog: 0, todo: 0, in_progress: 0, blocked: 0, done: 0 }
  for (const entry of tasks) counts[entry.status]++
  return { tasks, counts, archivedCount: 0, databasePath: '/tmp/p/.dsh/tasks.db' }
}

/**
 * Mount the board screen with sensible no-op actions.
 * @param over - props to override.
 * @returns the mounted container and the spies the test asserts on.
 */
function render(over: Partial<BoardScreenProps> = {}): { container: HTMLElement; onCreate: ReturnType<typeof vi.fn> } {
  const onCreate = vi.fn()
  const props: BoardScreenProps = {
    view: view([]),
    error: null,
    busy: false,
    query: {},
    onQueryChange: vi.fn(),
    detail: null,
    detailLoading: false,
    jobs: [],
    jobOutput: {},
    todos: undefined,
    promoted: [],
    onPromote: vi.fn(),
    canDispatch: false,
    canDelete: true,
    assignees: [],
    assigneesAvailable: false,
    onRefresh: vi.fn(),
    onCreate,
    onJobRead: vi.fn(),
    onJobKill: vi.fn(),
    taskActions: {
      onOpen: vi.fn(), onMove: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn(), onDispatch: vi.fn(),
      onStopRun: vi.fn(),
    },
    detailActions: {
      onClose: vi.fn(), onTitleChange: vi.fn(), onBodyChange: vi.fn(), onStatusChange: vi.fn(),
      onPriorityChange: vi.fn(), onLabelsChange: vi.fn(), onAssigneeChange: vi.fn(), onDueChange: vi.fn(),
      onArchive: vi.fn(), onDelete: vi.fn(), onDispatch: vi.fn(), onStopRun: vi.fn(),
      onComment: vi.fn(), onCommentEdit: vi.fn(), onCommentDelete: vi.fn(),
    },
    t,
    ...over,
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => { root?.render(<BoardScreen {...props} />) })
  return { container: host, onCreate }
}

describe('BoardScreen', () => {
  it('renders skeletons rather than a spinner before the first read', () => {
    const { container } = render({ view: null })
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(container.textContent).toContain('board.loading')
  })

  it('shows the failure state with the host message and a retry', () => {
    const { container } = render({ error: 'the board file is locked' })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('the board file is locked')
    expect(container.textContent).toContain('board.retry')
  })

  it('separates the empty board from an empty filter result', () => {
    expect(render().container.textContent).toContain('empty.title')
    expect(render({ query: { search: 'nothing' } }).container.textContent).toContain('empty.filtered.title')
  })

  it('lays out one column per status with its live count', () => {
    const { container } = render({
      view: view([task({ ref: 1 }), task({ ref: 2, status: 'done' }), task({ ref: 3, status: 'done' })]),
    })
    const columns = [...container.querySelectorAll('[role="listitem"]')].map(node => node.getAttribute('aria-label'))
    expect(columns).toEqual([
      'status.backlog (1)', 'status.todo (0)', 'status.in_progress (0)', 'status.blocked (0)', 'status.done (2)',
    ])
  })

  it('renders a card with its number, labels and running state', () => {
    const { container } = render({
      view: view([task({ ref: 7, title: 'ship it', labels: ['api'], runningJobId: 'task-1' })]),
    })
    const card = container.querySelector('article[data-task-id]')
    expect(card?.textContent).toContain('#7')
    expect(card?.textContent).toContain('ship it')
    expect(card?.textContent).toContain('api')
    expect(card?.textContent).toContain('card.running')
  })

  it('marks priority on the card so urgency survives a monochrome scan', () => {
    const { container } = render({ view: view([task({ ref: 1, priority: 'urgent' })]) })
    const card = container.querySelector('article[data-task-id]')
    expect(card?.getAttribute('data-priority')).toBe('urgent')
    expect(card?.textContent).toContain('priority.urgent')
  })

  it('leaves the common priority undecorated', () => {
    const { container } = render({ view: view([task({ ref: 1, priority: 'normal' })]) })
    expect(container.querySelector('article[data-task-id]')?.textContent).not.toContain('priority.normal')
  })

  it('creates a task from the composer and clears it for the next one', () => {
    const { container, onCreate } = render({ view: view([task({ ref: 1 })]) })
    const openComposer = [...container.querySelectorAll('button')]
      .find(node => node.textContent === 'board.newTask')
    act(() => { openComposer?.click() })

    const input = container.querySelector<HTMLInputElement>('input[aria-label="compose.newTaskTitle"]')
    expect(input).not.toBeNull()
    act(() => {
      (input as HTMLInputElement).value = '  a fresh task  '
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onCreate).toHaveBeenCalledWith('a fresh task', 'backlog')
    expect(input?.value).toBe('')
  })

  it('ignores a blank composer entry', () => {
    const { container, onCreate } = render()
    act(() => {
      [...container.querySelectorAll('button')].find(n => n.textContent === 'empty.action')?.click()
    })
    const input = container.querySelector<HTMLInputElement>('input[aria-label="compose.newTaskTitle"]')
    act(() => {
      (input as HTMLInputElement).value = '   '
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('names the database so a person can query it by hand', () => {
    expect(render().container.textContent).toContain('board.path')
  })

  it('shows the background panel with its empty state', () => {
    const { container } = render({ view: view([task({ ref: 1 })]) })
    act(() => {
      [...container.querySelectorAll('button')].find(n => n.textContent === 'board.background')?.click()
    })
    expect(container.textContent).toContain('jobs.empty')
  })

  it('lists a live background job with the controls that act on it', () => {
    const { container } = render({
      view: view([task({ ref: 1 })]),
      jobs: [{ id: 'bash-1', kind: 'bash', label: 'pnpm test', status: 'running', startedAt: Date.now() }],
    })
    act(() => {
      [...container.querySelectorAll('button')].find(n => n.textContent?.includes('board.background'))?.click()
    })
    expect(container.textContent).toContain('pnpm test')
    expect(container.textContent).toContain('jobs.status.running')
    expect(container.textContent).toContain('jobs.kill')
  })

  it('shows the session checklist beside the board, and says when there is none', () => {
    const absent = render({ view: view([task({ ref: 1 })]) })
    act(() => {
      [...absent.container.querySelectorAll('button')].find(n => n.textContent === 'board.session')?.click()
    })
    expect(absent.container.textContent).toContain('session.unavailable')

    const present = render({
      view: view([task({ ref: 1 })]),
      todos: [
        { content: 'read the failing test', status: 'completed' },
        { content: 'fix the fold', status: 'in_progress' },
      ],
    })
    act(() => {
      [...present.container.querySelectorAll('button')].find(n => n.textContent === 'board.session')?.click()
    })
    expect(present.container.textContent).toContain('read the failing test')
    expect(present.container.textContent).toContain('fix the fold')
    expect(present.container.textContent).toContain('session.progress')
  })

  it('promotes a checklist step onto the board', () => {
    const onPromote = vi.fn()
    const { container } = render({
      view: view([task({ ref: 1 })]),
      todos: [{ content: 'fix the fold', status: 'pending' }],
      onPromote,
    })
    act(() => {
      [...container.querySelectorAll('button')].find(n => n.textContent === 'board.session')?.click()
    })
    act(() => {
      [...container.querySelectorAll('button')].find(n => n.textContent?.includes('session.promote'))?.click()
    })
    expect(onPromote).toHaveBeenCalledWith('fix the fold')
  })

  it('marks a step already on the board instead of offering it twice', () => {
    const { container } = render({
      view: view([task({ ref: 1 })]),
      todos: [{ content: 'fix the fold', status: 'pending' }],
      promoted: ['fix the fold'],
    })
    act(() => {
      [...container.querySelectorAll('button')].find(n => n.textContent === 'board.session')?.click()
    })
    expect(container.textContent).toContain('session.promoted')
    expect([...container.querySelectorAll('button')].some(n => n.textContent?.includes('session.promote"'))).toBe(false)
  })

  it('offers a stop control on a card the agent is working', () => {
    const onStopRun = vi.fn()
    const { container } = render({
      view: view([task({ ref: 1, runningJobId: 'task-3' })]),
      taskActions: {
        onOpen: vi.fn(), onMove: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn(), onDispatch: vi.fn(), onStopRun,
      },
    })
    const stop = [...container.querySelectorAll('button')]
      .find(node => node.getAttribute('aria-label') === 'card.stopRun')
    expect(stop).not.toBeUndefined()

    act(() => { stop?.click() })
    expect(onStopRun).toHaveBeenCalledWith('task-3')
  })

  it('leaves an idle card without a stop control', () => {
    const { container } = render({ view: view([task({ ref: 1 })]) })
    expect([...container.querySelectorAll('button')]
      .some(node => node.getAttribute('aria-label') === 'card.stopRun')).toBe(false)
  })

  it('offers dispatch only where the deployment can run it', () => {
    const withDispatch = render({ view: view([task({ ref: 1 })]), canDispatch: true, detail: {
      task: task({ ref: 1 }), comments: [], activity: [],
    } })
    expect(withDispatch.container.textContent).toContain('detail.dispatch')

    const without = render({ view: view([task({ ref: 1 })]), canDispatch: false, detail: {
      task: task({ ref: 1 }), comments: [], activity: [],
    } })
    expect(without.container.textContent).not.toContain('detail.dispatch')
  })
})
