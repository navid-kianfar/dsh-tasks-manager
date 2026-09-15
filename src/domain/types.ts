/**
 * The project task board's domain vocabulary — the ONE home of every task, comment, and activity
 * type, plus the branded ids that carry them across the SQLite store, the Typert wire, the
 * model-facing tools, and the browser.
 *
 * Deliberately dependency-free apart from the `Branded` type primitive: the Typert generator reads
 * this module while it is staged inside a deepseek-harness checkout, and every value import it
 * cannot resolve there fails the whole generation. Keep it types and constants only.
 *
 * @module @achasoft/dsh-tasks-manager/domain/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Identifies one card on the project board. Opaque and durable: it is the primary key in
 * `.dsh/tasks.db`, the handle the model addresses a card by, and the drag target in the browser.
 */
export type TaskId = Branded<'TaskId'>

/**
 * Brand a string as a {@link TaskId}. No validation — callers that accept untrusted input parse
 * with `parseTaskId` instead.
 * @param id - the raw id string.
 * @returns the same string, branded.
 */
export function TaskId(id: string): TaskId {
  return id as TaskId
}

/** Identifies one comment on a card. */
export type CommentId = Branded<'TaskCommentId'>

/**
 * Brand a string as a {@link CommentId}.
 * @param id - the raw id string.
 * @returns the same string, branded.
 */
export function CommentId(id: string): CommentId {
  return id as CommentId
}

/**
 * The board's columns, in board order.
 *
 * Fixed rather than configurable, and the one place in this plugin where that is deliberate: a
 * status is a durable value written into every row, every activity record, and every model-facing
 * tool description. A deployment-editable set would make an existing `.dsh/tasks.db` reference
 * columns the running build no longer knows, which is a migration problem, not a tunable. Which of
 * these columns the board *shows*, and which one new cards land in, are configuration.
 */
export const TASK_STATUSES = ['backlog', 'todo', 'in_progress', 'blocked', 'done'] as const

/** A card's column on the board. */
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** Statuses that mean the work is finished; a card in one of these is not outstanding work. */
export const TERMINAL_STATUSES: readonly TaskStatus[] = ['done']

/** Priorities, ascending in urgency. */
export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const

/** A card's priority. */
export type TaskPriority = (typeof TASK_PRIORITIES)[number]

/**
 * Who performed an action. `agent` covers every model-initiated write (the tools), `user` every
 * human one (the board UI), and `system` the plugin's own bookkeeping — an automatic status
 * transition when a dispatched background job settles, for instance.
 */
export const TASK_ACTORS = ['user', 'agent', 'system'] as const

/** Who performed an action. */
export type TaskActor = (typeof TASK_ACTORS)[number]

/** One card on the project board. */
export interface Task {
  /** Durable primary key. */
  id: TaskId
  /**
   * Monotonic per-board display number (`#1`, `#2`, …). Never reused, including after a delete, so
   * a number in a comment or a commit message keeps pointing at the same card.
   */
  ref: number
  /** One-line imperative summary. Trimmed, non-empty. */
  title: string
  /** Optional Markdown detail. Empty string when absent — never null, so callers need no branch. */
  body: string
  /** Current column. */
  status: TaskStatus
  /** Current priority. */
  priority: TaskPriority
  /** Free-form labels, lowercased, de-duplicated, sorted. */
  labels: readonly string[]
  /** Free-form assignee, or `undefined` when nobody is named. */
  assignee?: string | undefined
  /**
   * Ordering key within the card's column: a fractional index (see `./rank.ts`). Dropping a card
   * between two neighbours mints a key between theirs, so a reorder writes exactly one row.
   */
  rank: string
  /** Whether the card is archived — hidden from the board but fully recoverable. */
  archived: boolean
  /** Epoch ms the card was created. */
  createdAt: number
  /** Epoch ms of the last change to any field. */
  updatedAt: number
  /** Epoch ms the card most recently entered a terminal status; cleared when it is reopened. */
  completedAt?: number | undefined
  /** Epoch ms the card was archived; cleared when it is restored. */
  archivedAt?: number | undefined
  /** Optional due date as epoch ms. */
  dueAt?: number | undefined
  /** Who created the card. */
  createdBy: TaskActor
  /** The harness session the card was created from, when it was created from one. */
  sessionId?: string | undefined
  /**
   * The background job currently working this card, when one is running. Cleared when the job
   * settles; {@link Task.lastRun} keeps the outcome.
   */
  runningJobId?: string | undefined
  /**
   * Set when the running marker does not record which dsh process owns the run — it was written by
   * an older build of this plugin, or edited by hand. Nothing can tell whether that run is still live
   * somewhere, so the marker is never cleared automatically; the board shows it as "owner unknown"
   * and clears it only when a person confirms. Absent on idle cards and on runs with a known owner.
   */
  runOwnerUnknown?: true | undefined
  /** The most recent dispatch's outcome, present once a dispatched job has settled. */
  lastRun?: TaskRunSummary | undefined
}

/** How a dispatched background run ended. */
export interface TaskRunSummary {
  /** The job registry's id for the run. */
  jobId: string
  /** Terminal status reported by the job registry. */
  status: 'completed' | 'killed' | 'failed'
  /** Kind-specific detail the job registry supplied, when it supplied one. */
  detail?: string | undefined
  /** Epoch ms the run started. */
  startedAt: number
  /** Epoch ms the run settled. */
  finishedAt: number
}

/** One comment on a card. */
export interface TaskComment {
  /** Durable primary key. */
  id: CommentId
  /** The card this comment belongs to. */
  taskId: TaskId
  /** Markdown body. Trimmed, non-empty. */
  body: string
  /** Who wrote it. */
  author: TaskActor
  /** Epoch ms it was written. */
  createdAt: number
  /** Epoch ms it was last edited; equal to {@link createdAt} when never edited. */
  updatedAt: number
}

/**
 * The kinds of change the activity log records. Each one answers a question the board's card
 * detail asks out loud ("when did this move?", "who archived it?"), which is why the log is a
 * first-class table rather than a diff reconstructed from `updatedAt`.
 */
export const TASK_ACTIVITY_KINDS = [
  'created',
  'status',
  'priority',
  'title',
  'body',
  'labels',
  'assignee',
  'due',
  'archived',
  'restored',
  'comment',
  'run-started',
  'run-finished',
] as const

/** What kind of change one activity record describes. */
export type TaskActivityKind = (typeof TASK_ACTIVITY_KINDS)[number]

/** One entry in a card's history. */
export interface TaskActivity {
  /** Monotonic per-database sequence number; also the stable sort key. */
  seq: number
  /** The card the entry belongs to. */
  taskId: TaskId
  /** What changed. */
  kind: TaskActivityKind
  /** Who changed it. */
  actor: TaskActor
  /** Epoch ms of the change. */
  at: number
  /** Previous value as display text, when the kind has one. */
  from?: string | undefined
  /** New value as display text, when the kind has one. */
  to?: string | undefined
  /** Session the change was made from, when it was made from one. */
  sessionId?: string | undefined
}

/** Per-status card counts across the whole board, archived cards excluded. */
export type TaskCounts = Record<TaskStatus, number>

/** A board read: the cards a query matched, plus the counts the header renders. */
export interface BoardView {
  /** Matching cards, ordered by status then {@link Task.rank}. */
  tasks: readonly Task[]
  /** Live per-column counts for the whole board, independent of the query's filters. */
  counts: TaskCounts
  /** How many archived cards exist, so the UI can offer to show them without counting twice. */
  archivedCount: number
  /** Absolute path of the SQLite database backing this board. */
  databasePath: string
}

/** Filters narrowing a board read. Every field is optional; omitting all of them reads the board. */
export interface TaskQuery {
  /** Restrict to these columns. Omitted means every column. */
  status?: readonly TaskStatus[] | undefined
  /** Restrict to these priorities. Omitted means every priority. */
  priority?: readonly TaskPriority[] | undefined
  /** Require every one of these labels. Omitted means no label constraint. */
  labels?: readonly string[] | undefined
  /** Restrict to this assignee. */
  assignee?: string | undefined
  /** Case-insensitive substring match over title and body. */
  search?: string | undefined
  /**
   * Which archive states to include. `active` (the default) hides archived cards, `archived` shows
   * only them, `all` shows both.
   */
  archived?: 'active' | 'archived' | 'all' | undefined
  /** Cap on returned cards. Omitted means the store's own ceiling applies. */
  limit?: number | undefined
}

/** The fields a card is created with. Everything not supplied takes a documented default. */
export interface TaskCreate {
  /** One-line imperative summary; required and non-empty after trimming. */
  title: string
  /** Optional Markdown detail. */
  body?: string | undefined
  /** Starting column; defaults to the configured `defaultStatus`. */
  status?: TaskStatus | undefined
  /** Priority; defaults to `normal`. */
  priority?: TaskPriority | undefined
  /** Labels; defaults to none. */
  labels?: readonly string[] | undefined
  /** Assignee; defaults to nobody. */
  assignee?: string | undefined
  /** Due date as epoch ms. */
  dueAt?: number | undefined
  /** Position within the starting column; defaults to the top of that column. */
  place?: TaskPlacement | undefined
}

/**
 * A requested position within a column, as the two neighbours to land between. Both absent means
 * the top of the column. Expressed as neighbours rather than an index because an index is stale
 * the moment another writer moves a card, while neighbours still describe the intent.
 */
export interface TaskPlacement {
  /** The card to land after, or `undefined` to land at the top. */
  after?: TaskId | undefined
  /** The card to land before, or `undefined` to land at the bottom. */
  before?: TaskId | undefined
}

/**
 * The fields a card can be changed to. A key present with `undefined` and a key absent both mean
 * "leave it alone"; the nullable fields carry `null` to mean "clear it", which is why they are not
 * simply optional.
 */
export interface TaskPatch {
  /** New title. */
  title?: string | undefined
  /** New Markdown body; `null` clears it. */
  body?: string | null | undefined
  /** New column. */
  status?: TaskStatus | undefined
  /** New priority. */
  priority?: TaskPriority | undefined
  /** Replacement label set; `null` clears every label. */
  labels?: readonly string[] | null | undefined
  /** New assignee; `null` clears it. */
  assignee?: string | null | undefined
  /** New due date as epoch ms; `null` clears it. */
  dueAt?: number | null | undefined
  /** New position, within the new column when `status` moves too. */
  place?: TaskPlacement | undefined
}

/** Everything the card-detail surface shows for one card. */
export interface TaskDetail {
  /** The card itself. */
  task: Task
  /** Its comments, oldest first. */
  comments: readonly TaskComment[]
  /** Its history, oldest first. */
  activity: readonly TaskActivity[]
}
