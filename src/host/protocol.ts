/**
 * The wire contract between this plugin's two halves: the RPC channel name, every endpoint, and the
 * request and result type of each.
 *
 * It rides `ctx.connection.rpc` — the harness's generic unary channel — rather than Typert. Typert
 * would give per-field zod codecs for free, but only in exchange for a generated artifact that no
 * package outside the harness checkout can rebuild, and this plugin already validates every field
 * at the model-tool boundary. One validation path (`../domain/validate.ts`) serving both callers is
 * both less code and one fewer thing that can silently drift.
 *
 * Endpoint names are dotted (`board.read`); the channel accepts `[A-Za-z0-9_$.-]` per segment.
 *
 * @module @achasoft/dsh-tasks-manager/host/protocol
 */

import type {
  BoardView,
  Task,
  TaskComment,
  TaskCreate,
  TaskDetail,
  TaskPatch,
  TaskPlacement,
  TaskQuery,
  TaskStatus,
} from '../domain/types.ts'
import type { GitAuthor } from './git-authors.ts'

/** The logical RPC channel this plugin owns. One absolute segment, as the channel grammar requires. */
export const TASKS_RPC_CHANNEL = '/dsh-tasks'

/**
 * Every request carries the calling session, because the board it addresses is the one belonging to
 * that session's project. The host resolves the project root from the session's `cwd`; the browser
 * never names a filesystem path.
 */
export interface SessionScoped {
  /** The session the board view is open in. */
  sessionId: string
}

/** `board.read` — the board, filtered. */
export interface BoardReadRequest extends SessionScoped {
  /** Filters to apply; omitted reads the whole active board. */
  query?: TaskQuery
}

/**
 * `board.revision` — the board's change counter and column counts, without the cards.
 *
 * The board view polls this while it is open so a change made by another session, another process,
 * or a hand-run `sqlite3` still reaches the UI. It is deliberately tiny: the full read only happens
 * when the revision actually moved.
 */
export interface BoardRevisionResult {
  /**
   * Change counter, advanced by database triggers on every write to a card or comment — by this
   * plugin, another process, or `sqlite3`. Compare it for equality; the size of a step means nothing.
   */
  revision: number
  /** Live active-card count per column. */
  counts: Record<TaskStatus, number>
  /** Live archived-card count. */
  archivedCount: number
}

/** `task.detail` — one card with its comments and history. */
export interface TaskDetailRequest extends SessionScoped {
  /** The card to open. */
  taskId: string
}

/** `task.create` — add a card. */
export interface TaskCreateRequest extends SessionScoped {
  /** The card's initial fields. */
  task: TaskCreate
}

/** `task.update` — change a card's fields, its column, or its position. */
export interface TaskUpdateRequest extends SessionScoped {
  /** The card to change. */
  taskId: string
  /** The fields to change; absent keys are left alone. */
  patch: TaskPatch
  /**
   * The card's `updatedAt` as the caller last read it. When sent, the update is refused with a
   * `bad-request` saying the card changed if anyone has changed it since, instead of silently
   * overwriting their edit. Optional, so an older client still updates unconditionally.
   */
  expectedUpdatedAt?: number
}

/** `task.move` — the drag-and-drop path: a new column and a position within it. */
export interface TaskMoveRequest extends SessionScoped {
  /** The dragged card. */
  taskId: string
  /** The column it was dropped into. */
  status: TaskStatus
  /** Where in that column it landed, as its new neighbours. */
  place: TaskPlacement
  /**
   * The card's `updatedAt` as the person saw it when the move began. When sent, the move is refused
   * with a `bad-request` saying the card changed if anyone has changed it since, exactly as
   * {@link TaskUpdateRequest.expectedUpdatedAt} refuses an edit. Optional, so an older client still
   * moves unconditionally.
   */
  expectedUpdatedAt?: number
}

/** `task.archive` and `task.restore` — hide a card from the board, or bring it back. */
export interface TaskArchiveRequest extends SessionScoped {
  /** The card to archive or restore. */
  taskId: string
}

/** `task.delete` — remove a card and everything attached to it, permanently. */
export interface TaskDeleteRequest extends SessionScoped {
  /** The card to delete. */
  taskId: string
}

/** `comment.add` — write a comment on a card. */
export interface CommentAddRequest extends SessionScoped {
  /** The card being commented on. */
  taskId: string
  /** The Markdown comment. */
  body: string
}

/** `comment.edit` — rewrite an existing comment. */
export interface CommentEditRequest extends SessionScoped {
  /** The comment to rewrite. */
  commentId: string
  /** Its new Markdown body. */
  body: string
}

/** `comment.remove` — delete a comment. */
export interface CommentRemoveRequest extends SessionScoped {
  /** The comment to delete. */
  commentId: string
}

/** `task.dispatch` — hand a card to the agent to work in the background. */
export interface TaskDispatchRequest extends SessionScoped {
  /** The card to work. */
  taskId: string
  /** Extra direction for this run, appended to the card's own title and body. */
  instructions?: string
}

/** What a dispatch returned. */
export interface TaskDispatchResult {
  /** The job registry's id for the run, for correlating with the background list. */
  jobId: string
  /** The card, already carrying `runningJobId`. */
  task: Task
}

/** `jobs.list` — every background job visible to this session, whatever started it. */
export type JobsListRequest = SessionScoped

/** One background job as the Background panel renders it. */
export interface JobView {
  /** Registry id (`<kind>-N`). */
  id: string
  /** Producer kind: `bash`, `subagent`, this plugin's `task`, or anything else composed. */
  kind: string
  /** The producer's one-line label — the command, or the card title. */
  label: string
  /** Lifecycle state. */
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  /** Kind-specific detail once the producer supplied one, usually at settlement. */
  detail?: string
  /** Epoch ms the job started. */
  startedAt: number
  /** Epoch ms it settled, absent while live. */
  finishedAt?: number
  /** The card this job is working, when this plugin started it. */
  taskId?: string
}

/** `jobs.read` — a job's state, and its final output when reading it takes nothing from the agent. */
export interface JobReadRequest extends SessionScoped {
  /** The job to read. */
  jobId: string
}

/** What a job read returned. */
export interface JobReadResult {
  /**
   * The job's final output once it has settled, for a card run. Empty while it runs, and always
   * empty when {@link outputWithheld} is set.
   */
  text: string
  /** The job's state at read time. */
  job: JobView
  /**
   * Set for a job whose output is a stream with one consuming cursor — a shell command, a
   * subagent the model started. That cursor is the agent's (`job_output`), so the board does not
   * read it: doing so would take the output from the agent. Absent for this plugin's own card runs.
   */
  outputWithheld?: boolean
}

/** `jobs.kill` — ask a job to stop. */
export interface JobKillRequest extends SessionScoped {
  /** The job to stop. */
  jobId: string
}

/** What a kill returned. */
export interface JobKillResult {
  /** `already-finished` when the job had settled before the request arrived. */
  outcome: 'requested' | 'already-finished'
}

/**
 * `git.authors` — everyone who has committed to the session's project.
 *
 * The board's assignee is a person on the team, and a project's commit history is the roster it
 * already carries. Session-scoped like every other endpoint: the browser never names a path, and
 * the host reads git in the same project root the board lives in.
 */
export interface GitAuthorsResult {
  /** The committers, most prolific first, with the configured identity marked. */
  authors: GitAuthor[]
  /**
   * Whether git could be read at all. `false` — no git, or a project that is not a repository —
   * lets the picker say why it has nobody to offer instead of showing an empty team.
   */
  available: boolean
}

/**
 * Every endpoint on {@link TASKS_RPC_CHANNEL}, as request/result pairs.
 *
 * The map exists so both halves derive their signatures from one declaration: the host's dispatch
 * table is keyed by it, and the browser's caller is generic over it, which makes a typo in an
 * endpoint name a compile error on both sides rather than a runtime `unknown endpoint`.
 */
export interface TasksRpcMap {
  'board.read': { request: BoardReadRequest; result: BoardView }
  'board.revision': { request: SessionScoped; result: BoardRevisionResult }
  'task.detail': { request: TaskDetailRequest; result: TaskDetail }
  'task.create': { request: TaskCreateRequest; result: Task }
  'task.update': { request: TaskUpdateRequest; result: Task }
  'task.move': { request: TaskMoveRequest; result: Task }
  'task.archive': { request: TaskArchiveRequest; result: Task }
  'task.restore': { request: TaskArchiveRequest; result: Task }
  'task.delete': { request: TaskDeleteRequest; result: { deleted: true } }
  'comment.add': { request: CommentAddRequest; result: TaskComment }
  'comment.edit': { request: CommentEditRequest; result: TaskComment }
  'comment.remove': { request: CommentRemoveRequest; result: { deleted: true } }
  'task.dispatch': { request: TaskDispatchRequest; result: TaskDispatchResult }
  'jobs.list': { request: JobsListRequest; result: { jobs: JobView[] } }
  'jobs.read': { request: JobReadRequest; result: JobReadResult }
  'jobs.kill': { request: JobKillRequest; result: JobKillResult }
  'git.authors': { request: SessionScoped; result: GitAuthorsResult }
}

export type { GitAuthor } from './git-authors.ts'

/** The endpoint names, as a union. */
export type TasksRpcEndpoint = keyof TasksRpcMap

/** The request type of one endpoint. */
export type TasksRpcRequest<E extends TasksRpcEndpoint> = TasksRpcMap[E]['request']

/** The result type of one endpoint. */
export type TasksRpcResult<E extends TasksRpcEndpoint> = TasksRpcMap[E]['result']

/** Every endpoint name at runtime, for the host's dispatch check and the tests' coverage assertion. */
export const TASKS_RPC_ENDPOINTS = [
  'board.read',
  'board.revision',
  'task.detail',
  'task.create',
  'task.update',
  'task.move',
  'task.archive',
  'task.restore',
  'task.delete',
  'comment.add',
  'comment.edit',
  'comment.remove',
  'task.dispatch',
  'jobs.list',
  'jobs.read',
  'jobs.kill',
  'git.authors',
] as const satisfies readonly TasksRpcEndpoint[]
