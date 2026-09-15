/**
 * The operating-system facts a running marker's owner is judged by: which machine this is, which
 * process this is, and whether a pid still names the process that wrote a marker.
 *
 * Kept apart from `./run-owner.ts` so the judgement can be tested against injected answers
 * ({@link ProcessProbes}) and the platform code can be read on its own.
 *
 * **Machine identity.** The host name is not an identity: macOS rewrites it when the network changes,
 * under a live process. A marker keyed on it made this process's own runs look foreign, and left the
 * markers of processes that died before the rename unsweepable forever. So the machine is identified
 * by the platform's stable id — the IOPlatformUUID on macOS, `/etc/machine-id` on Linux, MachineGuid
 * on Windows — and only falls back to the host name when that cannot be read. On Linux the pid
 * namespace is part of the identity too, because two containers can share a machine id while
 * neither can see the other's pids; judging one's markers from the other would sweep live runs.
 * The id is stored as a salted digest: `/etc/machine-id` in particular is documented as confidential,
 * and the board is a file people commit, copy, and share.
 *
 * **Process start.** A pid is reused, possibly by another user's process, so "the pid exists" alone
 * kept a dead run's marker alive indefinitely. A marker therefore records its process's start as read
 * by the same source that later checks it, and a live pid whose start differs is another process.
 * Linux reads `/proc/<pid>/stat` (start ticks since boot) with the boot id, so the comparison is exact
 * and immune to wall-clock steps. macOS has no file to read and reports the start through `ps` as
 * wall-clock seconds, so a small tolerance absorbs clock adjustment. Elsewhere no start is recorded,
 * and a live pid keeps its marker, as before. `Date.now() - process.uptime()` was rejected: uptime is
 * a monotonic clock that stops during sleep on macOS, so after a laptop lid had been closed it would
 * disagree with `ps` by hours and make a live run look dead.
 *
 * **Subprocesses.** The plugin already runs `git`; this module adds at most two kinds of short,
 * synchronous child: `ioreg` or `reg` once per process for the machine id (cached, and only where no
 * file carries it), and `ps` on macOS when a marker from another live process on this machine is
 * judged. Each is an absolute executable path with an argument array — no shell, no `PATH` lookup,
 * nothing from the board spliced into a command line except a validated integer pid — a two-second
 * timeout, a small output cap, and stderr discarded. A failure of any of them only means "unknown",
 * which every caller treats in the direction that keeps a marker.
 *
 * @module @achasoft/dsh-tasks-manager/host/process-identity
 */

import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, readlinkSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

/** The facts about processes on this machine that owner judgement needs. Injected by tests. */
export interface ProcessProbes {
  /** This process's pid. */
  readonly pid: number
  /** This process's random instance id, stable across plugin reloads. */
  instance(): string
  /** The current host name, kept for markers that recorded nothing better. */
  hostname(): string
  /** This machine's stable identity digest. */
  machine(): string
  /** Whether a process with this pid exists, under any user. */
  exists(pid: number): boolean
  /** The start of the process holding this pid, as an opaque token; `undefined` when unreadable. */
  startToken(pid: number): string | undefined
}

/** Process-wide key for the instance id, shared by every copy of this module in one process. */
const INSTANCE_KEY = Symbol.for('@achasoft/dsh-tasks-manager/process-instance')

/** Process-wide key for the machine identity, so a plugin reload does not ask the platform again. */
const MACHINE_KEY = Symbol.for('@achasoft/dsh-tasks-manager/machine-identity')

/** Process-wide key for this process's own start token, which cannot change while it runs. */
const OWN_START_KEY = Symbol.for('@achasoft/dsh-tasks-manager/process-start')

/** Salt for the machine digest, so the stored value cannot be matched against the raw id elsewhere. */
const MACHINE_DIGEST_SALT = '@achasoft/dsh-tasks-manager:machine:v1'

/** Hex characters kept from the digest: 128 bits, ample for telling machines apart. */
const MACHINE_DIGEST_LENGTH = 32

/** How long a probe subprocess may run before it is abandoned as "unknown". */
const PROBE_TIMEOUT_MS = 2000

/** The most output a probe subprocess may produce; `ioreg -rd1` for one device is a few kilobytes. */
const PROBE_MAX_BUFFER_BYTES = 256 * 1024

/**
 * How far apart two macOS start readings of one process may be. The kernel records the start as
 * wall-clock time and `ps` prints it to the second; the allowance covers rounding and clock
 * adjustment, and is far shorter than any realistic interval before a pid is handed out again.
 */
const DARWIN_START_TOLERANCE_SECONDS = 30

/** Token prefix for a start read from `ps` on macOS. */
const DARWIN_START = 'darwin'

/** Token prefix for a start read from `/proc` on Linux. */
const LINUX_START = 'linux'

/** 1-based position of `starttime` in `/proc/<pid>/stat`; see proc(5). */
const PROC_STAT_START_FIELD = 22

/** 1-based position of the first field after the parenthesised command name in `/proc/<pid>/stat`. */
const PROC_STAT_FIRST_FIELD_AFTER_COMMAND = 3

/** Month abbreviations as `ps` prints them in the C locale. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/**
 * Run a fixed platform tool for its output.
 * @param file - absolute path of the executable.
 * @param args - its arguments.
 * @returns standard output, or `undefined` when the tool is missing, fails, or times out.
 */
function probeOutput(file: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      // Fixed locale and zone, so `ps` prints the same start the same way in every process.
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    })
  } catch {
    // Missing tool, non-zero exit (for `ps`, "no such process"), or timeout: all mean "not known",
    // which the callers handle by keeping the marker.
    return undefined
  }
}

/**
 * Read a small text file.
 * @param path - the file.
 * @returns its contents, or `undefined` when it cannot be read.
 */
function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    // Absent or unreadable (another user's `/proc` entry under `hidepid`): not known.
    return undefined
  }
}

/**
 * The IOPlatformUUID in `ioreg -rd1 -c IOPlatformExpertDevice` output.
 * @param output - the tool's output.
 * @returns the UUID, or `undefined` when the output carries none.
 */
export function parseIoregPlatformUuid(output: string): string | undefined {
  return /"IOPlatformUUID"\s*=\s*"([^"]+)"/u.exec(output)?.[1]
}

/**
 * The MachineGuid in `reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid` output.
 * @param output - the tool's output.
 * @returns the GUID, or `undefined` when the output carries none.
 */
export function parseRegMachineGuid(output: string): string | undefined {
  return /MachineGuid\s+REG_SZ\s+(\S+)/u.exec(output)?.[1]
}

/**
 * The stored form of a machine identity.
 * @param raw - the platform identifier, or the fallback built from the host name.
 * @returns a salted SHA-256 digest, truncated.
 */
export function hashMachineIdentity(raw: string): string {
  return createHash('sha256').update(`${MACHINE_DIGEST_SALT}\0${raw}`).digest('hex').slice(0, MACHINE_DIGEST_LENGTH)
}

/**
 * This machine's platform identifier.
 * @returns the identifier, or `undefined` when the platform offers none this module can read.
 */
function platformMachineId(): string | undefined {
  switch (process.platform) {
    case 'darwin': {
      const output = probeOutput('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])
      return output === undefined ? undefined : parseIoregPlatformUuid(output)
    }
    case 'linux': {
      const id = (readText('/etc/machine-id') ?? readText('/var/lib/dbus/machine-id'))?.trim()
      if (id === undefined || id === '') return undefined
      // Pids are only comparable inside one pid namespace; see the module note on containers.
      return `${id}\0${linuxPidNamespace() ?? ''}`
    }
    case 'win32': {
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
      const output = probeOutput(join(systemRoot, 'System32', 'reg.exe'), [
        'query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid',
      ])
      return output === undefined ? undefined : parseRegMachineGuid(output)
    }
    default:
      return undefined
  }
}

/**
 * This process's pid namespace on Linux.
 * @returns the namespace link text (`pid:[4026531836]`), or `undefined` when unreadable.
 */
function linuxPidNamespace(): string | undefined {
  try {
    return readlinkSync('/proc/self/ns/pid')
  } catch {
    // No /proc, or a kernel without namespaces: the machine id alone is the identity.
    return undefined
  }
}

/**
 * This machine's identity digest, read once per process.
 * @returns the digest.
 */
function machineIdentity(): string {
  const holder = globalThis as { [MACHINE_KEY]?: string }
  holder[MACHINE_KEY] ??= hashMachineIdentity(platformMachineId() ?? `host:${hostname()}`)
  return holder[MACHINE_KEY]
}

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
 * Whether a process exists.
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
 * A start time as `ps -o lstart=` prints it with `LC_ALL=C TZ=UTC`.
 * @param output - the tool's output, e.g. `Tue Sep 15 19:24:38 2026`.
 * @returns the start token, or `undefined` when the output is not a start time.
 */
export function parsePsStartTime(output: string): string | undefined {
  const match = /^\s*[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/u.exec(output)
  if (match === null) return undefined
  const [, month, day, hours, minutes, seconds, year] = match
  const monthIndex = MONTHS.indexOf(month as (typeof MONTHS)[number])
  if (monthIndex < 0) return undefined
  const at = Date.UTC(Number(year), monthIndex, Number(day), Number(hours), Number(minutes), Number(seconds))
  return `${DARWIN_START}:${at / 1000}`
}

/**
 * The start ticks in a `/proc/<pid>/stat` line.
 *
 * The command name is parenthesised and may itself contain spaces and parentheses, so fields are
 * counted from the LAST closing parenthesis.
 * @param stat - the file's contents.
 * @returns the start ticks as text, or `undefined` when the line is malformed.
 */
export function parseProcStatStartTicks(stat: string): string | undefined {
  const close = stat.lastIndexOf(')')
  if (close < 0) return undefined
  const fields = stat.slice(close + 1).trim().split(/\s+/u)
  const ticks = fields[PROC_STAT_START_FIELD - PROC_STAT_FIRST_FIELD_AFTER_COMMAND]
  return ticks !== undefined && /^\d+$/u.test(ticks) ? ticks : undefined
}

/**
 * The start of the process holding a pid, with this process's own start read once and kept: every
 * dispatch records it, and on macOS each reading is a `ps` child.
 * @param pid - a validated positive pid.
 * @returns the start token, or `undefined` when this platform cannot say.
 */
function processStartToken(pid: number): string | undefined {
  if (pid !== process.pid) return readProcessStartToken(pid)
  const holder = globalThis as { [OWN_START_KEY]?: string | null }
  // `null` remembers "unreadable", so a platform without a source is not asked again either.
  holder[OWN_START_KEY] ??= readProcessStartToken(pid) ?? null
  return holder[OWN_START_KEY] ?? undefined
}

/**
 * Read the start of the process holding a pid from the platform.
 * @param pid - a validated positive pid.
 * @returns the start token, or `undefined` when this platform cannot say.
 */
function readProcessStartToken(pid: number): string | undefined {
  switch (process.platform) {
    case 'linux': {
      const boot = readText('/proc/sys/kernel/random/boot_id')?.trim()
      const stat = readText(`/proc/${pid}/stat`)
      const ticks = stat === undefined ? undefined : parseProcStatStartTicks(stat)
      return boot === undefined || ticks === undefined ? undefined : `${LINUX_START}:${boot}:${ticks}`
    }
    case 'darwin': {
      const output = probeOutput('/bin/ps', ['-o', 'lstart=', '-p', String(pid)])
      return output === undefined ? undefined : parsePsStartTime(output)
    }
    default:
      return undefined
  }
}

/**
 * Split a start token into the source that read it and the reading.
 * @param token - the token.
 * @returns the parts, or `undefined` for a token with no source.
 */
function splitStartToken(token: string): { source: string; reading: string } | undefined {
  const separator = token.indexOf(':')
  if (separator <= 0) return undefined
  return { source: token.slice(0, separator), reading: token.slice(separator + 1) }
}

/**
 * Whether two start tokens describe the same process start.
 * @param recorded - the token a marker stored.
 * @param observed - the token read now for the same pid.
 * @returns true when they match; tokens from different sources, or unreadable ones, never match.
 */
export function sameProcessStart(recorded: string, observed: string): boolean {
  const before = splitStartToken(recorded)
  const now = splitStartToken(observed)
  if (before === undefined || now === undefined || before.source !== now.source) return false
  switch (before.source) {
    case LINUX_START:
      return before.reading === now.reading
    case DARWIN_START: {
      const beforeSeconds = Number(before.reading)
      const nowSeconds = Number(now.reading)
      if (!Number.isFinite(beforeSeconds) || !Number.isFinite(nowSeconds)) return false
      return Math.abs(beforeSeconds - nowSeconds) <= DARWIN_START_TOLERANCE_SECONDS
    }
    default:
      return false
  }
}

/** The real operating system's answers. */
export const systemProbes: ProcessProbes = {
  pid: process.pid,
  instance: processInstance,
  hostname,
  machine: machineIdentity,
  exists: processExists,
  startToken: processStartToken,
}
