/**
 * The task plugin's node half: one board per project, the RPC channel the browser drives it
 * through, the settings section that owns its preferences, and the background-job producer that
 * hands a card to the agent.
 *
 * `ctx.tasks` is the seam the model-facing tools (`../tools/index.ts`) reach; the browser reaches
 * exactly the same operations over `ctx.connection.rpc`, so the two callers cannot drift apart.
 *
 * Deliberately appends no session events. An out-of-tree plugin cannot: the persistence
 * coordinator refuses to reload a log carrying an event type absent from the harness's generated
 * `KNOWN_SESSION_EVENT_TYPES`, and `Session.append` has no way to mark one ignorable. Board state
 * therefore lives only in SQLite, and the browser learns about changes by polling the cheap
 * `board.revision` endpoint — which also covers the changes a session log never could: another
 * session's writes, and a person editing `.dsh/tasks.db` with `sqlite3`. The revision is advanced by
 * triggers in the database itself, which is what makes that last promise true.
 *
 * @module @achasoft/dsh-tasks-manager/host
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from './settings-section.ts'
import type { RpcError, RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-client-connection'
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type BoardView,
  type Task,
  type TaskComment,
  type TaskCreate,
  type TaskDetail,
  type TaskPatch,
  type TaskRunSummary,
  type TaskStatus,
} from '../domain/types.ts'
import { MAX_COMMENT_LENGTH, TaskValidationError, parseCommentIdText, parseTaskId } from '../domain/validate.ts'
import {
  TaskConflictError,
  TaskNotFoundError,
  TaskStoreRegistry,
  judgeRunByProcess,
  type RunMarker,
  type RunVerdict,
  type TaskAuthor,
  type TaskStore,
} from './store.ts'
import { currentRunOwner, ownerProcessState, type RunOwner } from './run-owner.ts'
import { DEFAULT_DATABASE_PATH, JOURNAL_MODES, TaskStoreError, type JournalMode } from './db.ts'
import { projectRootFor } from './project-root.ts'
import { mountChannel } from './channel.ts'
import { GitAuthorDirectory } from './git-authors.ts'
import {
  TASKS_RPC_CHANNEL,
  type BoardRevisionResult,
  type GitAuthorsResult,
  type JobKillResult,
  type JobReadResult,
  type JobView,
  type TaskDispatchResult,
  type TasksRpcEndpoint,
} from './protocol.ts'

export type * from './protocol.ts'
export type { GitAuthor, GitAuthorDirectoryResult } from './git-authors.ts'
export { GitAuthorDirectory } from './git-authors.ts'
export type { TaskAuthor, TaskStore } from './store.ts'
export { TaskConflictError, TaskNotFoundError } from './store.ts'

/** The settings namespace both halves address; the browser card joins the section on it. */
export const TASKS_SETTINGS_NAMESPACE = settingsNamespace('tasks')

declare module '@deepseek-ai/cordis' {
  interface Context {
    tasks: TasksService
  }
}

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    /** A project board card handed to the agent to work in the background. */
    task: 'task'
  }
}

/** Deployment configuration for the task board. */
export interface Config {
  /**
   * Where the board database lives. A relative path resolves against each project's own root, which
   * is what makes one installation serve a different board per project; an absolute path pins every
   * project to one shared board.
   */
  databasePath: string
  /**
   * Entry names that mark a project root, checked from the session's directory upwards. The first
   * match wins, and a session outside any of them gets a board rooted at its own directory.
   */
  projectRootMarkers: string[]
  /** Column a card lands in when its creator names none. */
  defaultStatus: TaskStatus
  /** Whether a new card goes to the top or the bottom of its column. */
  newTaskPlacement: 'top' | 'bottom'
  /** SQLite journal pragma; `wal` unless the project lives on a filesystem without it. */
  journalMode: JournalMode
  /** How long a write waits behind another writer, in milliseconds. */
  busyTimeoutMs: number
  /**
   * How often the open board re-checks the revision counter, in milliseconds. This is the latency
   * of a change made outside the current browser — by the agent, another session, or `sqlite3`.
   */
  pollIntervalMs: number
  /**
   * Which subagent provider a dispatched card runs on. Empty disables dispatch, which is the right
   * setting for a deployment that composes no subagent provider at all.
   */
  subagentProvider: string
  /** Column a card moves to when it is dispatched; `none` leaves it where it is. */
  dispatchStatus: TaskStatus | 'none'
  /** Column a dispatched card moves to when its run completes; `none` leaves it where it is. */
  dispatchCompletedStatus: TaskStatus | 'none'
  /** How many outstanding cards the model-facing board digest returns. */
  digestSize: number
}

/** Schemastery validation for the task board's deployment configuration. */
export const Config: z<Config> = z.object({
  databasePath: z.string().default(DEFAULT_DATABASE_PATH),
  projectRootMarkers: z.array(z.string()).default(['.git']),
  defaultStatus: z.union([...TASK_STATUSES]).default('backlog'),
  newTaskPlacement: z.union(['top', 'bottom'] as const).default('top'),
  journalMode: z.union([...JOURNAL_MODES]).default('wal'),
  busyTimeoutMs: z.number().step(1).min(0).default(5000),
  pollIntervalMs: z.number().step(1).min(250).default(2000),
  subagentProvider: z.string().default(''),
  dispatchStatus: z.union([...TASK_STATUSES, 'none'] as const).default('in_progress'),
  dispatchCompletedStatus: z.union([...TASK_STATUSES, 'none'] as const).default('none'),
  digestSize: z.number().step(1).min(1).max(200).default(25),
})

/**
 * Build the `bad-request` error branch for a value the caller got wrong.
 *
 * `issues` is validated as `z.custom<ZodIssue>()` with no refinement, so a synthesised issue is
 * accepted; carrying the message there as well as in `message` keeps a client that renders issues
 * from showing an empty list.
 * @param message - what was wrong, phrased for whoever sent the value.
 * @returns the error branch.
 */
function badRequest(message: string): { ok: false; error: RpcError } {
  return {
    ok: false,
    error: { code: 'bad-request', message, details: { issues: [{ code: 'custom', path: [], message }] } },
  } as { ok: false; error: RpcError }
}

/**
 * Map a thrown value onto the wire's closed error union.
 *
 * A caller's mistake and a broken installation must not look alike: the first is `bad-request` and
 * the board shows it inline, the second is `internal` and the board says the board is unavailable.
 * @param error - the thrown value.
 * @returns the error branch.
 */
function toRpcError(error: unknown): { ok: false; error: RpcError } {
  // A conflict is `bad-request` too: the board already re-reads itself on that code, which is exactly
  // the recovery a stale edit needs, and the message says the change was not applied.
  if (error instanceof TaskValidationError || error instanceof TaskNotFoundError || error instanceof TaskConflictError) {
    return badRequest(error.message)
  }
  if (error instanceof TaskStoreError) {
    return { ok: false, error: { code: 'internal', message: error.message, details: {} } }
  }
  return {
    ok: false,
    error: {
      code: 'internal',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  }
}

/**
 * One stored session as `@deepseek-ai/dsh-session-persistence` reports it (`SessionPersistenceSnapshot`
 * on 0.1.5-rc.2): the header is nested under `header`, not spread onto the snapshot.
 */
interface PersistedSessionSnapshot {
  /** The session's immutable header; the board reads only `id` and `cwd`. */
  readonly header: { readonly id: string; readonly cwd?: string | undefined }
}

/**
 * The persisted-session lookup this plugin borrows, declared structurally.
 *
 * `@deepseek-ai/dsh-session-persistence` is not a dependency of this package and should not become
 * one: the board needs exactly one field off one call, and a deployment composing no persistence
 * backend must still serve live sessions. `ctx.get` answers `undefined` there.
 *
 * `stat` is preferred: it reads one session's metadata, where `list` walks every session directory
 * on disk and reads each generation header. It is optional here only so a backend without it still
 * resolves sessions through `list`.
 */
interface PersistedSessions {
  /** One stored session's metadata, without reading its log; `undefined` when it does not exist. */
  stat?(id: string, options?: { signal?: AbortSignal }): Promise<PersistedSessionSnapshot | undefined>
  /** Every stored session's metadata. */
  list(options?: { signal?: AbortSignal }): Promise<readonly PersistedSessionSnapshot[]>
}

/**
 * How long a session persistence could not resolve is left alone before it is looked up again.
 *
 * The board polls every two seconds. Without a backoff, a tab open on a session that is neither live
 * nor on disk would hit persistence on every tick for as long as it stays open.
 */
const SESSION_MISS_BACKOFF_MS = 30_000

/** Most unresolved session ids remembered at once; the oldest is forgotten first. */
const MAX_REMEMBERED_MISSES = 512

/** Longest session id handed to persistence; anything longer names no session this harness mints. */
const MAX_SESSION_ID_LENGTH = 256

/**
 * How long one `jobs.wait` slice holds a dispatched run's completion notice.
 *
 * A wait needs a finite bound, so the hold re-arms in slices. Long enough that re-arming is rare,
 * and well below the 2^31-1 ms ceiling a Node timer accepts.
 */
const NOTICE_HOLD_SLICE_MS = 6 * 60 * 60 * 1000

/** Job statuses after which a job never changes again. */
const TERMINAL_JOB_STATUSES: ReadonlySet<string> = new Set(['completed', 'killed', 'failed'])

/** The reason recorded on a run stopped because its card was deleted. */
const DELETED_CARD_REASON = 'the card it was working was deleted from the task board'

/** The reason recorded on a run stopped from the board. */
const STOPPED_FROM_BOARD_REASON = 'stopped from the task board'

/** The reason recorded on an older build's run stopped because a person cleared its marker. */
const CLEARED_MARKER_REASON = 'its running marker was cleared from the task board'

/**
 * How far the job registry's start time for a run may be from the dispatch the board recorded, for
 * the registry's job to be taken as that run.
 *
 * A marker with no owner names only a job id and, through its history, the session that dispatched
 * it. Job ids are per-process counters and one session can be live in two processes, so a job of
 * that id and session in this registry may be a different run. The dispatch is recorded moments
 * before the registry stamps the job's start, so the two agree to within milliseconds for the same
 * run; a different run with the same id and session would have to have been started within this
 * window too. Wide enough for a slow event loop, narrow enough that a coincidence is not credible.
 */
const UNOWNED_RUN_START_TOLERANCE_MS = 10_000

/** The job registry as this plugin reaches it. */
type JobRegistryFace = Context['jobs']

/**
 * A live agent, typed as the job registry receives it.
 *
 * Every agent this plugin touches is handed to `ctx.jobs`, so its type is taken from there. The
 * development checkout this package links for types can lag the installed harness, and the two
 * copies of the agent type are then nominally distinct though the runtime object is one; deriving it
 * from the registry keeps that split to the one line that crosses to the subagent seam.
 */
type Agent = NonNullable<Parameters<JobRegistryFace['list']>[0]>

/** Raised when a request names a session this process cannot resolve a project for. */
class SessionUnavailableError extends Error {
  /**
   * @param sessionId - the session that did not resolve.
   * @param reason - why it did not.
   */
  constructor(readonly sessionId: string, reason: string) {
    super(reason)
    this.name = 'SessionUnavailableError'
  }
}

/**
 * Read a required string field off an untrusted RPC payload.
 * @param payload - the decoded request body.
 * @param field - the field to read.
 * @returns the field's value.
 * @throws TaskValidationError when the field is missing or not a string.
 */
function requireString(payload: unknown, field: string): string {
  if (typeof payload !== 'object' || payload === null) {
    throw new TaskValidationError('the request body must be an object')
  }
  const value = (payload as Record<string, unknown>)[field]
  if (typeof value !== 'string' || value === '') {
    throw new TaskValidationError(`the request is missing a ${field}`)
  }
  return value
}

/**
 * Read an optional object field off an untrusted RPC payload.
 * @param payload - the decoded request body.
 * @param field - the field to read.
 * @returns the field's value, or an empty object when it is absent.
 * @throws TaskValidationError when the field is present but not an object.
 */
function optionalObject(payload: unknown, field: string): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) return {}
  const value = (payload as Record<string, unknown>)[field]
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TaskValidationError(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

/**
 * Project one job registry snapshot onto the wire.
 * @param snapshot - the registry's snapshot.
 * @param taskId - the card this job is working, when this plugin started it.
 * @returns the view the Background panel renders.
 */
function toJobView(snapshot: JobSnapshot, taskId: string | undefined): JobView {
  return {
    id: snapshot.id,
    kind: snapshot.kind,
    label: snapshot.label,
    status: snapshot.status,
    ...snapshot.detail === undefined ? {} : { detail: snapshot.detail },
    startedAt: snapshot.startedAt,
    ...snapshot.finishedAt === undefined ? {} : { finishedAt: snapshot.finishedAt },
    ...taskId === undefined ? {} : { taskId },
  }
}

/** The task board's node half. */
export class TasksService extends Service {
  // No `static inject`: every service this plugin reads is optional, and cordis has no optional
  // form of `inject` — a name listed there is required, and the entry stays pending until it
  // appears. Optional services are reached through `ctx.get(name)` at call time (undefined when
  // absent), and the two that must be present together for the RPC channel go through their own
  // `ctx.inject([...])` in the constructor. Reading them at call time is also correct on its own
  // terms: a board is opened long after boot, not during it.

  /**
   * Members are TypeScript-`private`, not `#private`.
   *
   * Cordis hands every consumer a Proxy over the service, so `this` inside a method invoked as
   * `ctx.tasks.method()` is that Proxy — and a `#field` read then throws "Cannot read private
   * member from an object whose class did not declare it". `private` compiles to an ordinary
   * property, which the Proxy forwards. Every service in the harness is written this way.
   */
  private config: () => Config
  private registry: TaskStoreRegistry
  /** Which card each live job is working, so the Background panel can link a job back to its card. */
  private readonly jobTasks = new Map<string, { taskId: string; projectRoot: string }>()
  /**
   * Who has committed to each project, cached across sessions sharing one.
   *
   * Lives on the service rather than in the endpoint so the forked `git log` is shared: two browsers
   * open on the same project, or one opening card after card, cost one subprocess a minute.
   */
  private readonly gitAuthors = new GitAuthorDirectory()
  /**
   * Working directory per session id, including sessions no longer live.
   *
   * A session's `cwd` is fixed at creation, so an entry never goes stale. One `list()` fills the
   * map for every session on disk at once, which is what keeps the board's two-second poll from
   * re-reading persistence on every tick after a restart.
   */
  private readonly sessionCwd = new Map<string, string>()
  /** Session ids persistence could not resolve, with the epoch ms before which not to ask again. */
  private readonly sessionMisses = new Map<string, number>()
  /** Persistence lookups already running, so a burst of polls for one session shares one read. */
  private readonly sessionLookups = new Map<string, Promise<string | undefined>>()
  /** Aborts every held completion notice when the service goes away; see `holdCompletionNotice`. */
  private readonly noticeHolds = new AbortController()

  /**
   * @param ctx - host context.
   * @param config - the composition-layer board configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'tasks')
    this.config = () => config
    this.registry = this.buildRegistry(config)

    installSettingsSection(ctx, TASKS_SETTINGS_NAMESPACE, Config, config, {
      setSource: (current) => { this.config = current },
      onChange: () => { this.rebuild() },
    })

    // Mounted by this plugin rather than through `connection.rpc.handle`, which cannot mount a route
    // for a plugin on the shipped harness — see ./channel.ts. A headless deployment gets no channel;
    // the tools and the database still work there.
    mountChannel(ctx, TASKS_RPC_CHANNEL, (endpoint, payload, signal) => this.routeRpc(endpoint, payload, signal))

    ctx.effect(() => () => {
      this.noticeHolds.abort('the task service was disposed')
      this.registry.close()
    }, 'dsh-tasks: close boards')
  }

  /**
   * Build a store registry from one configuration snapshot.
   * @param config - the configuration to build from.
   * @returns the registry.
   */
  private buildRegistry(config: Config): TaskStoreRegistry {
    return new TaskStoreRegistry(
      config.databasePath,
      {
        newTaskPlacement: config.newTaskPlacement,
        defaultStatus: config.defaultStatus,
        journalMode: config.journalMode,
        busyTimeoutMs: config.busyTimeoutMs,
      },
      marker => this.judgeRun(marker),
    )
  }

  /**
   * Re-open every board against the current settings.
   *
   * Closing and rebuilding rather than mutating in place because `databasePath` and `journalMode`
   * are decided when a database is opened; a live handle cannot adopt a new value for either.
   *
   * A run dispatched before the rebuild still settles: settlement addresses its board by path through
   * `TaskStoreRegistry.withBoardAt`, which does not need the board to be open.
   */
  private rebuild(): void {
    this.registry.close()
    this.registry = this.buildRegistry(this.config())
  }

  /** The board's current deployment configuration, as the browser needs it to poll. */
  get settings(): Config {
    return this.config()
  }

  /**
   * The board belonging to a session's project.
   * @param sessionId - the session asking.
   * @returns its project's board.
   * @throws SessionUnavailableError when the session is not live, or names no directory.
   */
  boardFor(sessionId: string): TaskStore {
    // Both halves of this package share one compilation unit, so the `sessions` Context key
    // carries the browser runtime's face here; the running node process holds the Host store.
    const sessions = this.ctx.get('sessions') as unknown as SessionStore | undefined
    if (sessions === undefined) {
      throw new SessionUnavailableError(sessionId, 'no session store is composed in this deployment')
    }
    const session = sessions.get(sessionId as SessionId)
    if (session === undefined) {
      throw new SessionUnavailableError(sessionId, `session ${JSON.stringify(sessionId)} is not live`)
    }
    return this.boardForCwd(session.header.cwd, sessionId)
  }

  /**
   * The board belonging to a working directory's project.
   * @param cwd - the directory, absent for a session created without one.
   * @param sessionId - the session asking, for the error message.
   * @returns the project's board.
   * @throws SessionUnavailableError when there is no directory to root a board at.
   */
  boardForCwd(cwd: string | undefined, sessionId = ''): TaskStore {
    const root = projectRootFor(cwd, this.config().projectRootMarkers)
    if (root === undefined) {
      throw new SessionUnavailableError(
        sessionId,
        'this session names no working directory on this host, so it belongs to no project board',
      )
    }
    return this.registry.open(root, Date.now())
  }

  /**
   * The working directory a session belongs to, live or not.
   *
   * A board outlives the session that opened it, and so does the tab pointing at one. Restart the
   * harness with the Tasks view open on a finished run — a dispatched card's one-shot subagent, say
   * — and the live store has never heard of that session, though its log is on disk and every other
   * tab in the view is reading it. Resolving through persistence is what stops the board from being
   * the one surface that says the session does not exist.
   *
   * The live store is consulted first regardless: it is the only source that is certainly current.
   * @param sessionId - the session asking.
   * @returns its working directory, or `undefined` when nothing on this host knows one.
   */
  private async cwdForSession(sessionId: string): Promise<string | undefined> {
    // Both halves of this package share one compilation unit, so the `sessions` Context key
    // carries the browser runtime's face here; the running node process holds the Host store.
    const sessions = this.ctx.get('sessions') as unknown as SessionStore | undefined
    const live = sessions?.get(sessionId as SessionId)
    if (live !== undefined) return live.header.cwd

    // A session's `cwd` is fixed at creation, so a resolved entry never goes stale.
    const cached = this.sessionCwd.get(sessionId)
    if (cached !== undefined) return cached

    const persistence = this.ctx.get('sessionPersistence') as PersistedSessions | undefined
    if (persistence === undefined || sessionId.length > MAX_SESSION_ID_LENGTH) return undefined
    const retryAt = this.sessionMisses.get(sessionId)
    if (retryAt !== undefined && Date.now() < retryAt) return undefined

    const pending = this.sessionLookups.get(sessionId)
    if (pending !== undefined) return pending
    const lookup = this.lookUpPersistedCwd(persistence, sessionId)
      .finally(() => { this.sessionLookups.delete(sessionId) })
    this.sessionLookups.set(sessionId, lookup)
    return lookup
  }

  /**
   * Resolve one session's working directory through persistence, remembering the answer either way.
   * @param persistence - the composed persistence backend.
   * @param sessionId - the session to resolve.
   * @returns its working directory, or `undefined` when persistence does not know one.
   */
  private async lookUpPersistedCwd(persistence: PersistedSessions, sessionId: string): Promise<string | undefined> {
    let cwd: string | undefined
    try {
      if (typeof persistence.stat === 'function') {
        const snapshot = await persistence.stat(sessionId)
        cwd = snapshot?.header.cwd
      } else {
        // Without `stat`, one listing answers for every session on disk, so the map is filled
        // wholesale rather than listing again for the next unknown id.
        const snapshots = await persistence.list()
        for (const snapshot of snapshots) {
          if (typeof snapshot.header.cwd === 'string') this.sessionCwd.set(snapshot.header.id, snapshot.header.cwd)
        }
        cwd = this.sessionCwd.get(sessionId)
      }
    } catch (error) {
      // A persistence backend that cannot answer is a broken installation, not this request's fault;
      // the caller's own "no project board" message says the actionable part, and the backoff below
      // keeps a broken backend from being hammered by the poll.
      this.ctx.logger?.debug?.('dsh-tasks: could not look up persisted session %s: %o', sessionId, error)
      cwd = undefined
    }
    if (typeof cwd === 'string') {
      this.sessionCwd.set(sessionId, cwd)
      this.sessionMisses.delete(sessionId)
      return cwd
    }
    this.rememberMiss(sessionId)
    return undefined
  }

  /**
   * Note that a session could not be resolved, so the poll does not ask persistence again at once.
   * @param sessionId - the unresolved session.
   */
  private rememberMiss(sessionId: string): void {
    this.sessionMisses.delete(sessionId)
    if (this.sessionMisses.size >= MAX_REMEMBERED_MISSES) {
      // Maps iterate in insertion order, so the first key is the oldest miss.
      const oldest = this.sessionMisses.keys().next()
      if (oldest.done !== true) this.sessionMisses.delete(oldest.value)
    }
    this.sessionMisses.set(sessionId, Date.now() + SESSION_MISS_BACKOFF_MS)
  }

  /**
   * The board belonging to a session's project, resolving sessions that are no longer live.
   * @param sessionId - the session asking.
   * @returns its project's board.
   * @throws SessionUnavailableError when no directory can be found for the session.
   */
  async boardForSession(sessionId: string): Promise<TaskStore> {
    return this.boardForCwd(await this.cwdForSession(sessionId), sessionId)
  }

  /**
   * The project root a session belongs to.
   *
   * The same walk the board itself is keyed on, so anything read *about* the project — its commit
   * history, for one — is read from the directory the board lives in rather than from wherever the
   * session happened to be opened.
   * @param sessionId - the session asking.
   * @returns the project root.
   * @throws SessionUnavailableError when no directory can be found for the session.
   */
  async projectRootForSession(sessionId: string): Promise<string> {
    const root = projectRootFor(await this.cwdForSession(sessionId), this.config().projectRootMarkers)
    if (root === undefined) {
      throw new SessionUnavailableError(
        sessionId,
        'this session names no working directory on this host, so it belongs to no project board',
      )
    }
    return root
  }

  /**
   * Everyone who has committed to a session's project.
   * @param sessionId - the session asking.
   * @param now - epoch ms, for the cache's age check.
   * @returns the committers, or an unavailable result when git could not be read.
   */
  async authorsFor(sessionId: string, now: number): Promise<GitAuthorsResult> {
    return this.gitAuthors.read(await this.projectRootForSession(sessionId), now)
  }

  /**
   * Route one decoded RPC request to its endpoint.
   *
   * Every endpoint funnels through here so validation, error mapping, and cancellation are written
   * once. The payload is `unknown` — the generic channel validates only the envelope — so each
   * branch reads its fields through the checked accessors above.
   * @param endpoint - the channel-relative endpoint name.
   * @param payload - the decoded request body, untrusted.
   * @param signal - the gateway's cancellation for an abandoned request.
   * @returns the RPC result.
   */
  private async routeRpc(endpoint: string, payload: unknown, signal: AbortSignal): Promise<RpcResult<unknown>> {
    try {
      const value = await this.handle(endpoint as TasksRpcEndpoint, payload, signal)
      return { ok: true, value }
    } catch (error) {
      if (error instanceof SessionUnavailableError) {
        return {
          ok: false,
          error: {
            code: 'session-not-found',
            message: error.message,
            details: { sessionId: error.sessionId as SessionId },
          },
        }
      }
      if (signal.aborted) {
        return { ok: false, error: { code: 'cancelled', message: 'the request was abandoned', details: {} } }
      }
      return toRpcError(error)
    }
  }

  /**
   * Run one endpoint's work.
   * @param endpoint - the endpoint name.
   * @param payload - the decoded request body, untrusted.
   * @param signal - the gateway's cancellation.
   * @returns the endpoint's result value.
   * @throws TaskValidationError for an unknown endpoint or a malformed body.
   */
  private async handle(endpoint: TasksRpcEndpoint, payload: unknown, signal: AbortSignal): Promise<unknown> {
    const sessionId = requireString(payload, 'sessionId')
    const author: TaskAuthor = { actor: 'user', sessionId }
    const now = Date.now()

    // Every board endpoint resolves the session through persistence when it is not live, so a tab
    // left open on a finished run still reads its project's board after a restart.
    switch (endpoint) {
      case 'board.read':
        return (await this.boardForSession(sessionId)).read(optionalObject(payload, 'query'))
      case 'board.revision': {
        const board = await this.boardForSession(sessionId)
        const { counts, archivedCount } = board.counts()
        return { revision: board.revision(), counts, archivedCount } satisfies BoardRevisionResult
      }
      case 'task.detail':
        return (await this.boardForSession(sessionId)).detail(parseTaskId(requireString(payload, 'taskId')))
      case 'task.create':
        return (await this.boardForSession(sessionId)).create(
          optionalObject(payload, 'task') as unknown as TaskCreate,
          author,
          now,
        )
      case 'task.update':
        return (await this.boardForSession(sessionId)).update(
          parseTaskId(requireString(payload, 'taskId')),
          optionalObject(payload, 'patch') as unknown as TaskPatch,
          author,
          now,
          readOptionalTimestamp(payload, 'expectedUpdatedAt'),
        )
      case 'task.move':
        return (await this.boardForSession(sessionId)).update(
          parseTaskId(requireString(payload, 'taskId')),
          {
            status: requireString(payload, 'status') as TaskStatus,
            place: optionalObject(payload, 'place'),
          } as TaskPatch,
          author,
          now,
          // The same precondition an edit carries: a drop computed against a card someone has since
          // moved or changed would otherwise land on top of their change.
          readOptionalTimestamp(payload, 'expectedUpdatedAt'),
        )
      case 'task.archive':
        return (await this.boardForSession(sessionId)).setArchived(
          parseTaskId(requireString(payload, 'taskId')), true, author, now,
        )
      case 'task.restore':
        return (await this.boardForSession(sessionId)).setArchived(
          parseTaskId(requireString(payload, 'taskId')), false, author, now,
        )
      case 'task.delete':
        this.removeTask(
          await this.boardForSession(sessionId),
          parseTaskId(requireString(payload, 'taskId')),
          readOptionalString(payload, 'clearUnknownRun'),
        )
        return { deleted: true }
      case 'task.clearRun':
        return this.clearUnknownRun(
          await this.boardForSession(sessionId),
          parseTaskId(requireString(payload, 'taskId')),
          requireString(payload, 'jobId'),
          author,
        )
      case 'comment.add':
        return (await this.boardForSession(sessionId)).addComment(
          parseTaskId(requireString(payload, 'taskId')), requireString(payload, 'body'), author, now,
        )
      case 'comment.edit':
        return (await this.boardForSession(sessionId)).editComment(
          parseCommentIdText(requireString(payload, 'commentId')), requireString(payload, 'body'), now,
        )
      case 'comment.remove':
        (await this.boardForSession(sessionId)).removeComment(
          parseCommentIdText(requireString(payload, 'commentId')), now,
        )
        return { deleted: true }
      case 'task.dispatch':
        return this.dispatch(
          sessionId,
          parseTaskId(requireString(payload, 'taskId')),
          readOptionalString(payload, 'instructions'),
          signal,
          readOptionalString(payload, 'clearUnknownRun'),
        )
      case 'jobs.list':
        return { jobs: this.listJobs(sessionId) }
      case 'jobs.read':
        return this.readJob(sessionId, requireString(payload, 'jobId'))
      case 'jobs.kill':
        return this.killJob(sessionId, requireString(payload, 'jobId'))
      case 'git.authors':
        return this.authorsFor(sessionId, now)
      default:
        // The channel routes every path under its prefix here, so an unrecognised endpoint is a
        // client that has outrun this build — not an internal fault.
        throw new TaskValidationError(`unknown endpoint ${JSON.stringify(String(endpoint))}`)
    }
  }

  /**
   * The agent owning a session, when one is live.
   * @param sessionId - the session.
   * @returns the agent, or `undefined`.
   */
  private agentFor(sessionId: string): Agent | undefined {
    return this.ctx.get('agents')?.get(sessionId as SessionId) as Agent | undefined
  }

  /**
   * Background jobs visible to a session, whatever started them.
   *
   * Includes bash and subagent jobs as well as this plugin's own, because the Background panel is
   * this plugin's answer to "what is running right now" and hiding the other kinds would make it
   * lie.
   * @param sessionId - the session asking.
   * @returns the jobs, in registration order.
   */
  listJobs(sessionId: string): JobView[] {
    const jobs = this.ctx.get('jobs')
    if (jobs === undefined) return []
    return jobs.list(this.agentFor(sessionId)).map(snapshot =>
      toJobView(snapshot, this.jobTasks.get(snapshot.id)?.taskId))
  }

  /**
   * Read one job's output without taking it from the agent.
   *
   * The registry gives each job ONE consuming read cursor, and it belongs to the agent: `job_output`
   * returns only what was produced since the previous read. A board button that called `read` on a
   * shell job ate the output the agent was waiting to collect. So only this plugin's own `task` jobs
   * are read here — they carry final output only, which the registry returns idempotently once the
   * job has settled and never consumes. Every other kind reports its state with its output withheld.
   * @param sessionId - the session asking.
   * @param jobId - the job to read.
   * @returns the job's state, and its final output when the board may read it.
   * @throws TaskValidationError when no job registry is composed.
   */
  readJob(sessionId: string, jobId: string): JobReadResult {
    const jobs = this.ctx.get('jobs')
    if (jobs === undefined) throw new TaskValidationError('no background job registry is composed')
    const caller = this.agentFor(sessionId)
    // `get` is the registry's non-consuming read: state only, cursor untouched.
    const snapshot = jobs.get(jobId as never, caller)
    const taskId = this.jobTasks.get(jobId)?.taskId
    if (snapshot.kind !== 'task') {
      return { text: '', job: toJobView(snapshot, taskId), outputWithheld: true }
    }
    const read = jobs.read(jobId as never, caller)
    return { text: read.text, job: toJobView(read.snapshot, taskId) }
  }

  /**
   * Ask one job to stop.
   *
   * A job the caller can see is stopped as the caller, exactly as `job_kill` would. A card's run that
   * another session in this process started is not visible to the caller — the registry fences jobs
   * by owning session — yet the card sits on the caller's board with a Stop control on it. That run
   * is stopped as its owner: the same authority deleting the card already carries.
   * @param sessionId - the session asking.
   * @param jobId - the job to stop.
   * @returns whether a stop was requested or the job had already settled.
   * @throws TaskValidationError when no job registry is composed.
   */
  async killJob(sessionId: string, jobId: string): Promise<JobKillResult> {
    const jobs = this.ctx.get('jobs')
    if (jobs === undefined) throw new TaskValidationError('no background job registry is composed')
    const caller = this.agentFor(sessionId)
    const visible = jobs.list(caller).some(snapshot => snapshot.id === jobId)
    if (!visible) {
      const board = await this.boardForSession(sessionId)
      const owned = this.ownedCardRun(board, jobId)
      if (owned !== undefined) {
        return { outcome: owned.jobs.kill(jobId as never, owned.agent, STOPPED_FROM_BOARD_REASON) }
      }
    }
    return { outcome: jobs.kill(jobId as never, caller, STOPPED_FROM_BOARD_REASON) }
  }

  /**
   * The run this process owns under a job id, when a card on the board is marked with it.
   * @param board - the board to look on.
   * @param jobId - the job id.
   * @returns the owned run, or `undefined`.
   */
  private ownedCardRun(board: TaskStore, jobId: string): OwnedRun | undefined {
    // Job ids are per-process counters, so the marker must also name THIS process as its owner.
    const marker = board.runMarkers().find(entry =>
      entry.jobId === jobId && entry.owner !== undefined && ownerProcessState(entry.owner) === 'this-process')
    if (marker?.owner === undefined) return undefined
    return this.ownedTaskJob(marker.jobId, marker.owner.sessionId)
  }

  /**
   * The live agent and job registry for a run this process owns, provided the job really is one of
   * this plugin's card runs.
   *
   * The kind check matters because a marker is a row in a file: a hand-edited `running_job_id`
   * naming someone's shell job must not let a card deletion stop that job with its owner's authority.
   * @param jobId - the job id the marker records.
   * @param sessionId - the session the run belongs to.
   * @returns the registry, the owning agent, and the job's snapshot; `undefined` when the registry,
   *   the owner agent, or the job is gone, or the job is not a card run.
   */
  private ownedTaskJob(jobId: string, sessionId: string): OwnedRun | undefined {
    const jobs = this.ctx.get('jobs')
    const agent = this.agentFor(sessionId)
    if (jobs === undefined || agent === undefined) return undefined
    let snapshot: JobSnapshot
    try {
      snapshot = jobs.get(jobId as never, agent)
    } catch (error) {
      // `get` throws for an unknown job — the registry drops an owner's jobs when that agent is
      // disposed — and for a foreign one, which a marker naming the wrong session would be. Either
      // way there is no run of ours to act on, which is the answer this lookup exists to give.
      this.ctx.logger?.debug?.('dsh-tasks: job %s is not a live run of this process: %o', jobId, error)
      return undefined
    }
    if (snapshot.kind !== 'task') return undefined
    return { jobs, agent, snapshot }
  }

  /**
   * Decide whether a card's running marker is still live.
   *
   * The process check comes first (see `./run-owner.ts`). A run this very process owns is judged by
   * the job registry, the only authority on it: still running is live; settled means its settlement
   * never reached the card, so the registry's terminal record is written instead; unknown means the
   * registry — or the agent that owned the job — is gone, and so is the run.
   *
   * A marker with no recorded owner is live unless this process's registry positively identifies
   * its run and reports it finished ({@link unownedRunInThisProcess}). Anything short of that —
   * no such job here, a job that does not match — leaves the marker for a person to clear.
   * @param marker - the marker to judge.
   * @returns the verdict.
   */
  private judgeRun(marker: RunMarker): RunVerdict {
    const owner = marker.owner
    if (owner === undefined) {
      const identified = this.unownedRunInThisProcess(marker)
      if (identified === undefined || !TERMINAL_JOB_STATUSES.has(identified.snapshot.status)) return { kind: 'live' }
      return verdictFromSnapshot(marker.jobId, identified.snapshot)
    }
    if (ownerProcessState(owner) !== 'this-process') return judgeRunByProcess(marker)
    const owned = this.ownedTaskJob(marker.jobId, owner.sessionId)
    if (owned === undefined) return { kind: 'interrupted' }
    return verdictFromSnapshot(marker.jobId, owned.snapshot)
  }

  /**
   * The run behind a marker with no recorded owner, when this process's job registry holds it.
   *
   * The history's `run-started` entry names the dispatching session. If that session's agent is live
   * here and owns a card-run job of the marker's id, that job is the run only if it is also for this
   * card and started when the board recorded the dispatch; see {@link UNOWNED_RUN_START_TOLERANCE_MS}
   * for why the id and session alone are not enough.
   * @param marker - a marker with no owner.
   * @returns the run, or `undefined` when this process cannot vouch for it.
   */
  private unownedRunInThisProcess(marker: RunMarker): OwnedRun | undefined {
    const started = marker.started
    if (started?.sessionId === undefined) return undefined
    const run = this.ownedTaskJob(marker.jobId, started.sessionId)
    if (run === undefined) return undefined
    if (!run.snapshot.label.startsWith(`#${marker.ref} `)) return undefined
    if (Math.abs(run.snapshot.startedAt - started.at) > UNOWNED_RUN_START_TOLERANCE_MS) return undefined
    return run
  }

  /**
   * Clear a card's running marker whose owner is unknown, as a person has confirmed.
   *
   * If this process still runs the job behind it — the older build's run, started here before a
   * plugin reload — the job is stopped as its owner first, so clearing the marker does not leave a
   * subagent working a card that now looks idle. Otherwise the run, if it is live at all, is in a
   * process this one cannot reach, and the person has accepted that.
   * @param board - the board the card belongs to.
   * @param taskId - the card.
   * @param jobId - the job id of the marker the person was shown.
   * @param author - who confirmed it.
   * @returns the card as it now stands.
   * @throws TaskValidationError when the card is held by a different run or one with a known owner.
   */
  clearUnknownRun(board: TaskStore, taskId: string, jobId: string, author: TaskAuthor): Task {
    const marker = board.runMarker(taskId)
    if (marker?.owner === undefined && marker?.jobId === jobId) {
      const identified = this.unownedRunInThisProcess(marker)
      if (identified !== undefined && !TERMINAL_JOB_STATUSES.has(identified.snapshot.status)) {
        identified.jobs.kill(jobId as never, identified.agent, CLEARED_MARKER_REASON)
      }
    }
    return board.clearUnknownRun(taskId, jobId, author, Date.now())
  }

  /**
   * Make sure a marker with no owner may be cleared on the person's behalf.
   * @param marker - the card's marker, with no owner.
   * @param confirmedJobId - the job id the person confirmed clearing, if any.
   * @throws TaskValidationError when the person has not confirmed clearing THIS marker.
   */
  private requireUnknownRunConfirmed(marker: RunMarker, confirmedJobId: string | undefined): void {
    if (confirmedJobId === marker.jobId) return
    throw new TaskValidationError(
      `#${marker.ref} is marked as running job ${marker.jobId}, but the marker does not record which dsh process owns it `
      + '(it was written by an older build of this plugin, or edited by hand), so that run may still be live in another dsh process. '
      + 'Clear the marker from the task board, which asks you to confirm, or wait for that run to finish.',
    )
  }

  /**
   * Delete a card, stopping the run working it first.
   *
   * The one deletion path: the board UI and the model's `task_delete` both come through here, so
   * neither can leave an orphaned subagent behind.
   *
   * A dispatched card owns a live subagent. Deleting the card without stopping it leaves that
   * subagent running against a task nobody can see, reporting to a row that no longer exists —
   * spending tokens on work whose record has been thrown away. So:
   *
   * - A marker whose owner is gone is cleared first; there is nothing to stop.
   * - A marker with no recorded owner is refused unless the person confirmed clearing that marker;
   *   then any run of it this process still holds is stopped and the marker cleared.
   * - A run this process owns is stopped AS ITS OWNER. The registry fences jobs by owning session, and
   *   any session on the project can open the board, so stopping it as the deleting session failed
   *   with "belongs to another session" — the failure was swallowed and the subagent kept running.
   * - A run another live process owns cannot be stopped from here, so the delete is refused with a
   *   message saying so, rather than deleting the card out from under that run.
   * @param board - the board the card belongs to.
   * @param taskId - the card to delete.
   * @param clearUnknownRun - the job id of an owner-unknown marker the person confirmed clearing.
   * @throws TaskValidationError when a run in another process is still working the card, or an
   *   owner-unknown marker holds it without confirmation.
   */
  removeTask(board: TaskStore, taskId: string, clearUnknownRun?: string): void {
    board.reconcileRun(taskId, marker => this.judgeRun(marker), Date.now())
    const marker = board.runMarker(taskId)
    if (marker !== undefined && marker.owner === undefined) {
      this.requireUnknownRunConfirmed(marker, clearUnknownRun)
      this.clearUnknownRun(board, taskId, marker.jobId, { actor: 'user' })
    } else if (marker !== undefined) {
      this.stopRunForDeletion(marker)
    }
    board.remove(taskId)
  }

  /**
   * Stop the live run on a card that is being deleted.
   * @param marker - the card's marker, already judged live.
   * @throws TaskValidationError when the run belongs to another process.
   */
  private stopRunForDeletion(marker: RunMarker): void {
    const owner = marker.owner
    // A marker with no owner is handled, with the person's confirmation, before this is reached.
    if (owner === undefined) return
    if (ownerProcessState(owner) !== 'this-process') {
      throw new TaskValidationError(
        `#${marker.ref} is being worked by a background run in another dsh process (pid ${owner.pid}). `
        + 'Stop it from that process, or wait for it to finish, then delete the card.',
      )
    }
    const owned = this.ownedTaskJob(marker.jobId, owner.sessionId)
    // Judged live a moment ago; a run that settled in between has nothing left to stop.
    if (owned === undefined) return
    owned.jobs.kill(marker.jobId as never, owned.agent, DELETED_CARD_REASON)
    this.jobTasks.delete(marker.jobId)
  }

  /**
   * Hand a card to the agent to work in the background.
   *
   * The run is a subagent job in the harness's own registry, so it appears in the shipped
   * background-job surfaces alongside `bash` and `subagent` jobs, survives the turn that started
   * it, and is killed by the same control as any other job.
   * @param sessionId - the session dispatching.
   * @param taskId - the card to work.
   * @param instructions - extra direction for this run.
   * @param signal - cancellation for the dispatch call itself, not for the run it starts.
   * @param clearUnknownRun - the job id of an owner-unknown marker the person confirmed clearing.
   * @returns the job id and the card carrying it.
   * @throws TaskValidationError when the deployment cannot run a background card, or the card is held
   *   by a run — including one whose owner is unknown and whose clearing was not confirmed.
   */
  async dispatch(
    sessionId: string,
    taskId: string,
    instructions: string | undefined,
    signal: AbortSignal,
    clearUnknownRun?: string,
  ): Promise<TaskDispatchResult> {
    const config = this.config()
    const board = this.boardFor(sessionId)
    // A marker whose owner has gone is cleared here rather than refused as "already running": this is
    // the moment someone is asking to run the card again.
    board.reconcileRun(taskId, marker => this.judgeRun(marker), Date.now())
    const held = board.runMarker(taskId)
    const unknown = held?.owner === undefined ? held : undefined
    if (unknown !== undefined) {
      this.requireUnknownRunConfirmed(unknown, clearUnknownRun)
    } else if (held !== undefined) {
      throw new TaskValidationError(`#${held.ref} is already running as job ${held.jobId}`)
    }

    const jobs = this.ctx.get('jobs')
    const subagents = this.ctx.get('subagents')
    if (jobs === undefined) {
      throw new TaskValidationError(
        'background jobs are unavailable: compose @deepseek-ai/dsh-jobs-local to dispatch a card',
      )
    }
    if (subagents === undefined || config.subagentProvider === '') {
      throw new TaskValidationError(
        'dispatch needs a subagent provider: compose one and set `subagentProvider` in the task settings',
      )
    }
    const parent = this.agentFor(sessionId)
    if (parent === undefined) {
      throw new TaskValidationError('this session has no live agent to dispatch from')
    }
    signal.throwIfAborted()

    const author: TaskAuthor = { actor: 'user', sessionId }
    // Cleared only now, once nothing is left that could refuse the dispatch: a confirmation to run the
    // card again is not a confirmation to leave it idle. The clear is conditional on the confirmed job
    // id, and the claim below on the card being idle, so a run that took the card meanwhile wins.
    if (unknown !== undefined) this.clearUnknownRun(board, taskId, unknown.jobId, author)
    const detail = board.detail(taskId)
    const startedAt = Date.now()
    const databasePath = board.databasePath
    const owner = currentRunOwner(sessionId)

    // The job id only exists after `start` returns, while `run()` is called inside it. The
    // settlement tap therefore waits on this promise rather than reading a variable that may still
    // be unset when a run settles unusually fast.
    let announce: (id: string) => void = () => {}
    const idReady = new Promise<string>((resolve) => { announce = resolve })

    const jobId = jobs.start({
      kind: 'task',
      label: `#${detail.task.ref} ${detail.task.title}`,
      owner: parent,
      run: () => {
        const controller = new AbortController()
        const run = subagents.start(config.subagentProvider, {
          label: `#${detail.task.ref} ${detail.task.title}`,
          prompt: [{ type: 'text', text: buildDispatchPrompt(detail, instructions) }],
          // The same agent object; see the note on `Agent` about the two type copies.
          parent: parent as never,
          signal: controller.signal,
        })
        const done = settleSubagentRun(run, controller.signal)
        // Observed, not fire-and-forget: `settleSubagentRun` never rejects and `settleDispatch` never
        // throws; the rejection arm exists so a broken contract is logged rather than unhandled.
        done.then(
          async (outcome) => { this.settleDispatch(await idReady, taskId, databasePath, owner, outcome, startedAt) },
          (error: unknown) => { this.ctx.logger?.warn?.('dsh-tasks: a dispatched run settled abnormally: %o', error) },
        )
        return { cancel: (reason?: string) => { controller.abort(reason ?? 'task run stopped') }, done }
      },
    })
    announce(jobId)
    this.jobTasks.set(jobId, { taskId, projectRoot: databasePath })

    let task: Task
    try {
      task = board.startRun(taskId, jobId, owner, author, startedAt)
    } catch (error) {
      // Another process claimed the card between the check above and this write. The job just
      // started must not run on unrecorded: stop it (as its owner, which this session is) and report.
      jobs.kill(jobId as never, parent, 'the card was claimed by another run')
      this.jobTasks.delete(jobId)
      throw error
    }
    this.holdCompletionNotice(jobs, jobId, parent)
    if (config.dispatchStatus !== 'none' && task.status !== config.dispatchStatus) {
      task = board.update(taskId, { status: config.dispatchStatus }, { actor: 'system', sessionId }, startedAt)
    }
    return { jobId, task }
  }

  /**
   * Keep the job controller from opening a model turn when a dispatched card's run finishes.
   *
   * `@deepseek-ai/dsh-tool-jobs` delivers a completion notice for every unreported job to its owning
   * agent, and under its default `completionDelivery: 'wakeup'` an idle owner gets a whole new model
   * turn for it. Delivery is that plugin's deployment setting, not a per-job option, so a producer
   * cannot choose it. But a dispatch is started by a person on the board, not by the agent: the agent
   * never asked for the result, and the board records it on the card. Spending a model request on an
   * unsolicited notice is the wrong default.
   *
   * The registry's contract offers one per-job way to say "this completion is collected": a `wait`
   * pending when the job settles marks it reported, and a reported job gets no notice. So this holds a
   * wait for the life of the run, re-armed in {@link NOTICE_HOLD_SLICE_MS} slices. It is owned by the
   * service, not fired and forgotten: the service's disposal aborts it, and its only failures — that
   * abort, or the registry forgetting the job along with its owner — both mean there is no notice
   * left to hold. The agent can still find the run with `job_list` and read it with `job_output`.
   * @param jobs - the job registry.
   * @param jobId - the dispatched run.
   * @param owner - its owning agent.
   */
  private holdCompletionNotice(jobs: JobRegistryFace, jobId: string, owner: Agent): void {
    const signal = this.noticeHolds.signal
    const hold = async (): Promise<void> => {
      for (;;) {
        const snapshot = await jobs.wait(jobId as never, NOTICE_HOLD_SLICE_MS, owner, signal)
        if (TERMINAL_JOB_STATUSES.has(snapshot.status)) return
      }
    }
    hold().catch((error: unknown) => {
      this.ctx.logger?.debug?.('dsh-tasks: stopped holding the completion notice for %s: %o', jobId, error)
    })
  }

  /**
   * Record a finished dispatch on its card.
   *
   * Reached from a job settlement, which the registry runs outside any request, so it must not
   * throw. The board is addressed by path, not through whatever board the current registry has open:
   * a settings save rebuilds the registry and a plugin reload replaces the service, and the run's
   * outcome must reach its card through both.
   *
   * Synchronous once the outcome is known, deliberately: the stale-run sweep treats a settled job
   * whose marker is still set as a lost settlement, and a write that never yields cannot be observed
   * half-done by a request arriving in between.
   * @param jobId - the settled job.
   * @param taskId - the card it was working.
   * @param databasePath - the board the card belongs to.
   * @param owner - the process and session that started the run.
   * @param outcome - how the run ended, with its output.
   * @param startedAt - epoch ms the run started.
   */
  private settleDispatch(
    jobId: string,
    taskId: string,
    databasePath: string,
    owner: RunOwner,
    outcome: DispatchOutcome,
    startedAt: number,
  ): void {
    this.jobTasks.delete(jobId)
    const finishedAt = Date.now()
    const summary: TaskRunSummary = {
      jobId,
      status: outcome.status,
      ...outcome.detail === undefined ? {} : { detail: outcome.detail },
      startedAt,
      finishedAt,
    }
    const completed = this.config().dispatchCompletedStatus
    const report = runReport(jobId, outcome)
    try {
      this.registry.withBoardAt(databasePath, (board) => {
        board.finishRun(taskId, summary, owner, { actor: 'system' }, finishedAt, {
          ...report === undefined ? {} : { report },
          ...outcome.status === 'completed' && completed !== 'none' ? { completedStatus: completed } : {},
        })
      })
    } catch (error) {
      // The file became unreadable, or a writer held it past the busy timeout. Nothing observes this
      // settlement to report to, and the marker stays in place: the next open of the board, or the
      // next dispatch or delete of this card, finds the job settled in the registry and records it.
      this.ctx.logger?.warn?.('dsh-tasks: could not record the settlement of %s on its card: %o', jobId, error)
    }
  }
}

/**
 * Read an optional epoch-ms field off an untrusted RPC payload.
 * @param payload - the decoded request body.
 * @param field - the field to read.
 * @returns the value, or `undefined` when absent.
 * @throws TaskValidationError when present but not a non-negative whole number.
 */
function readOptionalTimestamp(payload: unknown, field: string): number | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = (payload as Record<string, unknown>)[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TaskValidationError(`${field} must be a whole number of milliseconds since the epoch`)
  }
  return value
}

/**
 * Read an optional string field off an untrusted RPC payload.
 * @param payload - the decoded request body.
 * @param field - the field to read.
 * @returns the value, or `undefined` when absent or blank.
 * @throws TaskValidationError when present but not a string.
 */
function readOptionalString(payload: unknown, field: string): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = (payload as Record<string, unknown>)[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new TaskValidationError(`${field} must be a string`)
  return value.trim() === '' ? undefined : value
}

/**
 * Compose the prompt a dispatched card is worked from.
 *
 * The card's own comments are included because a board where the discussion lives in the comments
 * and the agent only ever sees the title is a board whose dispatch feature is decorative.
 * @param detail - the card with its comments.
 * @param instructions - extra direction supplied at dispatch.
 * @returns the child agent's user message.
 */
export function buildDispatchPrompt(detail: TaskDetail, instructions: string | undefined): string {
  const { task, comments } = detail
  const lines = [
    `Work this task from the project board and complete it.`,
    '',
    `Task #${task.ref}: ${task.title}`,
    `Status: ${task.status}   Priority: ${task.priority}`,
  ]
  if (task.labels.length > 0) lines.push(`Labels: ${task.labels.join(', ')}`)
  if (task.assignee !== undefined) lines.push(`Assignee: ${task.assignee}`)
  if (task.body !== '') lines.push('', '## Description', task.body)
  if (comments.length > 0) {
    lines.push('', '## Discussion')
    for (const comment of comments) {
      lines.push(`- (${comment.author}) ${comment.body}`)
    }
  }
  if (instructions !== undefined) lines.push('', '## Additional instructions', instructions)
  lines.push(
    '',
    'When you are done, report what you changed. Do not mark the task done yourself — the board records the outcome of this run.',
  )
  return lines.join('\n')
}

/**
 * The sweep's verdict on a run from the job registry's record of it.
 * @param jobId - the marker's job id.
 * @param snapshot - the registry's snapshot of that job.
 * @returns `live` while it runs; `settled` with the registry's terminal record once it has finished.
 */
function verdictFromSnapshot(jobId: string, snapshot: JobSnapshot): RunVerdict {
  switch (snapshot.status) {
    case 'running':
    case 'stopping':
      return { kind: 'live' }
    case 'completed':
    case 'killed':
    case 'failed':
      return {
        kind: 'settled',
        summary: {
          jobId,
          status: snapshot.status,
          ...snapshot.detail === undefined ? {} : { detail: snapshot.detail },
          startedAt: snapshot.startedAt,
          finishedAt: snapshot.finishedAt ?? Date.now(),
        },
      }
    default: {
      const unexpected: never = snapshot.status
      throw new Error(`tasks: unexpected job status ${String(unexpected)}`)
    }
  }
}

/** A run of this process, reachable as its owner. */
interface OwnedRun {
  /** The job registry holding the run. */
  jobs: JobRegistryFace
  /** The agent that owns the job. */
  agent: Agent
  /** The job's state when it was looked up. */
  snapshot: JobSnapshot
}

/** How a dispatched run ended, as handed to the job registry and recorded on the card. */
interface DispatchOutcome {
  /** Terminal status. */
  status: 'completed' | 'killed' | 'failed'
  /** Why it ended, including the provider's diagnostic for a run that did not complete. */
  detail?: string
  /**
   * The child's final assistant text — or, for a run that did not complete, what it had produced.
   * The registry returns it from `job_output` once the job settles (the job has no stream to read),
   * and the board writes it on the card as a comment.
   */
  output?: string
}

/** One content block of a subagent's output, as far as this plugin reads it. */
interface OutputBlock {
  readonly type: string
  readonly text?: unknown
}

/** A subagent run's terminal result (`SubagentResult` on 0.1.5-rc.2), as far as this plugin reads it. */
interface SubagentOutcome {
  readonly stopReason: string
  readonly output?: readonly OutputBlock[]
  readonly diagnostic?: string
}

/**
 * The text of a subagent's output blocks.
 * @param blocks - the child's output.
 * @returns the joined text, or `undefined` when there is none.
 */
function outputText(blocks: readonly OutputBlock[] | undefined): string | undefined {
  const pieces = (blocks ?? []).flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
  const text = pieces.join('')
  return text.trim() === '' ? undefined : text
}

/**
 * Fold a subagent run into a job outcome without ever rejecting.
 *
 * The job registry converts a rejected `done` into a bare `failed` with no detail, which loses the
 * only explanation the user would have had; folding here keeps it. The child's output and the
 * provider's diagnostic are carried too: dropping them left a completed job whose `job_output` was
 * empty and a card that recorded "finished" and nothing of what was done.
 * @param start - the pending subagent start.
 * @param signal - the run's own cancellation, to tell a kill apart from a fault.
 * @returns the outcome the registry records.
 */
async function settleSubagentRun(
  start: Promise<{ result: Promise<SubagentOutcome>; dispose(): Promise<void> }>,
  signal: AbortSignal,
): Promise<DispatchOutcome> {
  try {
    const run = await start
    try {
      const result = await run.result
      const output = outputText(result.output)
      const carried = output === undefined ? {} : { output }
      if (result.stopReason === 'completed') return { status: 'completed', detail: 'finished', ...carried }
      const diagnostic = result.diagnostic === undefined ? '' : `; ${result.diagnostic}`
      return {
        status: signal.aborted ? 'killed' : 'failed',
        detail: `subagent stopped: ${result.stopReason}${diagnostic}`,
        ...carried,
      }
    } finally {
      await run.dispose()
    }
  } catch (error) {
    return signal.aborted
      ? { status: 'killed', detail: 'stopped' }
      : { status: 'failed', detail: error instanceof Error ? error.message : String(error) }
  }
}

/** Appended to a run report cut down to fit in a comment. */
const TRUNCATED_REPORT_NOTE = '\n\n… (truncated; `job_output` returns the whole output while the job is still listed)'

/**
 * The comment a finished run leaves on its card.
 *
 * A comment rather than a field of `last_run`, because `last_run` travels with every card on every
 * board read and a report can run to many kilobytes; comments are read only with the card's detail.
 * @param jobId - the run's job id.
 * @param outcome - how it ended.
 * @returns the comment, or `undefined` for a run with nothing to report (stopped, no output).
 */
function runReport(jobId: string, outcome: DispatchOutcome): string | undefined {
  if (outcome.output === undefined && outcome.status !== 'failed') return undefined
  const detail = outcome.detail === undefined ? '.' : `: ${outcome.detail}`
  const heading = outcome.status === 'completed'
    ? `**Run ${jobId} completed.**`
    : `**Run ${jobId} ${outcome.status === 'failed' ? 'failed' : 'was stopped'}**${detail}`
  let body = ''
  if (outcome.output !== undefined) {
    body = outcome.status === 'completed' ? `\n\n${outcome.output}` : `\n\nOutput before it ended:\n\n${outcome.output}`
  }
  const report = `${heading}${body}`
  if (report.length <= MAX_COMMENT_LENGTH) return report
  return `${report.slice(0, MAX_COMMENT_LENGTH - TRUNCATED_REPORT_NOTE.length)}${TRUNCATED_REPORT_NOTE}`
}

export { TASK_PRIORITIES, TASK_STATUSES }
export type { BoardView, Task, TaskComment, TaskCreate, TaskDetail, TaskPatch, TaskStatus }
export default TasksService
