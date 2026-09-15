/**
 * Who a card's running marker belongs to, and whether that owner can still settle it.
 *
 * A dispatched run is a job in one process's in-memory registry, but the marker saying "this card is
 * being worked" is a row in a database any number of processes share. Without an owner on the row, a
 * second dsh process opening the board cannot tell a run that is live somewhere else from one whose
 * process died: it either sweeps live work as "interrupted" and re-offers Dispatch, or strands dead
 * markers forever. So the marker records the owner — the process that can settle it, and the session
 * whose agent owns the job — and liveness is judged from that record.
 *
 * Process identity is `(instance, machine, pid, processStart)`, checked in that order:
 *
 * - `instance`, a random id minted once per process and kept on `globalThis`, first: a marker carrying
 *   this process's instance is this process's, whatever else about the machine has changed since it
 *   was written. A plugin reload or a second copy of this module in the same process still
 *   recognises its own markers — the job registry outlives a plugin reload, and so does the run.
 * - `machine`, because a pid means nothing on another machine. It is a stable machine identity, not
 *   the host name, which macOS changes under a live process (see `./process-identity.ts`). A board on
 *   a shared filesystem opened from two machines cannot probe the other's processes, so a
 *   foreign-machine marker is never swept. Markers written before `machine` was recorded carry only
 *   `host`, and are compared by host name as they always were.
 * - `pid`, so a marker whose process has exited is recognisably stale. A marker carrying this
 *   process's pid but another instance was written by an earlier holder of the pid.
 * - `processStart`, because pids are reused — by any process, of any user. A live pid whose start is
 *   not the recorded one belongs to someone else, and the marker's own process is gone. A marker
 *   without it, or a start this platform cannot read, falls back to "the pid exists".
 *
 * `host` is still written, for people reading the row by hand.
 *
 * @module @achasoft/dsh-tasks-manager/host/run-owner
 */

import { sameProcessStart, systemProbes, type ProcessProbes } from './process-identity.ts'

/** The process and session a running marker belongs to, as stored in `tasks.run_owner`. */
export interface RunOwner {
  /** Host name of the process that started the run, when it started it. Informational on new markers. */
  host: string
  /** Stable identity digest of the machine; absent on markers written before it was recorded. */
  machine?: string | undefined
  /** That process's pid. */
  pid: number
  /** That process's start, as its platform reads it; absent when unreadable or on older markers. */
  processStart?: string | undefined
  /** That process's random instance id; see the module note. */
  instance: string
  /** The session whose agent owns the job, so the run can be stopped as its owner. */
  sessionId: string
}

/**
 * Where a marker's owner stands, from this process's point of view.
 *
 * - `this-process`: this process started it; only the job registry can say whether it is still live.
 * - `alive`: another process on this machine that is still running.
 * - `gone`: a process on this machine that has exited, or a pid now held by a different process.
 * - `unreachable`: another machine, whose processes this one cannot probe.
 */
export type OwnerProcessState = 'this-process' | 'alive' | 'gone' | 'unreachable'

/**
 * The owner record for a run this process is starting.
 * @param sessionId - the session whose agent owns the job.
 * @param probes - the operating system's answers; tests inject their own.
 * @returns the owner to store with the marker.
 */
export function currentRunOwner(sessionId: string, probes: ProcessProbes = systemProbes): RunOwner {
  const processStart = probes.startToken(probes.pid)
  return {
    host: probes.hostname(),
    machine: probes.machine(),
    pid: probes.pid,
    ...processStart === undefined ? {} : { processStart },
    instance: probes.instance(),
    sessionId,
  }
}

/**
 * Decode a stored owner, tolerating a hand-edited or legacy cell.
 * @param raw - the stored JSON text, or null for a marker written before owners were recorded.
 * @returns the owner, or `undefined` when the cell is empty or unreadable.
 */
export function decodeRunOwner(raw: string | null): RunOwner | undefined {
  if (raw === null) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const value = parsed as Partial<Record<keyof RunOwner, unknown>>
    if (typeof value.host !== 'string' || typeof value.instance !== 'string') return undefined
    if (typeof value.sessionId !== 'string') return undefined
    if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0) return undefined
    if (value.machine !== undefined && typeof value.machine !== 'string') return undefined
    if (value.processStart !== undefined && typeof value.processStart !== 'string') return undefined
    return {
      host: value.host,
      ...value.machine === undefined ? {} : { machine: value.machine },
      pid: value.pid,
      ...value.processStart === undefined ? {} : { processStart: value.processStart },
      instance: value.instance,
      sessionId: value.sessionId,
    }
  } catch {
    // A broken cell reads as "no known owner", which is judged like a marker from an older build.
    return undefined
  }
}

/**
 * Whether a marker was written on this machine, so its pid can be probed here.
 * @param owner - the stored owner.
 * @param probes - the operating system's answers.
 * @returns true for this machine.
 */
function onThisMachine(owner: RunOwner, probes: ProcessProbes): boolean {
  if (owner.machine !== undefined) return owner.machine === probes.machine()
  // Written before machine identity was recorded: the host name is all there is to go on.
  return owner.host === probes.hostname()
}

/**
 * Judge a marker's owner process.
 * @param owner - the stored owner.
 * @param probes - the operating system's answers; tests inject their own.
 * @returns where the owner stands.
 */
export function ownerProcessState(owner: RunOwner, probes: ProcessProbes = systemProbes): OwnerProcessState {
  if (owner.instance === probes.instance()) return 'this-process'
  if (!onThisMachine(owner, probes)) return 'unreachable'
  if (owner.pid === probes.pid) return 'gone'
  if (!probes.exists(owner.pid)) return 'gone'
  if (owner.processStart === undefined) return 'alive'
  const observed = probes.startToken(owner.pid)
  // An unreadable start is not evidence of reuse; keep the marker.
  if (observed === undefined) return 'alive'
  return sameProcessStart(owner.processStart, observed) ? 'alive' : 'gone'
}
