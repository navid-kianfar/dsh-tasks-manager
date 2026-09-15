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
import { firstRank, rankBetween } from '../domain/rank.ts'
import {
  DEFAULT_QUERY_LIMIT,
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
import { canonicalDatabasePath, openBoardDatabase, resolveDatabasePath, type JournalMode } from './db.ts'

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
}

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
    ...decodeRun(row.last_run) === undefined ? {} : { lastRun: decodeRun(row.last_run) as TaskRunSummary },
  }
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
   * @param work - the body; its return value becomes the call's.
   * @returns whatever `work` returned.
   */
  #transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
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
   * per poll instead of every card.
   * @returns the current revision.
   */
  revision(): number {
    return this.#meta('revision', 0)
  }

  /** Advance the revision. Called inside the transaction of every mutation. */
  #bump(): void {
    this.#setMeta('revision', this.revision() + 1)
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
   * The rank of a card, for resolving a placement's neighbours.
   * @param taskId - the neighbour card.
   * @returns its rank, or `null` when it is not on the board any more.
   */
  #rankOf(taskId: string | undefined): string | null {
    if (taskId === undefined) return null
    const row = one<{ rank: string }>(this.#prepare('SELECT rank FROM tasks WHERE id = ?'), taskId)
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
    const after = this.#rankOf(place?.after)
    const before = this.#rankOf(place?.before)
    if (after !== null || before !== null) {
      // Both named and still in order: land between them. Otherwise one end is known and the other
      // is the column's own edge, which `rankBetween` treats as open.
      if (after !== null && before !== null && after >= before) return rankBetween(after, null)
      return rankBetween(after, before)
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
      this.#prepare(`SELECT * FROM tasks${clause} ORDER BY status, rank, created_at LIMIT ?`),
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
    const title = parseTitle(input.title)
    const body = input.body === undefined ? '' : parseBody(input.body)
    const status = input.status === undefined ? this.#options.defaultStatus : parseStatus(input.status)
    const priority = input.priority === undefined ? 'normal' : parsePriority(input.priority)
    const labels = input.labels === undefined ? [] : parseLabels(input.labels)
    const assignee = input.assignee === undefined ? undefined : parseAssignee(input.assignee)
    const dueAt = input.dueAt === undefined ? undefined : parseTimestamp(input.dueAt, 'dueAt')

    return this.#transaction(() => {
      const id = mintId('t')
      const rank = this.#rankFor(status, input.place)
      this.#prepare(`
        INSERT INTO tasks (
          id, ref, title, body, status, priority, labels, assignee, rank, archived,
          created_at, updated_at, completed_at, archived_at, due_at, created_by, session_id,
          running_job_id, last_run
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL)
      `).run(
        id,
        this.#nextRef(),
        title,
        body,
        status,
        priority,
        JSON.stringify(labels),
        assignee ?? null,
        rank,
        now,
        now,
        TERMINAL.has(status) ? now : null,
        dueAt ?? null,
        author.actor,
        author.sessionId ?? null,
      )
      this.#log(id, 'created', author, now, undefined, title)
      this.#bump()
      return toTask(this.#requireRow(id))
    })
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
   * @returns the card as it now stands.
   * @throws TaskNotFoundError when the board has no such card.
   */
  update(taskId: string, patch: TaskPatch, author: TaskAuthor, now: number): Task {
    return this.#transaction(() => {
      const row = this.#requireRow(taskId)
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
      this.#bump()
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
      this.#bump()
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
      this.#bump()
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
      this.#bump()
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
      this.#bump()
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
      this.#bump()
    })
  }

  /**
   * Mark a card as being worked by a background job.
   * @param taskId - the card.
   * @param jobId - the job registry's id for the run.
   * @param author - who dispatched it and from where.
   * @param now - epoch ms to stamp.
   * @returns the card carrying its running job.
   * @throws TaskNotFoundError when the board has no such card.
   */
  startRun(taskId: string, jobId: string, author: TaskAuthor, now: number): Task {
    return this.#transaction(() => {
      this.#requireRow(taskId)
      this.#prepare('UPDATE tasks SET running_job_id = ?, updated_at = ? WHERE id = ?').run(jobId, now, taskId)
      this.#log(taskId, 'run-started', author, now, undefined, jobId)
      this.#bump()
      return toTask(this.#requireRow(taskId))
    })
  }

  /**
   * Record how a dispatched run ended and clear the card's running state.
   *
   * Tolerates a card that vanished while its job ran — deleting a card mid-run is a thing a person
   * may reasonably do, and the job's settlement must not then throw inside the registry's listener.
   * @param taskId - the card.
   * @param summary - the run's outcome.
   * @param author - who to attribute the transition to; normally `system`.
   * @param now - epoch ms to stamp.
   * @returns the card, or `undefined` when it is no longer on the board.
   */
  finishRun(taskId: string, summary: TaskRunSummary, author: TaskAuthor, now: number): Task | undefined {
    return this.#transaction(() => {
      const row = one<{ id: string }>(this.#prepare('SELECT id FROM tasks WHERE id = ?'), taskId)
      if (row === undefined) return undefined
      this.#prepare('UPDATE tasks SET running_job_id = NULL, last_run = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(summary), now, taskId)
      this.#log(taskId, 'run-finished', author, now, summary.jobId, summary.status)
      this.#bump()
      return toTask(this.#requireRow(taskId))
    })
  }

  /**
   * Clear every stale running marker.
   *
   * Jobs live in memory only, so a card left `running` by a process that exited mid-run would show
   * a job that can never settle. Called once when a board is opened.
   * @param now - epoch ms to stamp on the cards it clears.
   * @returns how many cards were cleared.
   */
  clearStaleRuns(now: number): number {
    return this.#transaction(() => {
      const rows = many<{ id: string }>(this.#prepare('SELECT id FROM tasks WHERE running_job_id IS NOT NULL'))
      if (rows.length === 0) return 0
      this.#prepare('UPDATE tasks SET running_job_id = NULL, updated_at = ? WHERE running_job_id IS NOT NULL').run(now)
      for (const row of rows) {
        this.#log(row.id, 'run-finished', { actor: 'system' }, now, undefined, 'interrupted')
      }
      this.#bump()
      return rows.length
    })
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
 * Boards whose stranded run markers this process has already swept.
 *
 * Process-wide, so a settings rebuild, a plugin reload, or a second copy of this module does not
 * sweep again. A second sweep would clear the markers of runs this very process started and is
 * still running, and the board would call live work "interrupted".
 */
const SWEPT_KEY = Symbol.for('@achasoft/dsh-tasks-manager/swept-boards')

/**
 * The sweep table.
 * @returns the set of canonical board paths already swept, created on first use.
 */
function sweptBoards(): Set<string> {
  const holder = globalThis as { [SWEPT_KEY]?: Set<string> }
  holder[SWEPT_KEY] ??= new Set()
  return holder[SWEPT_KEY]
}

/**
 * One open board per database file, for the process's lifetime.
 *
 * Boards are keyed by the canonical database path rather than opened per call: SQLite handles are
 * cheap to keep and expensive to churn, and two handles on one WAL database in one process would
 * contend with each other for no benefit.
 */
export class TaskStoreRegistry {
  readonly #stores = new Map<string, TaskStore>()
  readonly #options: TaskStoreOptions
  readonly #databasePath: string

  /**
   * @param databasePath - the configured database path; relative paths resolve per project root.
   * @param options - the deployment's board behaviour, shared by every board.
   */
  constructor(databasePath: string, options: TaskStoreOptions) {
    this.#databasePath = databasePath
    this.#options = options
  }

  /**
   * The board for one project, opening it on first use.
   * @param projectRoot - absolute path of the project.
   * @param now - epoch ms, used to clear runs stranded by a previous process.
   * @returns the project's board.
   */
  open(projectRoot: string, now: number): TaskStore {
    const path = canonicalDatabasePath(resolveDatabasePath(projectRoot, this.#databasePath))
    let store = this.#stores.get(path)
    if (store === undefined) {
      store = new TaskStore(path, this.#options)
      const swept = sweptBoards()
      if (path === ':memory:' || !swept.has(path)) {
        store.clearStaleRuns(now)
        swept.add(path)
      }
      this.#stores.set(path, store)
    }
    return store
  }

  /**
   * A board already open at one database path.
   *
   * Used by settlement paths that hold a path rather than a project root and must not open a board
   * that has since been closed — a background run outliving its board is ordinary at shutdown.
   * @param path - the absolute database path.
   * @returns the open board, or `undefined` when none is open at that path.
   */
  byPath(path: string): TaskStore | undefined {
    return this.#stores.get(path)
  }

  /** Close every open board. */
  close(): void {
    for (const store of this.#stores.values()) store.close()
    this.#stores.clear()
  }
}

export { TaskValidationError }
