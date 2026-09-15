/**
 * Who owns a running marker, judged through injected process probes.
 *
 * The probes stand in for the operating system so the cases that matter — a host name that changed
 * under a live process, a pid handed to an unrelated process, an identity source that is missing —
 * can be set up exactly, instead of waiting for them to happen on the machine running the tests.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  currentRunOwner,
  decodeRunOwner,
  ownerProcessState,
  type RunOwner,
} from '../../src/host/run-owner.ts'
import {
  hashMachineIdentity,
  parseIoregPlatformUuid,
  parseProcStatStartTicks,
  parsePsStartTime,
  parseRegMachineGuid,
  sameProcessStart,
  systemProbes,
  type ProcessProbes,
} from '../../src/host/process-identity.ts'

/** The process the probes describe as "this one". */
const SELF_PID = 4242

/**
 * Probes for a machine the test fully controls.
 * @param overrides - the answers that differ from a quiet machine where only this process runs.
 * @returns the probes.
 */
function probes(overrides: Partial<ProcessProbes> & { alive?: ReadonlyMap<number, string | undefined> } = {}): ProcessProbes {
  const alive = overrides.alive ?? new Map<number, string | undefined>([[SELF_PID, 'darwin:1000']])
  return {
    pid: SELF_PID,
    instance: () => 'this-instance',
    hostname: () => 'laptop.local',
    machine: () => 'machine-a',
    exists: pid => alive.has(pid),
    startToken: pid => alive.get(pid),
    ...overrides,
  }
}

/**
 * A marker as another process would have written it.
 * @param fields - the fields that differ from a same-machine, foreign-process owner.
 * @returns the owner.
 */
function owner(fields: Partial<RunOwner> = {}): RunOwner {
  return {
    host: 'laptop.local',
    machine: 'machine-a',
    pid: 7001,
    processStart: 'darwin:5000',
    instance: 'other-instance',
    sessionId: 's1',
    ...fields,
  }
}

describe('recording an owner', () => {
  it('carries the stable machine identity and the process start alongside the host name', () => {
    expect(currentRunOwner('s1', probes())).toEqual({
      host: 'laptop.local',
      machine: 'machine-a',
      pid: SELF_PID,
      processStart: 'darwin:1000',
      instance: 'this-instance',
      sessionId: 's1',
    })
  })

  it('leaves the process start out when this platform cannot read it', () => {
    const recorded = currentRunOwner('s1', probes({ startToken: () => undefined }))
    expect(recorded).not.toHaveProperty('processStart')
  })
})

describe('reading a stored owner', () => {
  it('reads a marker written before machine identity and process start were recorded', () => {
    const legacy = { host: 'laptop.local', pid: 12, instance: 'i', sessionId: 's' }
    expect(decodeRunOwner(JSON.stringify(legacy))).toEqual(legacy)
  })

  it('reads the new fields', () => {
    const stored = owner()
    expect(decodeRunOwner(JSON.stringify(stored))).toEqual(stored)
  })

  it('refuses mistyped new fields rather than trusting half a record', () => {
    expect(decodeRunOwner(JSON.stringify({ ...owner(), machine: 7 }))).toBeUndefined()
    expect(decodeRunOwner(JSON.stringify({ ...owner(), processStart: 12 }))).toBeUndefined()
  })
})

describe('judging an owner', () => {
  it('knows its own marker by instance even after the host name changed', () => {
    const mine = currentRunOwner('s1', probes())
    const renamed = probes({ hostname: () => 'Johns-MacBook-Pro.home' })
    expect(ownerProcessState(mine, renamed)).toBe('this-process')
  })

  it('knows its own marker by instance even when the machine identity reads differently now', () => {
    const mine = currentRunOwner('s1', probes())
    expect(ownerProcessState(mine, probes({ machine: () => 'fell-back-to-host-name' }))).toBe('this-process')
  })

  it('judges a same-machine marker locally when only the host name changed', () => {
    const stored = owner({ host: 'old-name.local', pid: 7001 })
    // The owner exited before the rename; the marker is sweepable, not "on another host".
    expect(ownerProcessState(stored, probes())).toBe('gone')
  })

  it('never judges a marker from another machine, whatever its host name says', () => {
    const stored = owner({ machine: 'machine-b', host: 'laptop.local' })
    expect(ownerProcessState(stored, probes())).toBe('unreachable')
  })

  it('falls back to the host name for a marker that recorded no machine identity', () => {
    const { machine: _machine, ...legacy } = owner({ pid: 7001 })
    expect(ownerProcessState(legacy, probes())).toBe('gone')
    expect(ownerProcessState({ ...legacy, host: 'elsewhere' }, probes())).toBe('unreachable')
  })

  it('treats an earlier holder of this process\'s pid as gone', () => {
    expect(ownerProcessState(owner({ pid: SELF_PID }), probes())).toBe('gone')
  })

  it('keeps a live owner whose process started when the marker says', () => {
    const alive = new Map([[SELF_PID, 'darwin:1000'], [7001, 'darwin:5000']])
    expect(ownerProcessState(owner(), probes({ alive }))).toBe('alive')
  })

  it('treats a pid now held by a process that started later as gone', () => {
    // pid 7001 exists, but it is not the process that wrote the marker: it started at 9000.
    const alive = new Map([[SELF_PID, 'darwin:1000'], [7001, 'darwin:9000']])
    expect(ownerProcessState(owner(), probes({ alive }))).toBe('gone')
  })

  it('keeps an owner alive when the pid exists but its start cannot be read', () => {
    const alive = new Map<number, string | undefined>([[SELF_PID, 'darwin:1000'], [7001, undefined]])
    expect(ownerProcessState(owner(), probes({ alive }))).toBe('alive')
  })

  it('keeps an owner alive on a marker that recorded no process start', () => {
    const { processStart: _start, ...older } = owner()
    const alive = new Map([[SELF_PID, 'darwin:1000'], [7001, 'darwin:9000']])
    expect(ownerProcessState(older, probes({ alive }))).toBe('alive')
  })

  it('treats a missing pid as gone', () => {
    expect(ownerProcessState(owner(), probes())).toBe('gone')
  })
})

describe('comparing process starts', () => {
  it('matches a Linux start exactly, including the boot it belongs to', () => {
    expect(sameProcessStart('linux:boot-1:500', 'linux:boot-1:500')).toBe(true)
    expect(sameProcessStart('linux:boot-1:500', 'linux:boot-1:501')).toBe(false)
    expect(sameProcessStart('linux:boot-1:500', 'linux:boot-2:500')).toBe(false)
  })

  it('allows a macOS start the small drift a wall-clock reading can carry', () => {
    expect(sameProcessStart('darwin:1000', 'darwin:1010')).toBe(true)
    expect(sameProcessStart('darwin:1000', 'darwin:1600')).toBe(false)
  })

  it('never matches starts read by different sources', () => {
    expect(sameProcessStart('darwin:1000', 'linux:boot-1:1000')).toBe(false)
    expect(sameProcessStart('darwin:garbage', 'darwin:garbage')).toBe(false)
  })
})

describe('the system identity sources', () => {
  it('reads the platform UUID out of ioreg\'s output', () => {
    const output = '+-o J314sAP  <class IOPlatformExpertDevice>\n    {\n      "IOPlatformUUID" = "0A1B2C3D-0000-1111-2222-333344445555"\n    }\n'
    expect(parseIoregPlatformUuid(output)).toBe('0A1B2C3D-0000-1111-2222-333344445555')
    expect(parseIoregPlatformUuid('no uuid here')).toBeUndefined()
  })

  it('reads MachineGuid out of reg query\'s output', () => {
    const output = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    6f1c0d1e-aaaa-bbbb-cccc-0123456789ab\r\n\r\n'
    expect(parseRegMachineGuid(output)).toBe('6f1c0d1e-aaaa-bbbb-cccc-0123456789ab')
    expect(parseRegMachineGuid('')).toBeUndefined()
  })

  it('stores a digest of the machine identity, never the identifier itself', () => {
    const digest = hashMachineIdentity('0A1B2C3D-0000-1111-2222-333344445555')
    expect(digest).toMatch(/^[0-9a-f]{32}$/u)
    expect(digest).not.toContain('0A1B2C3D')
    expect(hashMachineIdentity('0A1B2C3D-0000-1111-2222-333344445555')).toBe(digest)
  })

  it('reads a start time from ps in the fixed C locale and UTC', () => {
    expect(parsePsStartTime('Tue Sep 15 19:24:38 2026    \n')).toBe(`darwin:${Date.UTC(2026, 8, 15, 19, 24, 38) / 1000}`)
    expect(parsePsStartTime('Sat Sep  5 01:02:03 2026')).toBe(`darwin:${Date.UTC(2026, 8, 5, 1, 2, 3) / 1000}`)
    expect(parsePsStartTime('')).toBeUndefined()
  })

  it('reads the start ticks from /proc/<pid>/stat, even when the command name holds spaces and parentheses', () => {
    const fields = ['S', ...Array.from({ length: 18 }, (_, index) => String(index + 1)), '987654']
    const stat = `123 (node (worker) x) ${fields.join(' ')} 0 0\n`
    expect(parseProcStatStartTicks(stat)).toBe('987654')
    expect(parseProcStatStartTicks('garbage')).toBeUndefined()
  })
})

describe('the system probes on this machine', () => {
  const children: ChildProcess[] = []

  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL')
  })

  it('reads a stable machine identity, and a live child\'s start that keeps it judged alive', async () => {
    expect(systemProbes.machine()).toBe(systemProbes.machine())
    expect(systemProbes.machine()).toMatch(/^[0-9a-f]{32}$/u)
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    children.push(child)
    await new Promise<void>((resolve) => { child.once('spawn', () => { resolve() }) })
    const pid = child.pid as number
    const start = systemProbes.startToken(pid)
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      expect(start).toBeUndefined()
      return
    }
    expect(start).toBeDefined()
    expect(systemProbes.startToken(pid)).toBe(start)
    const recorded = { ...currentRunOwner('s1'), pid, instance: 'child', processStart: start as string }
    expect(ownerProcessState(recorded)).toBe('alive')
  })
})
