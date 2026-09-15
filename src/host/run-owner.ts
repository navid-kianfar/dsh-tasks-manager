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
 * Process identity is `(host, pid, instance)`:
 *
 * - `host` because a pid means nothing on another machine. A board on a shared filesystem opened from
 *   two hosts cannot probe the other's processes, so a foreign-host marker is never swept; clearing
 *   it by hand is one `UPDATE`, which the board notices on its next poll.
 * - `pid` so a marker whose process has exited is recognisably stale.
 * - `instance`, a random id minted once per process, because pids are reused. A marker carrying this
 *   process's pid but another instance was written by an earlier process that happened to have the
 *   same pid, and is stale. The id is kept on `globalThis`, so a plugin reload or a second copy of
 *   this module in the same process still recognises its own markers — the job registry outlives a
 *   plugin reload, and so does the run.
 *
 * @module @achasoft/dsh-tasks-manager/host/run-owner
 */

import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'

/** The process and session a running marker belongs to, as stored in `tasks.run_owner`. */
export interface RunOwner {
  /** Host name of the process that started the run. */
  host: string
  /** That process's pid. */
  pid: number
  /** That process's random instance id; see the module note on pid reuse. */
  instance: string
  /** The session whose agent owns the job, so the run can be stopped as its owner. */
  sessionId: string
}

/**
 * Where a marker's owner stands, from this process's point of view.
 *
 * - `this-process`: this process started it; only the job registry can say whether it is still live.
 * - `alive`: another process on this host that is still running.
 * - `gone`: a process on this host that has exited, or an earlier holder of this process's pid.
 * - `unreachable`: another host, whose processes this one cannot probe.
 */
export type OwnerProcessState = 'this-process' | 'alive' | 'gone' | 'unreachable'

/** Process-wide key for the instance id, shared by every copy of this module in one process. */
const INSTANCE_KEY = Symbol.for('@achasoft/dsh-tasks-manager/process-instance')

/**
 * This process's instance id, minted on first use.
 * @returns the id.
 */
function processInstance(): string {
  const holder = globalThis as { [INSTANCE_KEY]?: string }
  holder[INSTANCE_KEY] ??= randomBytes(12).toString('hex')
  return holder[INSTANCE_KEY]
}

/**
 * The owner record for a run this process is starting.
 * @param sessionId - the session whose agent owns the job.
 * @returns the owner to store with the marker.
 */
export function currentRunOwner(sessionId: string): RunOwner {
  return { host: hostname(), pid: process.pid, instance: processInstance(), sessionId }
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
    const value = parsed as Partial<RunOwner>
    if (typeof value.host !== 'string' || typeof value.instance !== 'string') return undefined
    if (typeof value.sessionId !== 'string') return undefined
    if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0) return undefined
    return { host: value.host, pid: value.pid, instance: value.instance, sessionId: value.sessionId }
  } catch {
    // A broken cell reads as "no known owner", which the sweep treats like a legacy marker.
    return undefined
  }
}

/**
 * Whether a process on this host exists.
 *
 * Signal 0 performs the permission and existence checks without delivering anything. `EPERM` means
 * the process exists under another user — alive, for this purpose.
 * @param pid - the process id.
 * @returns true when the process exists.
 */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Judge a marker's owner process.
 * @param owner - the stored owner.
 * @returns where the owner stands.
 */
export function ownerProcessState(owner: RunOwner): OwnerProcessState {
  if (owner.host !== hostname()) return 'unreachable'
  if (owner.instance === processInstance()) return 'this-process'
  if (owner.pid === process.pid) return 'gone'
  return processExists(owner.pid) ? 'alive' : 'gone'
}
