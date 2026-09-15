/**
 * Stand-ins for the harness services the task service reaches through `ctx.get`: the job registry,
 * the agent registry, the live session store, persistence, subagents, and the settings provider.
 *
 * The job registry is the one that has to be faithful. Its behaviour is copied from the installed
 * `@deepseek-ai/dsh-jobs-local` 0.1.5-rc.2 (`LocalJobRegistry`), not invented: owned jobs are fenced
 * by the owner's session id and throw "belongs to another session" for anyone else; `read` consumes
 * a stream job's cursor but returns a final-output job's output idempotently; `kill` and a terminal
 * `read` mark the job reported; a `wait` pending at settlement marks it reported before completion
 * listeners run. A permissive fake is how the cross-session delete bug shipped: the old fake's
 * `kill` accepted any caller, so the test passed while the real registry refused.
 */

/** A live agent as the job registry and the service see it. */
export interface FakeAgent {
  readonly id: string
  status: 'idle' | 'busy'
}

/** What a producer hands the registry. */
interface FakeJobStart {
  kind: string
  label: string
  owner?: FakeAgent
  run(): { cancel(reason?: string): void; done: Promise<FakeOutcome>; readOutput?(): string }
}

/** A terminal outcome. */
interface FakeOutcome {
  status: 'completed' | 'killed' | 'failed'
  detail?: string
  output?: string
}

/** The snapshot shape of the installed registry. */
export interface FakeSnapshot {
  id: string
  kind: string
  label: string
  ownerSession?: string
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  detail?: string
  startedAt: number
  finishedAt?: number
  reported: boolean
}

/** One registered job. */
interface JobRecord {
  id: string
  kind: string
  label: string
  owner: FakeAgent | undefined
  cancel: (reason?: string) => void
  readOutput: (() => string) | undefined
  status: FakeSnapshot['status']
  detail: string | undefined
  output: string | undefined
  startedAt: number
  finishedAt: number | undefined
  reported: boolean
  waiters: number
  onSettled: Set<() => void>
}

/**
 * Whether a status is terminal.
 * @param status - the status.
 * @returns true for completed, killed, and failed.
 */
function isTerminal(status: FakeSnapshot['status']): boolean {
  return status === 'completed' || status === 'killed' || status === 'failed'
}

/** An in-memory job registry with the installed registry's access and reporting rules. */
export class FakeJobRegistry {
  readonly #records = new Map<string, JobRecord>()
  readonly #counters = new Map<string, number>()
  readonly #listeners: ((snapshot: FakeSnapshot, owner: FakeAgent | undefined) => void)[] = []
  /** Every kill request, with the caller it came from. */
  readonly kills: { id: string; caller: string | undefined; reason: string | undefined }[] = []

  /**
   * @param agents - the agent registry an owned start is checked against.
   */
  constructor(private readonly agents: FakeAgentRegistry) {}

  start(spec: FakeJobStart): string {
    if (spec.owner !== undefined && this.agents.get(spec.owner.id) !== spec.owner) {
      throw new Error(`agent "${spec.owner.id}" is not the registered agent instance (background job owner must be live)`)
    }
    const hooks = spec.run()
    const count = (this.#counters.get(spec.kind) ?? 0) + 1
    this.#counters.set(spec.kind, count)
    const record: JobRecord = {
      id: `${spec.kind}-${count}`,
      kind: spec.kind,
      label: spec.label,
      owner: spec.owner,
      cancel: hooks.cancel.bind(hooks),
      readOutput: hooks.readOutput?.bind(hooks),
      status: 'running',
      detail: undefined,
      output: undefined,
      startedAt: Date.now(),
      finishedAt: undefined,
      reported: false,
      waiters: 0,
      onSettled: new Set(),
    }
    this.#records.set(record.id, record)
    hooks.done.then(
      (outcome) => { this.#settle(record, outcome) },
      (error: unknown) => { this.#settle(record, { status: 'failed', detail: String(error) }) },
    )
    return record.id
  }

  list(caller?: FakeAgent): FakeSnapshot[] {
    return [...this.#records.values()]
      .filter(record => record.owner === undefined || record.owner.id === caller?.id)
      .map(record => this.#snapshot(record))
  }

  get(id: string, caller?: FakeAgent): FakeSnapshot {
    const record = this.#expect(id)
    this.#assertAccess(record, caller)
    return this.#snapshot(record)
  }

  read(id: string, caller?: FakeAgent): { text: string; snapshot: FakeSnapshot } {
    const record = this.#expect(id)
    this.#assertAccess(record, caller)
    const text = record.readOutput !== undefined
      ? record.readOutput()
      : isTerminal(record.status) ? record.output ?? '' : ''
    if (isTerminal(record.status)) record.reported = true
    return { text, snapshot: this.#snapshot(record) }
  }

  kill(id: string, caller?: FakeAgent, reason?: string): 'requested' | 'already-finished' {
    const record = this.#expect(id)
    this.#assertAccess(record, caller)
    this.kills.push({ id, caller: caller?.id, reason })
    if (isTerminal(record.status)) {
      record.reported = true
      return 'already-finished'
    }
    record.cancel(reason)
    record.status = 'stopping'
    record.reported = true
    return 'requested'
  }

  async wait(id: string, timeoutMs: number, caller?: FakeAgent, signal?: AbortSignal): Promise<FakeSnapshot> {
    const record = this.#expect(id)
    this.#assertAccess(record, caller)
    if (!isTerminal(record.status)) {
      if (signal?.aborted === true) throw new Error('wait aborted')
      record.waiters += 1
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { done(); resolve() }, timeoutMs)
          timer.unref()
          const onSettled = (): void => { done(); resolve() }
          const onAbort = (): void => { done(); reject(new Error('wait aborted')) }
          const done = (): void => {
            clearTimeout(timer)
            record.onSettled.delete(onSettled)
            signal?.removeEventListener('abort', onAbort)
          }
          record.onSettled.add(onSettled)
          signal?.addEventListener('abort', onAbort, { once: true })
        })
      } finally {
        record.waiters -= 1
      }
    }
    if (isTerminal(record.status)) record.reported = true
    return this.#snapshot(record)
  }

  onJobDone(listener: (snapshot: FakeSnapshot, owner: FakeAgent | undefined) => void): () => void {
    this.#listeners.push(listener)
    return () => { this.#listeners.splice(this.#listeners.indexOf(listener), 1) }
  }

  /**
   * Register a job some other producer started, for tests about jobs this plugin did not start.
   * @param kind - the producer kind.
   * @param owner - the owning agent.
   * @param readOutput - a stream cursor, for a stream job.
   * @returns the job id and a function that settles it.
   */
  external(kind: string, owner: FakeAgent, readOutput?: () => string): { id: string; settle: (outcome: FakeOutcome) => void } {
    let settle: (outcome: FakeOutcome) => void = () => {}
    const done = new Promise<FakeOutcome>((resolve) => { settle = resolve })
    const id = this.start({
      kind,
      label: `${kind} job`,
      owner,
      run: () => ({ cancel: () => { settle({ status: 'killed' }) }, done, ...readOutput === undefined ? {} : { readOutput } }),
    })
    return { id, settle }
  }

  #settle(record: JobRecord, outcome: FakeOutcome): void {
    if (isTerminal(record.status)) return
    record.status = outcome.status
    record.detail = outcome.detail
    record.output = outcome.output
    record.finishedAt = Date.now()
    if (record.waiters > 0) record.reported = true
    const snapshot = this.#snapshot(record)
    for (const resolve of [...record.onSettled]) resolve()
    for (const listener of this.#listeners) listener(snapshot, record.owner)
  }

  #expect(id: string): JobRecord {
    const record = this.#records.get(id)
    if (record === undefined) throw new Error(`unknown job ${id}`)
    return record
  }

  #assertAccess(record: JobRecord, caller: FakeAgent | undefined): void {
    if (record.owner !== undefined && record.owner.id !== caller?.id) {
      throw new Error(`job ${record.id} belongs to another session`)
    }
  }

  #snapshot(record: JobRecord): FakeSnapshot {
    return {
      id: record.id,
      kind: record.kind,
      label: record.label,
      ...record.owner === undefined ? {} : { ownerSession: record.owner.id },
      status: record.status,
      ...record.detail === undefined ? {} : { detail: record.detail },
      startedAt: record.startedAt,
      ...record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt },
      reported: record.reported,
    }
  }
}

/** The agent registry: live agents by session id. */
export class FakeAgentRegistry {
  readonly #agents = new Map<string, FakeAgent>()

  /**
   * Make a session's agent live.
   * @param sessionId - the session.
   * @returns its agent.
   */
  add(sessionId: string): FakeAgent {
    const agent: FakeAgent = { id: sessionId, status: 'idle' }
    this.#agents.set(sessionId, agent)
    return agent
  }

  get(sessionId: string): FakeAgent | undefined {
    return this.#agents.get(sessionId)
  }
}

/** The live session store: headers by session id. */
export class FakeSessionStore {
  readonly #cwd = new Map<string, string>()

  /**
   * Make a session live in a directory.
   * @param sessionId - the session.
   * @param cwd - its working directory.
   */
  add(sessionId: string, cwd: string): void {
    this.#cwd.set(sessionId, cwd)
  }

  get(sessionId: string): { header: { id: string; cwd: string } } | undefined {
    const cwd = this.#cwd.get(sessionId)
    return cwd === undefined ? undefined : { header: { id: sessionId, cwd } }
  }
}

/** A subagent run the test settles by hand. */
export interface PendingRun {
  /** The request the service started the run with. */
  request: { label: string; prompt: unknown; parent: unknown; signal: AbortSignal }
  /** Settle the run with a result shaped like the installed `SubagentResult`. */
  finish: (result: { stopReason: string; output: { type: string; text?: string }[]; diagnostic?: string }) => void
  /** Whether the run was disposed. */
  disposed: () => boolean
}

/** The subagent runtime: every started run is held until the test finishes it. */
export class FakeSubagents {
  readonly runs: PendingRun[] = []

  start(_provider: string, request: PendingRun['request']): Promise<{ result: Promise<unknown>; dispose(): Promise<void> }> {
    let finish: PendingRun['finish'] = () => {}
    const result = new Promise<unknown>((resolve) => {
      finish = resolve
      request.signal.addEventListener('abort', () => { resolve({ stopReason: 'aborted', output: [] }) }, { once: true })
    })
    let disposed = false
    this.runs.push({ request, finish, disposed: () => disposed })
    return Promise.resolve({ result, dispose: () => { disposed = true; return Promise.resolve() } })
  }
}

/** The settings provider: captures the section hooks so a test can commit a change. */
export class FakeSettings {
  hooks: { onChange: () => void } | undefined

  installSection(_owner: unknown, _ns: string, _schema: unknown, _entry: unknown, hooks: { onChange: () => void }): void {
    this.hooks = hooks
  }
}

/**
 * Let every queued promise continuation run.
 * @returns once the microtask and immediate queues have drained.
 */
export async function settle(): Promise<void> {
  for (let round = 0; round < 5; round++) {
    await new Promise<void>((resolve) => { setImmediate(resolve) })
  }
}
