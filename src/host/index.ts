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
 * session's writes, and a person editing `.dsh/tasks.db` with `sqlite3`.
 *
 * @module @achasoft/dsh-tasks-manager/host
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { RpcError, RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { JobOutcome, JobSnapshot } from '@deepseek-ai/dsh-jobs'
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
  type TaskStatus,
} from '../domain/types.ts'
import { TaskValidationError, parseCommentIdText, parseTaskId } from '../domain/validate.ts'
import { TaskNotFoundError, TaskStoreRegistry, type TaskAuthor, type TaskStore } from './store.ts'
import { DEFAULT_DATABASE_PATH, JOURNAL_MODES, TaskStoreError, type JournalMode } from './db.ts'
import { projectRootFor } from './project-root.ts'
import {
  TASKS_RPC_CHANNEL,
  type BoardRevisionResult,
  type JobKillResult,
  type JobReadResult,
  type JobView,
  type TaskDispatchResult,
  type TasksRpcEndpoint,
} from './protocol.ts'

export type * from './protocol.ts'
export type { TaskAuthor, TaskStore } from './store.ts'
export { TaskNotFoundError } from './store.ts'

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
  if (error instanceof TaskValidationError || error instanceof TaskNotFoundError) {
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

    // The channel needs the caller's own `webServer` (`connection.rpc.handle` registers a route
    // through it), so both are injected together and a headless deployment simply gets no channel —
    // the tools and the database still work there.
    ctx.inject(['connection', 'webServer'], (rpcCtx) => {
      rpcCtx.connection.rpc.handle(
        TASKS_RPC_CHANNEL,
        (endpoint, payload, signal) => this.routeRpc(endpoint, payload, signal),
        { authority: 'trusted-host' },
      )
    })

    ctx.effect(() => () => { this.registry.close() }, 'dsh-tasks: close boards')
  }

  /**
   * Build a store registry from one configuration snapshot.
   * @param config - the configuration to build from.
   * @returns the registry.
   */
  private buildRegistry(config: Config): TaskStoreRegistry {
    return new TaskStoreRegistry(config.databasePath, {
      newTaskPlacement: config.newTaskPlacement,
      defaultStatus: config.defaultStatus,
      journalMode: config.journalMode,
      busyTimeoutMs: config.busyTimeoutMs,
    })
  }

  /**
   * Re-open every board against the current settings.
   *
   * Closing and rebuilding rather than mutating in place because `databasePath` and `journalMode`
   * are decided when a database is opened; a live handle cannot adopt a new value for either.
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
        'this session has no working directory, so it belongs to no project board',
      )
    }
    return this.registry.open(root, Date.now())
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

    switch (endpoint) {
      case 'board.read':
        return this.boardFor(sessionId).read(optionalObject(payload, 'query'))
      case 'board.revision': {
        const board = this.boardFor(sessionId)
        const { counts, archivedCount } = board.counts()
        return { revision: board.revision(), counts, archivedCount } satisfies BoardRevisionResult
      }
      case 'task.detail':
        return this.boardFor(sessionId).detail(parseTaskId(requireString(payload, 'taskId')))
      case 'task.create':
        return this.boardFor(sessionId).create(
          optionalObject(payload, 'task') as unknown as TaskCreate,
          author,
          now,
        )
      case 'task.update':
        return this.boardFor(sessionId).update(
          parseTaskId(requireString(payload, 'taskId')),
          optionalObject(payload, 'patch') as unknown as TaskPatch,
          author,
          now,
        )
      case 'task.move':
        return this.boardFor(sessionId).update(
          parseTaskId(requireString(payload, 'taskId')),
          {
            status: requireString(payload, 'status') as TaskStatus,
            place: optionalObject(payload, 'place'),
          } as TaskPatch,
          author,
          now,
        )
      case 'task.archive':
        return this.boardFor(sessionId).setArchived(
          parseTaskId(requireString(payload, 'taskId')), true, author, now,
        )
      case 'task.restore':
        return this.boardFor(sessionId).setArchived(
          parseTaskId(requireString(payload, 'taskId')), false, author, now,
        )
      case 'task.delete':
        this.boardFor(sessionId).remove(parseTaskId(requireString(payload, 'taskId')))
        return { deleted: true }
      case 'comment.add':
        return this.boardFor(sessionId).addComment(
          parseTaskId(requireString(payload, 'taskId')), requireString(payload, 'body'), author, now,
        )
      case 'comment.edit':
        return this.boardFor(sessionId).editComment(
          parseCommentIdText(requireString(payload, 'commentId')), requireString(payload, 'body'), now,
        )
      case 'comment.remove':
        this.boardFor(sessionId).removeComment(parseCommentIdText(requireString(payload, 'commentId')), now)
        return { deleted: true }
      case 'task.dispatch':
        return this.dispatch(
          sessionId,
          parseTaskId(requireString(payload, 'taskId')),
          readOptionalString(payload, 'instructions'),
          signal,
        )
      case 'jobs.list':
        return { jobs: this.listJobs(sessionId) }
      case 'jobs.read':
        return this.readJob(sessionId, requireString(payload, 'jobId'))
      case 'jobs.kill':
        return this.killJob(sessionId, requireString(payload, 'jobId'))
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
    return this.ctx.get('agents')?.get(sessionId as SessionId)
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
   * Consume one job's output.
   * @param sessionId - the session asking.
   * @param jobId - the job to read.
   * @returns the output produced since the previous read, and the job's state.
   * @throws TaskValidationError when no job registry is composed, or the job is unknown.
   */
  readJob(sessionId: string, jobId: string): JobReadResult {
    const jobs = this.ctx.get('jobs')
    if (jobs === undefined) throw new TaskValidationError('no background job registry is composed')
    const read = jobs.read(jobId as never, this.agentFor(sessionId))
    return { text: read.text, job: toJobView(read.snapshot, this.jobTasks.get(jobId)?.taskId) }
  }

  /**
   * Ask one job to stop.
   * @param sessionId - the session asking.
   * @param jobId - the job to stop.
   * @returns whether a stop was requested or the job had already settled.
   * @throws TaskValidationError when no job registry is composed, or the job is unknown.
   */
  killJob(sessionId: string, jobId: string): JobKillResult {
    const jobs = this.ctx.get('jobs')
    if (jobs === undefined) throw new TaskValidationError('no background job registry is composed')
    return { outcome: jobs.kill(jobId as never, this.agentFor(sessionId), 'stopped from the task board') }
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
   * @returns the job id and the card carrying it.
   * @throws TaskValidationError when the deployment cannot run a background card.
   */
  async dispatch(
    sessionId: string,
    taskId: string,
    instructions: string | undefined,
    signal: AbortSignal,
  ): Promise<TaskDispatchResult> {
    const config = this.config()
    const board = this.boardFor(sessionId)
    const detail = board.detail(taskId)
    if (detail.task.runningJobId !== undefined) {
      throw new TaskValidationError(`#${detail.task.ref} is already running as job ${detail.task.runningJobId}`)
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
    const startedAt = Date.now()
    const projectRoot = board.databasePath

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
          parent,
          signal: controller.signal,
        })
        const done = settleSubagentRun(run, controller.signal)
        void done.then(
          async (outcome) => { await this.settleDispatch(await idReady, taskId, projectRoot, outcome, startedAt) },
          () => {
            // `settleSubagentRun` folds every failure into an outcome, so this branch is
            // unreachable; it exists so an unexpected rejection cannot become an unhandled one.
          },
        )
        return { cancel: (reason?: string) => { controller.abort(reason ?? 'task run stopped') }, done }
      },
    })
    announce(jobId)
    this.jobTasks.set(jobId, { taskId, projectRoot })

    let task = board.startRun(taskId, jobId, author, startedAt)
    if (config.dispatchStatus !== 'none' && task.status !== config.dispatchStatus) {
      task = board.update(taskId, { status: config.dispatchStatus }, { actor: 'system', sessionId }, startedAt)
    }
    return { jobId, task }
  }

  /**
   * Record a finished dispatch on its card.
   *
   * Reached from a job settlement, which the registry runs outside any request, so it must not
   * throw: a board that has since been closed or a card that has since been deleted are both
   * ordinary, and neither is worth breaking the registry's listener for.
   * @param jobId - the settled job.
   * @param taskId - the card it was working.
   * @param databasePath - the board the card belongs to.
   * @param outcome - how the run ended.
   * @param startedAt - epoch ms the run started.
   */
  private async settleDispatch(
    jobId: string,
    taskId: string,
    databasePath: string,
    outcome: JobOutcome,
    startedAt: number,
  ): Promise<void> {
    this.jobTasks.delete(jobId)
    const finishedAt = Date.now()
    try {
      const board = this.registry.byPath(databasePath)
      if (board === undefined) return
      board.finishRun(
        taskId,
        {
          jobId,
          status: outcome.status,
          ...outcome.detail === undefined ? {} : { detail: outcome.detail },
          startedAt,
          finishedAt,
        },
        { actor: 'system' },
        finishedAt,
      )
      const completed = this.config().dispatchCompletedStatus
      if (outcome.status === 'completed' && completed !== 'none') {
        board.update(taskId, { status: completed }, { actor: 'system' }, finishedAt)
      }
    } catch (error) {
      // The card or its board is gone. Nothing else observes this settlement, so there is no one to
      // report to and nothing left to update.
      this.ctx.logger?.debug?.('dsh-tasks: could not record run settlement: %o', error)
    }
    await Promise.resolve()
  }

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
 * Fold a subagent run into a job outcome without ever rejecting.
 *
 * The job registry converts a rejected `done` into a bare `failed` with no detail, which loses the
 * only explanation the user would have had; folding here keeps it.
 * @param start - the pending subagent start.
 * @param signal - the run's own cancellation, to tell a kill apart from a fault.
 * @returns the outcome the registry records.
 */
async function settleSubagentRun(
  start: Promise<{ result: Promise<{ stopReason: string }>; dispose(): Promise<void> }>,
  signal: AbortSignal,
): Promise<JobOutcome> {
  try {
    const run = await start
    try {
      const result = await run.result
      return result.stopReason === 'completed'
        ? { status: 'completed', detail: 'finished' }
        : { status: signal.aborted ? 'killed' : 'failed', detail: `subagent stopped: ${result.stopReason}` }
    } finally {
      await run.dispose()
    }
  } catch (error) {
    return signal.aborted
      ? { status: 'killed', detail: 'stopped' }
      : { status: 'failed', detail: error instanceof Error ? error.message : String(error) }
  }
}

export { TASK_PRIORITIES, TASK_STATUSES }
export type { BoardView, Task, TaskComment, TaskCreate, TaskDetail, TaskPatch, TaskStatus }
export default TasksService
