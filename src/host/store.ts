/**
 * The board's read and write operations over one project's SQLite database.
 *
 * Every mutation runs inside one transaction that writes the row, appends the matching activity
 * entries, and bumps the board revision together, so a reader can never observe a card that moved
 * without the history saying so. Callers hand in already-validated values
 * (`../domain/validate.ts`); this layer's job is the transaction, the history, and the SQL.
 *
 * One store instance owns one open database. {@link TaskStoreRegistry} keeps at most one per
 * project root for the process's lifetime.
 *
 * @module @achasoft/dsh-tasks-manager/host/store
 */

import { randomBytes } from 'node:crypto'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import {
  TASK_STATUSES,
  TaskId,
  type BoardView,
  type CommentId,
  type Task,
  type TaskActivity,
  type TaskActivityKind,
  type TaskActor,
  type TaskComment,
  type TaskCounts,
  type TaskCreate,
  type TaskDetail,
  type TaskPatch,
  type TaskPlacement,
  type TaskPriority,
  type TaskQuery,
  type TaskRunSummary,
  type TaskStatus,
} from '../domain/types.ts'
import { firstRank, rankBetween, rankSequence } from '../domain/rank.ts'
import {
  DEFAULT_QUERY_LIMIT,
  MAX_QUERY_LIMIT,
  TaskValidationError,
  parseAssignee,
  parseBody,
  parseComment,
  parseLabels,
  parseLimit,
  parsePriority,
  parseStatus,
  parseTimestamp,
  parseTitle,
} from '../domain/validate.ts'
import {
  canonicalDatabasePath,
  openBoardDatabase,
  resolveDatabasePath,
  statusOrderSql,
  type JournalMode,
} from './db.ts'
import { decodeRunOwner, ownerProcessState, type RunOwner } from './run-owner.ts'

/** Raised when a caller addresses a card or comment that is not in this board. */
export class TaskNotFoundError extends Error {
  /**
   * @param what - the kind of record, for the message.
   * @param id - the id that did not resolve.
   */
  constructor(what: 'task' | 'comment', id: string) {
    super(`no ${what} ${JSON.stringify(id)} on this board`)
    this.name = 'TaskNotFoundError'
  }
}

/**
 * Raised when a change was made against a card that someone else has changed since it was read.
 *
 * Its own class so the RPC layer can tell the person what happened — their edit was not applied, and
 * the board is being re-read — rather than presenting it as a malformed value.
 */
export class TaskConflictError extends Error {
  /**
   * @param ref - the card's display number, for the message.
   */
  constructor(ref: number) {
    super(`#${ref} was changed by someone else while you were editing it; your change was not applied. The card has been reloaded — make the change again if it still applies.`)
    this.name = 'TaskConflictError'
  }
}

/** A card's running marker, as the stale-run sweep and the deletion path judge it. */
export interface RunMarker {
  /** The card being worked. */
  taskId: string
  /** Its display number, for messages. */
  ref: number
  /** The job registry id recorded when the run started. Unique only within its owner process. */
  jobId: string
  /** The process and session that own the run; absent for a marker written before owners existed. */
  owner: RunOwner | undefined
  /**
   * The dispatch the history recorded for this job id: the session that started it and when. For a
   * marker with no owner this is the only lead to the run — if that session is live in this process,
   * its job registry can be asked about the job. Absent when the history holds no such entry.
   */
  started: RunStart | undefined
}

/** A `run-started` history entry, as a marker carries it. */
export interface RunStart {
  /** The session that dispatched the run, when the history recorded one. */
  sessionId: string | undefined
  /** Epoch ms the dispatch was recorded. */
  at: number
}

/**
 * What the sweep should do with one marker.
 *
 * - `live`: leave it; its owner can still settle it, or nothing can tell that it cannot.
 * - `interrupted`: its owner is gone and nothing will ever settle it; clear it and say so in the history.
 * - `settled`: the run finished but its settlement never reached the board; record this outcome.
 */
export type RunVerdict =
  | { readonly kind: 'live' }
  | { readonly kind: 'interrupted' }
  | { readonly kind: 'settled'; readonly summary: TaskRunSummary }

/** Decides the fate of one running marker. */
export type RunJudge = (marker: RunMarker) => RunVerdict

/**
 * Judge a marker by its owner process alone.
 *
 * The default for a registry with no job registry to consult. A run owned by this very process is
 * `live` here because only the job registry could say otherwise; the service supplies a judge that
 * asks it.
 *
 * A marker with no recorded owner is `live` too, and is never swept. It was written by a build that
 * predates owners (or hand-edited), and that build may still be running it — in another dsh process
 * that has had the board open since before the upgrade, or in this one before a plugin reload. No
 * process can tell that run apart from a dead one, and clearing a live one re-offers Dispatch and
 * puts two runs on the card. Such a marker is surfaced as "owner unknown" and cleared only when a
 * person confirms it ({@link TaskStore.clearUnknownRun}), or when this process's job registry
 * positively identifies the run and reports it finished (the service's judge).
 * @param marker - the marker to judge.
 * @returns the verdict.
 */
export function judgeRunByProcess(marker: RunMarker): RunVerdict {
  if (marker.owner === undefined) return { kind: 'live' }
  const state = ownerProcessState(marker.owner)
  switch (state) {
    case 'this-process':
    case 'alive':
    case 'unreachable':
      return { kind: 'live' }
    case 'gone':
      return { kind: 'interrupted' }
    default: {
      const unexpected: never = state
      throw new Error(`tasks: unexpected owner state ${String(unexpected)}`)
    }
  }
}

/** How a settlement landed on its card. */
export interface FinishedRun {
  /** The card as it now stands. */
  task: Task
  /**
   * Whether this run was still the card's current run. `false` means the marker had already been
   * swept or replaced by a newer dispatch: the history records the outcome, but the card's running
   * state and any automatic status move belong to whatever holds the marker now.
   */
  current: boolean
}

/** What else a settlement does to its card, beyond recording the outcome. */
export interface RunSettlementEffects {
  /** A comment carrying the run's report, when there is one. */
  report?: string | undefined
  /** The column to move the card to, applied only while the run is still the card's current one. */
  completedStatus?: TaskStatus | undefined
}

/** Deployment choices the store itself needs. */
export interface TaskStoreOptions {
  /** Where new cards land in their column. */
  newTaskPlacement: 'top' | 'bottom'
  /** Column a card is created in when the caller names none. */
  defaultStatus: TaskStatus
  /** Journal pragma. */
  journalMode: JournalMode
  /** How long a write waits behind another writer, in milliseconds. */
  busyTimeoutMs: number
}

/** Shape one `tasks` row comes back as. */
interface TaskRow {
  id: string
  ref: number
  title: string
  body: string
  status: string
  priority: string
  labels: string
  assignee: string | null
  rank: string
  archived: number
  created_at: number
  updated_at: number
  completed_at: number | null
  archived_at: number | null
  due_at: number | null
  created_by: string
  session_id: string | null
  running_job_id: string | null
  last_run: string | null
  run_owner: string | null
}

/** A `tasks` row read together with its marker's `run-started` history entry. */
interface MarkerRow extends TaskRow {
  /** `{"sessionId": …, "at": …}` from the newest `run-started` entry naming the row's job id, or null. */
  run_started: string | null
}

/**
 * The columns a marker is read with: the row, and its newest `run-started` entry for the same job id
 * as one JSON value — one statement however many markers there are, rather than a history lookup per
 * card.
 */
const MARKER_COLUMNS = `
  t.*,
  (
    SELECT json_object('sessionId', a.session_id, 'at', a.at)
    FROM activity a
    WHERE a.task_id = t.id AND a.kind = 'run-started' AND a.to_value = t.running_job_id
    ORDER BY a.seq DESC
    LIMIT 1
  ) AS run_started
`

/** Shape one `comments` row comes back as. */
interface CommentRow {
  id: string
  task_id: string
  body: string
  author: string
  created_at: number
  updated_at: number
}

/** Shape one `activity` row comes back as. */
interface ActivityRow {
  seq: number
  task_id: string
  kind: string
  actor: string
  at: number
  from_value: string | null
  to_value: string | null
  session_id: string | null
}

/** Who made a change and from where; threaded through every mutation into the history. */
export interface TaskAuthor {
  /** Whether the change came from the board UI, a model tool, or the plugin's own bookkeeping. */
  actor: TaskActor
  /** The session it was made from, when there was one. */
  sessionId?: string | undefined
}

/** Workflow-position ordering of the `status` column, shared by every ordered board read. */
const STATUS_ORDER = statusOrderSql('status')

/** A card's creation fields once validated, ready to insert. */
interface ParsedCreate {
  title: string
  body: string
  status: TaskStatus
  priority: TaskPriority
  labels: string[]
  assignee: string | undefined
  dueAt: number | undefined
  place: TaskPlacement | undefined
}

/** Statuses this build considers finished, for the `completedAt` stamp. */
const TERMINAL = new Set<TaskStatus>(['done'])

/**
 * Mint an opaque id with the prefix its kind is parsed by.
 *
 * 14 random bytes is 112 bits, which base-36 encodes in at most the 22 characters the parsers
 * expect; the left pad keeps every id the same length so they align in a terminal and sort stably
 * within one millisecond.
 * @param prefix - `t` for a card, `c` for a comment.
 * @returns the new id.
 */
function mintId(prefix: 't' | 'c'): string {
  const value = BigInt(`0x${randomBytes(14).toString('hex')}`).toString(36)
  return `${prefix}_${value.padStart(22, '0')}`
}

/**
 * Decode a stored label array.
 *
 * A row whose JSON is unreadable yields no labels rather than failing the read: the board is a file
 * a person may edit by hand, and one malformed cell should cost that card its labels, not hide
 * every card behind an exception.
 * @param raw - the stored JSON text.
 * @returns the labels, or none.
 */
function decodeLabels(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === 'string')
  } catch {
    // Hand-edited or truncated JSON in one cell; see the note above.
    return []
  }
}

/**
 * Decode a stored run summary, tolerating a hand-edited cell the same way {@link decodeLabels} does.
 * @param raw - the stored JSON text, or null.
 * @returns the summary, or `undefined`.
 */
function decodeRun(raw: string | null): TaskRunSummary | undefined {
  if (raw === null) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const value = parsed as Partial<TaskRunSummary>
    if (typeof value.jobId !== 'string' || typeof value.status !== 'string') return undefined
    if (typeof value.startedAt !== 'number' || typeof value.finishedAt !== 'number') return undefined
    return {
      jobId: value.jobId,
      status: value.status as TaskRunSummary['status'],
      ...value.detail === undefined ? {} : { detail: value.detail },
      startedAt: value.startedAt,
      finishedAt: value.finishedAt,
    }
  } catch {
    // Same tolerance as decodeLabels: a broken cell costs this card its run badge, nothing more.
    return undefined
  }
}

/**
 * Turn a row into the domain value.
 *
 * `status` and `priority` are cast rather than re-parsed: they were validated on the way in, and a
 * hand-edited unknown status should still render as itself on the board rather than disappear.
 * @param row - the `tasks` row.
 * @returns the card.
 */
function toTask(row: TaskRow): Task {
  return {
    id: TaskId(row.id),
    ref: row.ref,
    title: row.title,
    body: row.body,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    labels: decodeLabels(row.labels),
    ...row.assignee === null ? {} : { assignee: row.assignee },
    rank: row.rank,
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...row.completed_at === null ? {} : { completedAt: row.completed_at },
    ...row.archived_at === null ? {} : { archivedAt: row.archived_at },
    ...row.due_at === null ? {} : { dueAt: row.due_at },
    createdBy: row.created_by as TaskActor,
    ...row.session_id === null ? {} : { sessionId: row.session_id },
    ...row.running_job_id === null ? {} : { runningJobId: row.running_job_id },
    ...row.running_job_id !== null && decodeRunOwner(row.run_owner) === undefined ? { runOwnerUnknown: true } : {},
    ...decodeRun(row.last_run) === undefined ? {} : { lastRun: decodeRun(row.last_run) as TaskRunSummary },
  }
}

/**
 * A row's running marker.
 * @param row - the `tasks` row, read with {@link MARKER_COLUMNS}.
 * @returns the marker, or `undefined` when the card is idle.
 */
function toMarker(row: MarkerRow): RunMarker | undefined {
  if (row.running_job_id === null) return undefined
  return {
    taskId: row.id,
    ref: row.ref,
    jobId: row.running_job_id,
    owner: decodeRunOwner(row.run_owner),
    started: decodeRunStart(row.run_started),
  }
}

/**
 * Decode the `run-started` entry a marker row was read with.
 * @param raw - the JSON object the marker query built, or null.
 * @returns the entry, or `undefined` when there is none.
 */
function decodeRunStart(raw: string | null): RunStart | undefined {
  if (raw === null) return undefined
  const parsed = JSON.parse(raw) as { sessionId: string | null; at: number }
  return { sessionId: parsed.sessionId ?? undefined, at: parsed.at }
}

/**
 * Turn a comment row into the domain value.
 * @param row - the `comments` row.
 * @returns the comment.
 */
function toComment(row: CommentRow): TaskComment {
  return {
    id: row.id as CommentId,
    taskId: TaskId(row.task_id),
    body: row.body,
    author: row.author as TaskActor,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Turn an activity row into the domain value.
 * @param row - the `activity` row.
 * @returns the history entry.
 */
function toActivity(row: ActivityRow): TaskActivity {
  return {
    seq: row.seq,
    taskId: TaskId(row.task_id),
    kind: row.kind as TaskActivityKind,
    actor: row.actor as TaskActor,
    at: row.at,
    ...row.from_value === null ? {} : { from: row.from_value },
    ...row.to_value === null ? {} : { to: row.to_value },
    ...row.session_id === null ? {} : { sessionId: row.session_id },
  }
}


/** Values a prepared statement in this module binds; SQLite's own accepted scalar set, narrowed. */
type Bind = string | number | null

/**
 * Read one row as the column set its statement selects.
 *
 * `node:sqlite` types every result as `Record<string, SQLOutputValue>` because it cannot know a
 * statement's columns. Every statement in this module is a fixed literal over tables this module
 * created, so the column set IS known statically, and these two helpers are the one place that
 * records it. The decoders above still tolerate values a hand-edit put in a cell — knowing which
 * columns exist is not the same as trusting what is in them.
 * @param statement - the prepared statement.
 * @param params - its bound parameters, in order.
 * @returns the row, or `undefined` when the statement matched nothing.
 */
function one<T>(statement: StatementSync, ...params: Bind[]): T | undefined {
  return statement.get(...params) as unknown as T | undefined
}

/**
 * Read every row as the column set its statement selects. See {@link one}.
 * @param statement - the prepared statement.
 * @param params - its bound parameters, in order.
 * @returns the rows, in the statement's own order.
 */
function many<T>(statement: StatementSync, ...params: Bind[]): T[] {
  return statement.all(...params) as unknown as T[]
}

/** One project's board. */
export class TaskStore {
  readonly #db: DatabaseSync
  readonly #options: TaskStoreOptions
  readonly #statements = new Map<string, StatementSync>()
  /** How many {@link #transaction} calls are active, so an inner one joins the outer. */
  #transactionDepth = 0

  /** Absolute path of the database this store owns, so callers can tell the user where to look. */
  readonly databasePath: string

  /**
   * @param databasePath - absolute path of the board database, or `:memory:`.
   * @param options - the deployment's board behaviour.
   */
  constructor(databasePath: string, options: TaskStoreOptions) {
    this.databasePath = databasePath
    this.#options = options
    this.#db = openBoardDatabase(databasePath, options.journalMode, options.busyTimeoutMs)
  }

  /**
   * Release the database handle. Idempotent, so teardown can call it without checking.
   *
   * Under WAL the newest writes live in `tasks.db-wal` until a checkpoint moves them into the main
   * file. Checkpointing here means that once dsh has stopped, `tasks.db` alone is the whole board —
   * so copying or committing that one file, as a hand query invites, does not yield a board that
   * looks corrupted or rolled back.
   */
  close(): void {
    this.#statements.clear()
    if (!this.#db.isOpen) return
    try {
      if (this.#options.journalMode === 'wal') this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      // A checkpoint blocked by another reader is harmless: the WAL is still valid and the next
      // close or open folds it in. Closing must not fail because of it.
    }
    this.#db.close()
  }

  /**
   * Prepare a statement once and reuse it.
   *
   * Every statement here is a fixed literal in this module — no caller-supplied SQL reaches it — so
   * the cache key can be the SQL itself.
   * @param sql - the statement text.
   * @returns the prepared statement.
   */
  #prepare(sql: string): StatementSync {
    let statement = this.#statements.get(sql)
    if (statement === undefined) {
      statement = this.#db.prepare(sql)
      this.#statements.set(sql, statement)
    }
    return statement
  }

  /**
   * Run one unit of work as a transaction.
   *
   * Rolls back on any throw, including a validation error raised part-way through a multi-field
   * patch — a patch is one edit, so half of it must not survive.
   *
   * Re-entrant: a call made while another is running joins it rather than opening a second
   * transaction SQLite would refuse. That is what lets one settlement record the outcome, write the
   * report, and move the card as a single unit by composing the public operations that do each.
   * @param work - the body; its return value becomes the call's.
   * @returns whatever `work` returned.
   */
  #transaction<T>(work: () => T): T {
    if (this.#transactionDepth > 0) return this.#joined(work)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = this.#joined(work)
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Run work inside the current transaction, keeping the depth count.
   * @param work - the body.
   * @returns whatever `work` returned.
   */
  #joined<T>(work: () => T): T {
    this.#transactionDepth++
    try {
      return work()
    } finally {
      this.#transactionDepth--
    }
  }

  /**
   * Read a `meta` integer, seeding it when the board has never held one.
   * @param key - the meta key.
   * @param seed - the value to store when the key is absent.
   * @returns the current value.
   */
  #meta(key: string, seed: number): number {
    const row = one<{ value: string }>(this.#prepare('SELECT value FROM meta WHERE key = ?'), key)
    if (row === undefined) {
      this.#prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(key, String(seed))
      return seed
    }
    const value = Number.parseInt(row.value, 10)
    return Number.isSafeInteger(value) ? value : seed
  }

  /**
   * Store a `meta` integer.
   * @param key - the meta key.
   * @param value - the value to store.
   */
  #setMeta(key: string, value: number): void {
    this.#prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value))
  }

  /**
   * The board's change counter.
   *
   * The browser polls this rather than the board itself, so an idle board costs one integer read
   * per poll instead of every card. It is advanced by triggers in the database (see `./db.ts`), not
   * by this class, so a change made with `sqlite3` or by another process moves it too.
   * @returns the current revision.
   */
  revision(): number {
    const row = one<{ value: string }>(this.#prepare("SELECT value FROM meta WHERE key = 'revision'"))
    const value = row === undefined ? 0 : Number.parseInt(row.value, 10)
    return Number.isSafeInteger(value) ? value : 0
  }

  /**
   * Take the next display number and reserve it.
   *
   * Reserved rather than derived from `MAX(ref)`, so deleting the newest card does not hand its
   * number to the next one — a `#12` written in a commit message keeps meaning one card forever.
   * @returns the number for the card being created.
   */
  #nextRef(): number {
    const next = this.#meta('next_ref', 1)
    this.#setMeta('next_ref', next + 1)
    return next
  }

  /**
   * Append one history entry.
   * @param taskId - the card the entry belongs to.
   * @param kind - what changed.
   * @param author - who changed it and from where.
   * @param at - epoch ms of the change.
   * @param from - the previous value as display text.
   * @param to - the new value as display text.
   */
  #log(
    taskId: string,
    kind: TaskActivityKind,
    author: TaskAuthor,
    at: number,
    from?: string | undefined,
    to?: string | undefined,
  ): void {
    this.#prepare(
      'INSERT INTO activity (task_id, kind, actor, at, from_value, to_value, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(taskId, kind, author.actor, at, from ?? null, to ?? null, author.sessionId ?? null)
  }

  /**
   * Look one card up, or fail.
   * @param taskId - the card to read.
   * @returns its row.
   * @throws TaskNotFoundError when the board has no such card.
   */
  #requireRow(taskId: string): TaskRow {
    const row = one<TaskRow>(this.#prepare('SELECT * FROM tasks WHERE id = ?'), taskId)
    if (row === undefined) throw new TaskNotFoundError('task', taskId)
    return row
  }

  /**
   * Look one comment up, or fail.
   * @param commentId - the comment to read.
   * @returns its row.
   * @throws TaskNotFoundError when the board has no such comment.
   */
  #requireComment(commentId: string): CommentRow {
    const row = one<CommentRow>(this.#prepare('SELECT * FROM comments WHERE id = ?'), commentId)
    if (row === undefined) throw new TaskNotFoundError('comment', commentId)
    return row
  }

  /**
   * The rank of a placement's neighbour, provided it is still in the destination column.
   *
   * A neighbour another writer has since moved to a different column, archived, or deleted is not a
   * neighbour any more: its rank belongs to another column's order, and landing next to it would
   * put the card at an arbitrary spot in this one.
   * @param taskId - the neighbour card.
   * @param status - the destination column.
   * @param excludeId - the card being placed, which cannot be its own neighbour.
   * @returns its rank, or `null` when it is no longer an active card in that column.
   */
  #neighbourRank(taskId: string | undefined, status: TaskStatus, excludeId: string | undefined): string | null {
    if (taskId === undefined || taskId === excludeId) return null
    const row = one<{ rank: string }>(
      this.#prepare('SELECT rank FROM tasks WHERE id = ? AND status = ? AND archived = 0'),
      taskId,
      status,
    )
    return row?.rank ?? null
  }

  /**
   * The nearest rank in a column strictly above or below a key.
   * @param status - the column.
   * @param rank - the key to look from.
   * @param direction - `next` for the smallest rank above it, `previous` for the largest below it.
   * @param excludeId - a card to ignore, for a move within the column.
   * @returns the neighbouring rank, or `null` at that end of the column.
   */
  #adjacentRank(status: TaskStatus, rank: string, direction: 'next' | 'previous', excludeId: string | undefined): string | null {
    const sql = direction === 'next'
      ? 'SELECT MIN(rank) AS rank FROM tasks WHERE status = ? AND archived = 0 AND id IS NOT ? AND rank > ?'
      : 'SELECT MAX(rank) AS rank FROM tasks WHERE status = ? AND archived = 0 AND id IS NOT ? AND rank < ?'
    const row = one<{ rank: string | null }>(this.#prepare(sql), status, excludeId ?? null, rank)
    return row?.rank ?? null
  }

  /**
   * Mint the rank for a card landing in one column.
   *
   * A placement names its neighbours rather than an index, so a stale neighbour — a card another
   * writer moved out of the column between the drag and the drop — degrades to an end of the
   * column rather than throwing the user's drop away.
   * @param status - the destination column.
   * @param place - the requested position, or `undefined` for the configured default end.
   * @param excludeId - a card to ignore when reading the column's ends, for a move within it.
   * @returns the new rank.
   */
  #rankFor(status: TaskStatus, place: TaskPlacement | undefined, excludeId?: string): string {
    const after = this.#neighbourRank(place?.after, status, excludeId)
    const before = this.#neighbourRank(place?.before, status, excludeId)
    if (after !== null && (before === null || after >= before)) {
      // Land directly below `after`. The upper bound is whatever really follows it in the column
      // now — a missing or out-of-order `before` would otherwise leave the top open, and a key
      // minted against an open top can sort past every card that follows.
      return rankBetween(after, this.#adjacentRank(status, after, 'next', excludeId))
    }
    if (before !== null) {
      return rankBetween(this.#adjacentRank(status, before, 'previous', excludeId), before)
    }
    const bounds = this.#columnBounds(status, excludeId)
    if (bounds === undefined) return firstRank()
    return this.#options.newTaskPlacement === 'top'
      ? rankBetween(null, bounds.first)
      : rankBetween(bounds.last, null)
  }

  /**
   * The lowest and highest rank currently in one column.
   * @param status - the column.
   * @param excludeId - a card to ignore, so a move within the column does not measure against itself.
   * @returns the bounds, or `undefined` when the column is empty.
   */
  #columnBounds(status: TaskStatus, excludeId?: string): { first: string; last: string } | undefined {
    const row = one<{ first: string | null; last: string | null }>(
      this.#prepare('SELECT MIN(rank) AS first, MAX(rank) AS last FROM tasks WHERE status = ? AND archived = 0 AND id IS NOT ?'),
      status,
      excludeId ?? null,
    )
    if (row?.first == null || row.last == null) return undefined
    return { first: row.first, last: row.last }
  }

  /**
   * Per-column counts of active cards, plus the archived total.
   * @returns the counts every column header renders.
   */
  counts(): { counts: TaskCounts; archivedCount: number } {
    const counts = Object.fromEntries(TASK_STATUSES.map(status => [status, 0])) as TaskCounts
    const rows = many<{ status: string; n: number }>(
      this.#prepare('SELECT status, COUNT(*) AS n FROM tasks WHERE archived = 0 GROUP BY status'),
    )
    for (const row of rows) {
      const status = TASK_STATUSES.find(candidate => candidate === row.status)
      if (status !== undefined) counts[status] = row.n
    }
    // An aggregate without GROUP BY always yields exactly one row; the fallback satisfies the
    // reader's type rather than describing a state SQLite can produce.
    const archived = one<{ n: number }>(this.#prepare('SELECT COUNT(*) AS n FROM tasks WHERE archived = 1'))
    return { counts, archivedCount: archived?.n ?? 0 }
  }

  /**
   * Read the board.
   * @param query - the filters to apply; every field is optional.
   * @returns the matching cards plus the whole board's counts.
   */
  read(query: TaskQuery = {}): BoardView {
    const where: string[] = []
    const params: (string | number)[] = []

    const archived = query.archived ?? 'active'
    if (archived === 'active') where.push('archived = 0')
    else if (archived === 'archived') where.push('archived = 1')

    if (query.status !== undefined && query.status.length > 0) {
      const statuses = query.status.map(value => parseStatus(value))
      where.push(`status IN (${statuses.map(() => '?').join(', ')})`)
      params.push(...statuses)
    }
    if (query.priority !== undefined && query.priority.length > 0) {
      const priorities = query.priority.map(value => parsePriority(value))
      where.push(`priority IN (${priorities.map(() => '?').join(', ')})`)
      params.push(...priorities)
    }
    if (query.assignee !== undefined) {
      const assignee = parseAssignee(query.assignee)
      if (assignee !== undefined) {
        where.push('assignee = ? COLLATE NOCASE')
        params.push(assignee)
      }
    }
    if (query.search !== undefined && query.search.trim() !== '') {
      where.push('(title LIKE ? ESCAPE \'\\\' COLLATE NOCASE OR body LIKE ? ESCAPE \'\\\' COLLATE NOCASE)')
      const pattern = `%${escapeLike(query.search.trim())}%`
      params.push(pattern, pattern)
    }
    // Labels are matched in SQL by substring against the canonical JSON, then confirmed exactly in
    // JS. The SQL pass is an index-free prefilter that keeps the row set small; the JS pass is what
    // actually decides, so a label that is a prefix of another cannot leak through.
    const wanted = query.labels === undefined ? [] : parseLabels(query.labels)
    for (const label of wanted) {
      where.push('labels LIKE ? ESCAPE \'\\\'')
      params.push(`%${escapeLike(JSON.stringify(label))}%`)
    }

    const limit = parseLimit(query.limit)
    const clause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`
    const rows = many<TaskRow>(
      // Workflow order, not `ORDER BY status`: alphabetically `done` sorts before `in_progress` and
      // `todo`, and the LIMIT would then cut outstanding work to make room for finished work.
      this.#prepare(`SELECT * FROM tasks${clause} ORDER BY ${STATUS_ORDER}, rank, created_at LIMIT ?`),
      ...params,
      limit,
    )

    const tasks = rows
      .map(toTask)
      .filter(task => wanted.every(label => task.labels.includes(label)))

    return { tasks, ...this.counts(), databasePath: this.databasePath }
  }

  /**
   * Read one card with its comments and history.
   * @param taskId - the card to open.
   * @returns the card, its comments oldest-first, and its history oldest-first.
   * @throws TaskNotFoundError when the board has no such card.
   */
  detail(taskId: string): TaskDetail {
    const task = toTask(this.#requireRow(taskId))
    const comments = many<CommentRow>(
      this.#prepare('SELECT * FROM comments WHERE task_id = ? ORDER BY created_at, id'),
      taskId,
    ).map(toComment)
    const activity = many<ActivityRow>(
      this.#prepare('SELECT * FROM activity WHERE task_id = ? ORDER BY seq'),
      taskId,
    ).map(toActivity)
    return { task, comments, activity }
  }

  /**
   * Add a card.
   * @param input - the card's initial fields, unvalidated.
   * @param author - who is adding it and from where.
   * @param now - epoch ms to stamp; injected so tests are deterministic.
   * @returns the created card.
   */
  create(input: TaskCreate, author: TaskAuthor, now: number): Task {
    const [created] = this.createMany([input], author, now)
    if (created === undefined) throw new Error('tasks: creating one card produced none')
    return created
  }

  /**
   * Add several cards as one unit, in the order given.
   *
   * One transaction: every input is validated before anything is written, and a failure part-way
   * through leaves none of the batch behind — a model retrying a half-applied `task_add` would
   * otherwise duplicate the half that landed.
   *
   * Order is preserved whatever the placement setting. Creating a batch one card at a time with
   * `top` placement put each above the last, so a list given as A, B, C appeared as C, B, A. Instead
   * each column's new cards take one ascending run of keys at the configured end.
   * @param inputs - the cards' initial fields, unvalidated.
   * @param author - who is adding them and from where.
   * @param now - epoch ms to stamp.
   * @returns the created cards, in input order.
   */
  createMany(inputs: readonly TaskCreate[], author: TaskAuthor, now: number): Task[] {
    const parsed: readonly ParsedCreate[] = inputs.map(input => this.#parseCreate(input))
    return this.#transaction(() => {
      const ranks = this.#batchRanks(parsed)
      return parsed.map((card, index) => this.#insert(card, ranks[index] ?? this.#rankFor(card.status, card.place), author, now))
    })
  }

  /**
   * Validate one card's creation fields.
   * @param input - the unvalidated fields.
   * @returns the canonical values.
   */
  #parseCreate(input: TaskCreate): ParsedCreate {
    return {
      title: parseTitle(input.title),
      body: input.body === undefined ? '' : parseBody(input.body),
      status: input.status === undefined ? this.#options.defaultStatus : parseStatus(input.status),
      priority: input.priority === undefined ? 'normal' : parsePriority(input.priority),
      labels: input.labels === undefined ? [] : parseLabels(input.labels),
      assignee: input.assignee === undefined ? undefined : parseAssignee(input.assignee),
      dueAt: input.dueAt === undefined ? undefined : parseTimestamp(input.dueAt, 'dueAt'),
      place: input.place,
    }
  }

  /**
   * Mint the keys for a batch's cards that name no position of their own.
   *
   * Cards are grouped by column, and each group takes an ascending run at the configured end — above
   * the column's current first card for `top`, below its last for `bottom` — so they read in input
   * order. A card that names a placement is left out and placed individually.
   * @param cards - the batch, validated.
   * @returns keys by batch index; indices with an explicit placement are absent.
   */
  #batchRanks(cards: readonly ParsedCreate[]): readonly (string | undefined)[] {
    const byColumn = new Map<TaskStatus, number[]>()
    cards.forEach((card, index) => {
      if (card.place !== undefined) return
      const indices = byColumn.get(card.status) ?? []
      indices.push(index)
      byColumn.set(card.status, indices)
    })
    const ranks: (string | undefined)[] = cards.map(() => undefined)
    for (const [status, indices] of byColumn) {
      const bounds = this.#columnBounds(status)
      const keys = this.#options.newTaskPlacement === 'top'
        ? rankSequence(null, bounds?.first ?? null, indices.length)
        : rankSequence(bounds?.last ?? null, null, indices.length)
      indices.forEach((index, position) => { ranks[index] = keys[position] })
    }
    return ranks
  }

  /**
   * Insert one validated card with its first history entry. Runs inside the caller's transaction.
   * @param card - the validated fields.
   * @param rank - its position key.
   * @param author - who is adding it.
   * @param now - epoch ms to stamp.
   * @returns the stored card.
   */
  #insert(card: ParsedCreate, rank: string, author: TaskAuthor, now: number): Task {
    const id = mintId('t')
    this.#prepare(`
      INSERT INTO tasks (
        id, ref, title, body, status, priority, labels, assignee, rank, archived,
        created_at, updated_at, completed_at, archived_at, due_at, created_by, session_id,
        running_job_id, last_run, run_owner
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL)
    `).run(
      id,
      this.#nextRef(),
      card.title,
      card.body,
      card.status,
      card.priority,
      JSON.stringify(card.labels),
      card.assignee ?? null,
      rank,
      now,
      now,
      TERMINAL.has(card.status) ? now : null,
      card.dueAt ?? null,
      author.actor,
      author.sessionId ?? null,
    )
    this.#log(id, 'created', author, now, undefined, card.title)
    return toTask(this.#requireRow(id))
  }

  /**
   * Change a card.
   *
   * Only fields that actually differ are written and logged, so re-saving an unchanged detail panel
   * leaves no history and does not bump the revision.
   * @param taskId - the card to change.
   * @param patch - the fields to change; absent keys are left alone, `null` clears a clearable one.
   * @param author - who is changing it and from where.
   * @param now - epoch ms to stamp.
   * @param expectedUpdatedAt - the card's `updatedAt` as the caller last read it. When given, the
   *   change applies only if nobody has changed the card since; omitted, the change applies
   *   unconditionally (the model's tools, which read and write in one call).
   * @returns the card as it now stands.
   * @throws TaskNotFoundError when the board has no such card.
   * @throws TaskConflictError when `expectedUpdatedAt` is stale.
   */
  update(taskId: string, patch: TaskPatch, author: TaskAuthor, now: number, expectedUpdatedAt?: number): Task {
    return this.#transaction(() => {
      const row = this.#requireRow(taskId)
      // Checked inside the write transaction, so no other writer can slip in between the check and
      // the write. `updated_at` is the token because every change to a card stamps it; the whole
      // board's revision would conflict on edits to unrelated cards.
      if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== row.updated_at) {
        throw new TaskConflictError(row.ref)
      }
      const sets: string[] = []
      const params: (string | number | null)[] = []
      let changed = false

      const write = (
        column: string,
        value: string | number | null,
        kind: TaskActivityKind,
        from: string | undefined,
        to: string | undefined,
      ): void => {
        sets.push(`${column} = ?`)
        params.push(value)
        this.#log(taskId, kind, author, now, from, to)
        changed = true
      }

      if (patch.title !== undefined) {
        const title = parseTitle(patch.title)
        if (title !== row.title) write('title', title, 'title', row.title, title)
      }
      if (patch.body !== undefined) {
        const body = patch.body === null ? '' : parseBody(patch.body)
        if (body !== row.body) write('body', body, 'body', undefined, undefined)
      }
      if (patch.priority !== undefined) {
        const priority = parsePriority(patch.priority)
        if (priority !== row.priority) write('priority', priority, 'priority', row.priority, priority)
      }
      if (patch.labels !== undefined) {
        const labels = patch.labels === null ? [] : parseLabels(patch.labels)
        const encoded = JSON.stringify(labels)
        if (encoded !== row.labels) {
          write('labels', encoded, 'labels', decodeLabels(row.labels).join(', '), labels.join(', '))
        }
      }
      if (patch.assignee !== undefined) {
        const assignee = patch.assignee === null ? undefined : parseAssignee(patch.assignee)
        if ((assignee ?? null) !== row.assignee) {
          write('assignee', assignee ?? null, 'assignee', row.assignee ?? undefined, assignee)
        }
      }
      if (patch.dueAt !== undefined) {
        const dueAt = patch.dueAt === null ? null : parseTimestamp(patch.dueAt, 'dueAt')
        if (dueAt !== row.due_at) {
          write('due_at', dueAt, 'due', formatDue(row.due_at), formatDue(dueAt))
        }
      }

      // Status last: it decides the completion stamp, and a status move without an explicit
      // placement still needs a rank in the destination column.
      const status = patch.status === undefined ? undefined : parseStatus(patch.status)
      const movingColumn = status !== undefined && status !== row.status
      if (movingColumn) {
        write('status', status, 'status', row.status, status)
        sets.push('completed_at = ?')
        params.push(TERMINAL.has(status) ? now : null)
      }
      if (movingColumn || patch.place !== undefined) {
        const column = status ?? (row.status as TaskStatus)
        sets.push('rank = ?')
        params.push(this.#rankFor(column, patch.place, taskId))
        changed = true
      }

      if (!changed) return toTask(row)
      sets.push('updated_at = ?')
      params.push(now)
      this.#prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params, taskId)
      return toTask(this.#requireRow(taskId))
    })
  }

  /**
   * Archive or restore a card.
   *
   * Archiving keeps every comment and every history entry; the card simply leaves the board. That
   * is the whole point of having it rather than delete.
   * @param taskId - the card.
   * @param archived - true to archive, false to restore.
   * @param author - who is doing it and from where.
   * @param now - epoch ms to stamp.
   * @returns the card as it now stands.
   * @throws TaskNotFoundError when the board has no such card.
   */
  setArchived(taskId: string, archived: boolean, author: TaskAuthor, now: number): Task {
    return this.#transaction(() => {
      const row = this.#requireRow(taskId)
      if ((row.archived === 1) === archived) return toTask(row)
      // A restored card returns to the top of its column: it left the board at an order nobody has
      // looked at since, and the person restoring it is asking to see it again.
      const rank = archived ? row.rank : this.#rankFor(row.status as TaskStatus, undefined, taskId)
      this.#prepare('UPDATE tasks SET archived = ?, archived_at = ?, rank = ?, updated_at = ? WHERE id = ?')
        .run(archived ? 1 : 0, archived ? now : null, rank, now, taskId)
      this.#log(taskId, archived ? 'archived' : 'restored', author, now)
      return toTask(this.#requireRow(taskId))
    })
  }

  /**
   * Delete a card, its comments, and its history.
   * @param taskId - the card to delete.
   * @throws TaskNotFoundError when the board has no such card.
   */
  remove(taskId: string): void {
    this.#transaction(() => {
      this.#requireRow(taskId)
      // Comments and activity carry ON DELETE CASCADE, and `PRAGMA foreign_keys = ON` is applied at
      // open, so this one statement takes the whole card with it.
      this.#prepare('DELETE FROM tasks WHERE id = ?').run(taskId)
    })
  }

  /**
   * Write a comment on a card.
   * @param taskId - the card.
   * @param body - the Markdown comment, unvalidated.
   * @param author - who is writing it and from where.
   * @param now - epoch ms to stamp.
   * @returns the stored comment.
   * @throws TaskNotFoundError when the board has no such card.
   */
  addComment(taskId: string, body: string, author: TaskAuthor, now: number): TaskComment {
    const text = parseComment(body)
    return this.#transaction(() => {
      this.#requireRow(taskId)
      const id = mintId('c')
      this.#prepare(
        'INSERT INTO comments (id, task_id, body, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, taskId, text, author.actor, now, now)
      this.#log(taskId, 'comment', author, now, undefined, text.split('\n')[0])
      this.#prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, taskId)
      return toComment(this.#requireComment(id))
    })
  }

  /**
   * Rewrite a comment.
   * @param commentId - the comment to rewrite.
   * @param body - its new Markdown body, unvalidated.
   * @param now - epoch ms to stamp.
   * @returns the comment as it now stands.
   * @throws TaskNotFoundError when the board has no such comment.
   */
  editComment(commentId: string, body: string, now: number): TaskComment {
    const text = parseComment(body)
    return this.#transaction(() => {
      const row = one<CommentRow>(this.#prepare('SELECT * FROM comments WHERE id = ?'), commentId)
      if (row === undefined) throw new TaskNotFoundError('comment', commentId)
      if (row.body === text) return toComment(row)
      this.#prepare('UPDATE comments SET body = ?, updated_at = ? WHERE id = ?').run(text, now, commentId)
      this.#prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, row.task_id)
      return toComment(this.#requireComment(commentId))
    })
  }

  /**
   * Delete a comment.
   * @param commentId - the comment to delete.
   * @param now - epoch ms to stamp on the owning card.
   * @throws TaskNotFoundError when the board has no such comment.
   */
  removeComment(commentId: string, now: number): void {
    this.#transaction(() => {
      const row = one<{ task_id: string }>(this.#prepare('SELECT task_id FROM comments WHERE id = ?'), commentId)
      if (row === undefined) throw new TaskNotFoundError('comment', commentId)
      this.#prepare('DELETE FROM comments WHERE id = ?').run(commentId)
      this.#prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, row.task_id)
    })
  }

  /**
   * Mark a card as being worked by a background job.
   *
   * The claim is conditional on the card not already carrying a run, inside the write transaction,
   * so two processes dispatching the same card at once cannot both succeed: the loser learns at once
   * and can stop the job it just started.
   * @param taskId - the card.
   * @param jobId - the job registry's id for the run.
   * @param owner - the process and session that own the run.
   * @param author - who dispatched it and from where.
   * @param now - epoch ms to stamp.
   * @returns the card carrying its running job.
   * @throws TaskNotFoundError when the board has no such card.
   * @throws TaskValidationError when another run already holds the card.
   */
  startRun(taskId: string, jobId: string, owner: RunOwner, author: TaskAuthor, now: number): Task {
    return this.#transaction(() => {
      const row = this.#requireRow(taskId)
      if (row.running_job_id !== null) {
        throw new TaskValidationError(`#${row.ref} is already running as job ${row.running_job_id}`)
      }
      this.#prepare('UPDATE tasks SET running_job_id = ?, run_owner = ?, updated_at = ? WHERE id = ?')
        .run(jobId, JSON.stringify(owner), now, taskId)
      this.#log(taskId, 'run-started', author, now, undefined, jobId)
      return toTask(this.#requireRow(taskId))
    })
  }

  /**
   * Record how a dispatched run ended.
   *
   * The card's running state is cleared only when the marker still names THIS run: the same job id
   * AND the same owner process. Job ids are counters local to one process (`task-1` exists in every
   * dsh process that has dispatched anything), so the id alone would let one process's settlement
   * clear a marker another process holds for its own, unrelated run.
   *
   * A settlement whose marker is gone or replaced still tells the truth in the history, and fills
   * `last_run` when nothing newer holds the card — the real outcome is better than the "interrupted"
   * a sweep recorded while the run was out of reach.
   *
   * Tolerates a card that vanished while its job ran — deleting a card mid-run is a thing a person
   * may reasonably do, and the job's settlement must not then throw inside the registry's listener.
   * @param taskId - the card.
   * @param summary - the run's outcome.
   * @param owner - the process that started the run.
   * @param author - who to attribute the transition to; normally `system`.
   * @param now - epoch ms to stamp.
   * @param effects - the report to leave and the column to move to, applied in the same transaction.
   * @returns the card and whether the run was still current, or `undefined` when the card is gone.
   */
  finishRun(
    taskId: string,
    summary: TaskRunSummary,
    owner: RunOwner,
    author: TaskAuthor,
    now: number,
    effects: RunSettlementEffects = {},
  ): FinishedRun | undefined {
    return this.#transaction(() => {
      const row = one<TaskRow>(this.#prepare('SELECT * FROM tasks WHERE id = ?'), taskId)
      if (row === undefined) return undefined
      const current = row.running_job_id === summary.jobId
        && decodeRunOwner(row.run_owner)?.instance === owner.instance
      if (current) {
        this.#prepare('UPDATE tasks SET running_job_id = NULL, run_owner = NULL, last_run = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(summary), now, taskId)
      } else if (row.running_job_id === null) {
        this.#prepare('UPDATE tasks SET last_run = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(summary), now, taskId)
      }
      this.#log(taskId, 'run-finished', author, now, summary.jobId, summary.status)
      // The report is the run's work product, so it is kept even when a newer run holds the card; the
      // automatic column move is not, because the card's state now belongs to that newer run.
      if (effects.report !== undefined) this.addComment(taskId, effects.report, author, now)
      if (current && effects.completedStatus !== undefined) {
        this.update(taskId, { status: effects.completedStatus }, author, now)
      }
      return { task: toTask(this.#requireRow(taskId)), current }
    })
  }

  /**
   * Every running marker on the board.
   * @returns the markers, at most {@link MAX_QUERY_LIMIT} of them.
   */
  runMarkers(): RunMarker[] {
    return this.#markerRows().flatMap((row) => {
      const marker = toMarker(row)
      return marker === undefined ? [] : [marker]
    })
  }

  /**
   * The rows carrying a running marker.
   * @returns the rows, bounded.
   */
  #markerRows(): MarkerRow[] {
    return many<MarkerRow>(
      this.#prepare(`SELECT ${MARKER_COLUMNS} FROM tasks t WHERE t.running_job_id IS NOT NULL ORDER BY t.id LIMIT ?`),
      MAX_QUERY_LIMIT,
    )
  }

  /**
   * One card's row, read with its marker's history entry.
   * @param taskId - the card.
   * @returns the row.
   * @throws TaskNotFoundError when the board has no such card.
   */
  #requireMarkerRow(taskId: string): MarkerRow {
    const row = one<MarkerRow>(this.#prepare(`SELECT ${MARKER_COLUMNS} FROM tasks t WHERE t.id = ?`), taskId)
    if (row === undefined) throw new TaskNotFoundError('task', taskId)
    return row
  }

  /**
   * One card's running marker.
   * @param taskId - the card.
   * @returns the marker, or `undefined` when the card is idle.
   * @throws TaskNotFoundError when the board has no such card.
   */
  runMarker(taskId: string): RunMarker | undefined {
    return toMarker(this.#requireMarkerRow(taskId))
  }

  /**
   * Clear a running marker whose owner is not recorded, because a person has confirmed it.
   *
   * The only way such a marker is cleared without this process's job registry vouching for the run
   * (see {@link judgeRunByProcess}). The request names the job id the person was shown, and the clear
   * is conditional on it inside the write transaction, so a confirmation given for one run can never
   * clear another that took the card in the meantime. A marker whose owner IS recorded is refused:
   * that run can be judged and stopped, and forgetting it would strand a live subagent.
   * @param taskId - the card.
   * @param jobId - the job id of the marker the person confirmed clearing.
   * @param author - who confirmed it.
   * @param now - epoch ms to stamp.
   * @returns the card as it now stands; unchanged when the marker had already been cleared.
   * @throws TaskNotFoundError when the board has no such card.
   * @throws TaskValidationError when the card is held by a different run, or by one with a known owner.
   */
  clearUnknownRun(taskId: string, jobId: string, author: TaskAuthor, now: number): Task {
    return this.#transaction(() => {
      const row = this.#requireRow(taskId)
      // Already settled or cleared by someone else: what the person asked for is true.
      if (row.running_job_id === null) return toTask(row)
      if (row.running_job_id !== jobId) {
        throw new TaskValidationError(
          `#${row.ref} is now running as job ${row.running_job_id}, not ${jobId}; nothing was cleared. Reload the board and decide again.`,
        )
      }
      if (decodeRunOwner(row.run_owner) !== undefined) {
        throw new TaskValidationError(
          `#${row.ref}'s run records which dsh process owns it; stop the run instead of clearing its marker.`,
        )
      }
      this.#prepare('UPDATE tasks SET running_job_id = NULL, run_owner = NULL, updated_at = ? WHERE id = ?').run(now, taskId)
      this.#log(taskId, 'run-finished', author, now, jobId, 'interrupted')
      return toTask(this.#requireRow(taskId))
    })
  }

  /**
   * Settle every running marker its judge says is no longer live.
   *
   * Jobs live in memory only, so a card left running by a process that exited mid-run shows a job
   * that can never settle — and Dispatch refuses it as "already running" — until something clears
   * it. Which markers are stale is the judge's call, because only the service can ask the job
   * registry about runs this process owns; see {@link judgeRunByProcess} for the default.
   *
   * The markers are judged outside the write lock, and each write is conditional on the marker
   * being unchanged, so a run settled or re-dispatched while the sweep was judging is left alone.
   * @param judge - decides each marker's fate.
   * @param now - epoch ms to stamp on the cards it changes.
   * @returns how many markers were cleared.
   */
  reconcileRuns(judge: RunJudge, now: number): number {
    const decisions = this.#markerRows().flatMap((row) => {
      const marker = toMarker(row)
      if (marker === undefined) return []
      const verdict = judge(marker)
      return verdict.kind === 'live' ? [] : [{ row, verdict }]
    })
    if (decisions.length === 0) return 0
    return this.#transaction(() => {
      let cleared = 0
      for (const { row, verdict } of decisions) {
        if (this.#settleStale(row, verdict, now)) cleared++
      }
      return cleared
    })
  }

  /**
   * Settle one card's running marker if its judge says it is no longer live.
   * @param taskId - the card.
   * @param judge - decides the marker's fate.
   * @param now - epoch ms to stamp.
   * @returns the card as it now stands.
   * @throws TaskNotFoundError when the board has no such card.
   */
  reconcileRun(taskId: string, judge: RunJudge, now: number): Task {
    const row = this.#requireMarkerRow(taskId)
    const marker = toMarker(row)
    if (marker === undefined) return toTask(row)
    const verdict = judge(marker)
    if (verdict.kind === 'live') return toTask(row)
    return this.#transaction(() => {
      this.#settleStale(row, verdict, now)
      return toTask(this.#requireRow(taskId))
    })
  }

  /**
   * Clear one stale marker, provided it is still the marker that was judged. Runs inside the
   * caller's transaction.
   * @param judged - the row as it was when judged.
   * @param verdict - the non-live verdict.
   * @param now - epoch ms to stamp.
   * @returns whether the marker was still in place and has been cleared.
   */
  #settleStale(judged: TaskRow, verdict: Exclude<RunVerdict, { kind: 'live' }>, now: number): boolean {
    const lastRun = verdict.kind === 'settled' ? JSON.stringify(verdict.summary) : judged.last_run
    const result = this.#prepare(`
      UPDATE tasks SET running_job_id = NULL, run_owner = NULL, last_run = ?, updated_at = ?
      WHERE id = ? AND running_job_id IS ? AND run_owner IS ?
    `).run(lastRun, now, judged.id, judged.running_job_id, judged.run_owner)
    if (result.changes === 0) return false
    const status = verdict.kind === 'settled' ? verdict.summary.status : 'interrupted'
    this.#log(judged.id, 'run-finished', { actor: 'system' }, now, judged.running_job_id ?? undefined, status)
    return true
  }

  /**
   * How many comments each of a set of cards carries, in one query.
   * @param taskIds - the cards to count for; at most {@link MAX_QUERY_LIMIT} are counted.
   * @returns counts by card id; a card with no comments is absent.
   */
  commentCounts(taskIds: readonly string[]): ReadonlyMap<string, number> {
    if (taskIds.length === 0) return new Map()
    // One bound JSON array rather than one placeholder per id: a single fixed statement, however many
    // cards a list returned, and nothing a caller sends is spliced into the SQL.
    const rows = many<{ task_id: string; n: number }>(
      this.#prepare('SELECT task_id, COUNT(*) AS n FROM comments WHERE task_id IN (SELECT value FROM json_each(?)) GROUP BY task_id'),
      JSON.stringify(taskIds.slice(0, MAX_QUERY_LIMIT)),
    )
    return new Map(rows.map(row => [row.task_id, row.n]))
  }

  /**
   * The cards a model most wants to see: outstanding work, most urgent and least recently touched
   * first, capped.
   * @param limit - how many cards to return.
   * @returns the cards, already ordered for a prompt.
   */
  outstanding(limit: number): Task[] {
    const statement = this.#prepare(`
      SELECT * FROM tasks
      WHERE archived = 0 AND status <> 'done'
      ORDER BY
        CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        CASE status WHEN 'in_progress' THEN 0 WHEN 'blocked' THEN 1 WHEN 'todo' THEN 2 ELSE 3 END,
        updated_at DESC
      LIMIT ?
    `)
    return many<TaskRow>(statement, Math.min(Math.max(limit, 0), DEFAULT_QUERY_LIMIT)).map(toTask)
  }

  /**
   * Resolve a card by its display number.
   * @param ref - the `#N` number.
   * @returns the card, or `undefined` when no card carries that number.
   */
  byRef(ref: number): Task | undefined {
    const row = one<TaskRow>(this.#prepare('SELECT * FROM tasks WHERE ref = ?'), ref)
    return row === undefined ? undefined : toTask(row)
  }
}

/**
 * Escape the wildcards in a `LIKE` pattern so a user searching for `100%` does not match every row.
 * @param value - the raw search text.
 * @returns the text with `\`, `%`, and `_` escaped for the `ESCAPE '\'` clause.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, match => `\\${match}`)
}

/**
 * Render a due date for the history log.
 * @param value - epoch ms, or null.
 * @returns an ISO date, or `undefined` when there is no date.
 */
function formatDue(value: number | null): string | undefined {
  return value === null ? undefined : new Date(value).toISOString().slice(0, 10)
}

/**
 * One open board per database file, for the registry's lifetime.
 *
 * Boards are keyed by the canonical database path rather than opened per call: SQLite handles are
 * cheap to keep and expensive to churn, and two handles on one WAL database in one process would
 * contend with each other for no benefit.
 */
export class TaskStoreRegistry {
  readonly #stores = new Map<string, TaskStore>()
  readonly #options: TaskStoreOptions
  readonly #databasePath: string
  readonly #judge: RunJudge

  /**
   * @param databasePath - the configured database path; relative paths resolve per project root.
   * @param options - the deployment's board behaviour, shared by every board.
   * @param judge - decides which running markers are stale when a board is opened.
   */
  constructor(databasePath: string, options: TaskStoreOptions, judge: RunJudge = judgeRunByProcess) {
    this.#databasePath = databasePath
    this.#options = options
    this.#judge = judge
  }

  /**
   * The board for one project, opening it on first use.
   *
   * Every first open reconciles the board's running markers — including the reopen a settings
   * rebuild or a plugin reload performs. That used to be unsafe, because the sweep could not tell
   * this process's live runs from dead ones and so ran once per process; with owners on the markers
   * and a judge that asks the job registry, a reopen is exactly when a marker stranded by a lost
   * settlement should be found.
   * @param projectRoot - absolute path of the project.
   * @param now - epoch ms, used to stamp markers the sweep clears.
   * @returns the project's board.
   */
  open(projectRoot: string, now: number): TaskStore {
    const path = canonicalDatabasePath(resolveDatabasePath(projectRoot, this.#databasePath))
    let store = this.#stores.get(path)
    if (store === undefined) {
      store = new TaskStore(path, this.#options)
      store.reconcileRuns(this.#judge, now)
      this.#stores.set(path, store)
    }
    return store
  }

  /**
   * A board already open at one database path.
   * @param path - the absolute database path.
   * @returns the open board, or `undefined` when none is open at that path.
   */
  byPath(path: string): TaskStore | undefined {
    return this.#stores.get(path)
  }

  /**
   * Run some work against the board at a database path, whether or not this registry has it open.
   *
   * For settlement. A background run outlives the registry that was current when it started — a
   * settings save rebuilds the registry, a plugin reload replaces the whole service — and its outcome
   * must still reach its card. The open board is used when there is one; otherwise a handle is
   * opened for the work and closed straight after, so a closed registry never keeps a file open.
   * @param path - the canonical database path the run recorded.
   * @param work - what to do with the board.
   * @returns whatever `work` returned.
   */
  withBoardAt<T>(path: string, work: (board: TaskStore) => T): T {
    const open = this.#stores.get(path)
    if (open !== undefined) return work(open)
    const transient = new TaskStore(path, this.#options)
    try {
      return work(transient)
    } finally {
      transient.close()
    }
  }

  /** Close every open board. The registry still serves {@link withBoardAt} afterwards. */
  close(): void {
    for (const store of this.#stores.values()) store.close()
    this.#stores.clear()
  }
}

export { TaskValidationError }
