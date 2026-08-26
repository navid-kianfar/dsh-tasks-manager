/**
 * The presentational contract of the board: every prop type the board components take, in one
 * place so no component redeclares its own and they cannot drift apart.
 *
 * Everything below is pure presentation. The components hold local UI state — which card is open,
 * which column a drag is over, an unsent comment draft — and nothing else: data arrives as props
 * and every change leaves through a callback.
 *
 * @module @achasoft/dsh-tasks-manager/client/board/contract
 */

import type {
  BoardView,
  Task,
  TaskDetail,
  TaskPlacement,
  TaskPriority,
  TaskQuery,
  TaskStatus,
} from '../../domain/types.ts'
import type { JobView } from '../../host/protocol.ts'
import type { SessionTodo } from './session-todo.ts'
import type { TasksKey } from '../locales.ts'

/**
 * The board's translate function.
 *
 * Typed over this plugin's own key union so a key that is not in the dictionary is a compile error;
 * the framework's namespace-bound `t` accepts a wider key domain and is assignable to it.
 */
export type BoardTranslate = (key: TasksKey, params?: Record<string, unknown>) => string

/** Which layout the board is showing. */
export type BoardMode = 'kanban' | 'list' | 'session' | 'background'

/** A column heading a list view can sort by. */
export type SortColumn = 'ref' | 'title' | 'status' | 'priority' | 'assignee' | 'dueAt' | 'updatedAt'

/** How a list view is sorted. */
export interface SortState {
  /** The column being sorted on. */
  column: SortColumn
  /** Sort direction. */
  direction: 'asc' | 'desc'
}

/** Everything a card can be asked to do, wherever it is rendered from. */
export interface TaskActions {
  /** Open the card's detail. */
  onOpen: (taskId: string) => void
  /** Move a card to a column, at the position its new neighbours describe. */
  onMove: (taskId: string, status: TaskStatus, place: TaskPlacement) => void
  /** Archive or restore a card. */
  onArchive: (taskId: string, archived: boolean) => void
  /** Permanently delete a card. */
  onDelete: (taskId: string) => void
  /** Hand a card to the agent to work in the background. */
  onDispatch: (taskId: string) => void
}

/** One card. */
export interface TaskCardProps extends TaskActions {
  /** The card to render. */
  task: Task
  /** Whether this card's detail is open. */
  selected: boolean
  /** Whether dispatch is available at all in this deployment. */
  canDispatch: boolean
  /** Whether the model may delete cards, which decides whether the menu offers it. */
  canDelete: boolean
  /** Whether a drag is in progress anywhere on the board, so cards can dim their drop affordances. */
  dragging: boolean
  /** Begin dragging this card. */
  onDragStart: (taskId: string) => void
  /** End the drag, whatever its outcome. */
  onDragEnd: () => void
  /** Translate. */
  t: BoardTranslate
}

/** The kanban layout. */
export interface KanbanProps extends TaskActions {
  /** The cards to lay out, already filtered and in board order. */
  tasks: readonly Task[]
  /** Live per-column counts for the whole board. */
  counts: Record<TaskStatus, number>
  /** The open card, if any. */
  selectedId: string | undefined
  /** Whether dispatch is available. */
  canDispatch: boolean
  /** Whether delete is offered. */
  canDelete: boolean
  /** Add a card straight into one column. */
  onQuickAdd: (status: TaskStatus, title: string) => void
  /** Translate. */
  t: BoardTranslate
}

/** The list layout. */
export interface ListViewProps extends TaskActions {
  /** The cards to list, already filtered. */
  tasks: readonly Task[]
  /** The open card, if any. */
  selectedId: string | undefined
  /** Current sort. */
  sort: SortState
  /** Change the sort. */
  onSortChange: (sort: SortState) => void
  /** Whether dispatch is available. */
  canDispatch: boolean
  /** Whether delete is offered. */
  canDelete: boolean
  /** Translate. */
  t: BoardTranslate
}

/** The header above the board. */
export interface ToolbarProps {
  /** Current filters. */
  query: TaskQuery
  /** Replace the filters. */
  onQueryChange: (query: TaskQuery) => void
  /** Which layout is showing. */
  mode: BoardMode
  /** Switch layout. */
  onModeChange: (mode: BoardMode) => void
  /** Live per-column counts for the whole board. */
  counts: Record<TaskStatus, number>
  /** How many cards are archived. */
  archivedCount: number
  /** How many cards the current filters matched. */
  shown: number
  /** How many active cards exist in total. */
  total: number
  /** How many background jobs are running now. */
  runningJobs: number
  /** Every label in use on the board, for the label filter. */
  knownLabels: readonly string[]
  /** Start creating a card. */
  onNewTask: () => void
  /** Re-read the board now. */
  onRefresh: () => void
  /** Whether a read or a write is in flight. */
  busy: boolean
  /** Translate. */
  t: BoardTranslate
}

/** The card-detail panel. */
export interface TaskDetailProps {
  /** The open card with its comments and history, or `null` while it loads. */
  detail: TaskDetail | null
  /** Whether the detail is loading. */
  loading: boolean
  /** Whether dispatch is available in this deployment. */
  canDispatch: boolean
  /** Whether delete is offered. */
  canDelete: boolean
  /** Close the panel. */
  onClose: () => void
  /** Rename the card. */
  onTitleChange: (taskId: string, title: string) => void
  /** Rewrite the card's Markdown detail. */
  onBodyChange: (taskId: string, body: string) => void
  /** Move the card to a column. */
  onStatusChange: (taskId: string, status: TaskStatus) => void
  /** Change the card's priority. */
  onPriorityChange: (taskId: string, priority: TaskPriority) => void
  /** Replace the card's labels. */
  onLabelsChange: (taskId: string, labels: string[]) => void
  /** Change the card's assignee; the empty string clears it. */
  onAssigneeChange: (taskId: string, assignee: string) => void
  /** Change the card's due date as `YYYY-MM-DD`; the empty string clears it. */
  onDueChange: (taskId: string, date: string) => void
  /** Archive or restore the card. */
  onArchive: (taskId: string, archived: boolean) => void
  /** Permanently delete the card. */
  onDelete: (taskId: string) => void
  /** Dispatch the card to the agent. */
  onDispatch: (taskId: string) => void
  /** Stop the card's running background job. */
  onStopRun: (jobId: string) => void
  /** Write a comment. */
  onComment: (taskId: string, body: string) => void
  /** Rewrite a comment. */
  onCommentEdit: (commentId: string, body: string) => void
  /** Delete a comment. */
  onCommentDelete: (commentId: string) => void
  /** Translate. */
  t: BoardTranslate
}

/** This session's checklist, shown beside the durable board. */
export interface SessionTodosProps {
  /** The session's todo list, or `undefined` when no todo capability is composed. */
  todos: readonly SessionTodo[] | undefined
  /** Copy a checklist step onto the project board. */
  onPromote: (content: string) => void
  /** Steps already copied to the board in this view's lifetime. */
  promoted: readonly string[]
  /** Translate. */
  t: BoardTranslate
}

/** The background-jobs panel. */
export interface BackgroundProps {
  /** Every job visible to this session. */
  jobs: readonly JobView[]
  /** Output already read, by job id. */
  output: Readonly<Record<string, string>>
  /** Read a job's next output delta. */
  onRead: (jobId: string) => void
  /** Ask a job to stop. */
  onKill: (jobId: string) => void
  /** Open the card a job is working. */
  onOpenTask: (taskId: string) => void
  /** Translate. */
  t: BoardTranslate
}

/** The whole board screen. */
export interface BoardScreenProps {
  /** The board, or `null` while the first read is in flight. */
  view: BoardView | null
  /** A message explaining why the board could not be read, or `null`. */
  error: string | null
  /** Whether a read or a write is in flight. */
  busy: boolean
  /** Current filters. */
  query: TaskQuery
  /** Replace the filters. */
  onQueryChange: (query: TaskQuery) => void
  /** The open card's detail, or `null` when nothing is open. */
  detail: TaskDetail | null
  /** Whether the open card's detail is loading. */
  detailLoading: boolean
  /** This session's checklist, or `undefined` when no todo capability is composed. */
  todos: readonly SessionTodo[] | undefined
  /** Checklist steps already copied onto the board. */
  promoted: readonly string[]
  /** Copy a checklist step onto the board. */
  onPromote: (content: string) => void
  /** Background jobs visible to this session. */
  jobs: readonly JobView[]
  /** Job output already read, by job id. */
  jobOutput: Readonly<Record<string, string>>
  /** Whether dispatch is available in this deployment. */
  canDispatch: boolean
  /** Whether delete is offered. */
  canDelete: boolean
  /** Re-read the board now. */
  onRefresh: () => void
  /** Add a card. */
  onCreate: (title: string, status: TaskStatus) => void
  /** Everything the detail panel can do. */
  detailActions: Omit<TaskDetailProps, 'detail' | 'loading' | 'canDispatch' | 'canDelete' | 't'>
  /** Everything a card can do. */
  taskActions: TaskActions
  /** Read a job's next output delta. */
  onJobRead: (jobId: string) => void
  /** Ask a job to stop. */
  onJobKill: (jobId: string) => void
  /** Translate. */
  t: BoardTranslate
}

/** The zero state. */
export interface BoardEmptyProps {
  /** Whether the board is empty because filters excluded everything, rather than being empty. */
  filtered: boolean
  /** Clear the filters, or add the first card. */
  onAction: () => void
  /** Translate. */
  t: BoardTranslate
}
