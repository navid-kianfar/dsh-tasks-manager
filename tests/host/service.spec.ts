/**
 * The service as its consumers actually reach it: mounted in a real cordis Context and called
 * through `ctx.tasks`.
 *
 * Every call from another plugin arrives through cordis' service Proxy, and a `#private` field read
 * on that path throws "Cannot read private member from an object whose class did not declare it".
 * The unit tests around `TaskStore` cannot see that — they hold the object directly — so this file
 * exists to exercise the boundary the tools and the RPC router use.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import TasksService, { Config } from '../../src/host/index.ts'
import { currentRunOwner } from '../../src/host/run-owner.ts'
import {
  FakeAgentRegistry,
  FakeJobRegistry,
  FakeSessionStore,
  FakeSettings,
  FakeSubagents,
  settle,
  type PendingRun,
} from './fake-harness.ts'

const roots: string[] = []

/**
 * A throwaway project directory carrying a `.git` marker.
 * @returns its absolute path.
 */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tasks-'))
  mkdirSync(join(root, '.git'), { recursive: true })
  roots.push(root)
  return root
}

/**
 * Mount the service in a bare context, as a deployment without sessions, jobs, or a web server does.
 * @returns the context carrying `ctx.tasks`.
 */
async function mount(): Promise<Context> {
  const ctx = new Context()
  // `{} as never` is the repo's own idiom for "every field takes its schema default"; the schema
  // resolves it, and the declared type describes the resolved value rather than the input.
  const fiber = ctx.plugin(TasksService, new Config({} as never))
  await fiber.await()
  return ctx
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A context composed with every harness service the board's dispatch path reaches. */
interface Harness {
  ctx: Context
  jobs: FakeJobRegistry
  agents: FakeAgentRegistry
  sessions: FakeSessionStore
  subagents: FakeSubagents
  settings: FakeSettings
  /** The project every session in the harness is opened in. */
  root: string
  /** Unload the plugin, as a plugin reload does, and load it again. */
  reload: () => Promise<void>
}

/**
 * Mount the service beside stand-in jobs, agents, sessions, subagents, and settings.
 * @returns the harness.
 */
async function harness(): Promise<Harness> {
  const ctx = new Context()
  const agents = new FakeAgentRegistry()
  const jobs = new FakeJobRegistry(agents)
  const sessions = new FakeSessionStore()
  const subagents = new FakeSubagents()
  const settings = new FakeSettings()
  ctx.provide('agents', agents)
  ctx.provide('jobs', jobs)
  ctx.provide('sessions', sessions)
  ctx.provide('subagents', subagents)
  ctx.provide('settings', settings)
  const config = new Config({ subagentProvider: 'spawn' } as never)
  let fiber = ctx.plugin(TasksService, config)
  await fiber.await()
  const root = project()
  return {
    ctx, jobs, agents, sessions, subagents, settings, root,
    reload: async () => {
      await fiber.dispose()
      fiber = ctx.plugin(TasksService, config)
      await fiber.await()
    },
  }
}

/**
 * Commit a settings change, as any save in the settings card does.
 * @param h - the harness.
 */
function saveSettings(h: Harness): void {
  if (h.settings.hooks === undefined) throw new Error('the service attached no settings section')
  h.settings.hooks.onChange()
}

/**
 * The first subagent run the service started.
 * @param h - the harness.
 * @returns the run.
 */
function firstRun(h: Harness): PendingRun {
  const run = h.subagents.runs[0]
  if (run === undefined) throw new Error('no subagent run was started')
  return run
}

/** A signal nobody aborts, for the dispatch call itself. */
const NEVER = new AbortController().signal

describe('dispatching a card', () => {
  it('records the run\'s output on the card and in the job, without waking the agent for it', async () => {
    const h = await harness()
    h.sessions.add('s1', h.root)
    const agent = h.agents.add('s1')
    const reportedAtSettlement: boolean[] = []
    // What `@deepseek-ai/dsh-tool-jobs` does: a notice for every job not already reported.
    h.jobs.onJobDone((snapshot) => { reportedAtSettlement.push(snapshot.reported) })
    const board = h.ctx.tasks.boardForCwd(h.root)
    const card = board.create({ title: 'fix the parser' }, { actor: 'user' }, Date.now())

    const { jobId, task } = await h.ctx.tasks.dispatch('s1', card.id, undefined, NEVER)
    expect(task.runningJobId).toBe(jobId)
    firstRun(h).finish({ stopReason: 'completed', output: [{ type: 'text', text: 'Changed the parser.' }] })
    await settle()

    const detail = board.detail(card.id)
    expect(detail.task.runningJobId).toBeUndefined()
    expect(detail.task.lastRun?.status).toBe('completed')
    expect(detail.comments.map(comment => comment.body).join('\n')).toContain('Changed the parser.')
    // `job_output` returns the report rather than an empty string.
    expect(h.jobs.read(jobId, agent).text).toBe('Changed the parser.')
    // Reported before listeners ran: no notice, so no model turn opened for an unsolicited result.
    expect(reportedAtSettlement).toEqual([true])
    expect(h.subagents.runs[0]?.disposed()).toBe(true)
  })

  it('carries a failed run\'s diagnostic and partial output', async () => {
    const h = await harness()
    h.sessions.add('s1', h.root)
    h.agents.add('s1')
    const board = h.ctx.tasks.boardForCwd(h.root)
    const card = board.create({ title: 'card' }, { actor: 'user' }, Date.now())

    await h.ctx.tasks.dispatch('s1', card.id, undefined, NEVER)
    firstRun(h).finish({ stopReason: 'error', output: [{ type: 'text', text: 'got halfway' }], diagnostic: 'model unavailable' })
    await settle()

    const detail = board.detail(card.id)
    expect(detail.task.lastRun?.status).toBe('failed')
    expect(detail.task.lastRun?.detail).toContain('model unavailable')
    expect(detail.comments.at(-1)?.body).toContain('got halfway')
  })

  it('settles a run that outlives a settings save, and lets the card be dispatched again', async () => {
    const h = await harness()
    h.sessions.add('s1', h.root)
    h.agents.add('s1')
    const card = h.ctx.tasks.boardForCwd(h.root).create({ title: 'card' }, { actor: 'user' }, Date.now())
    await h.ctx.tasks.dispatch('s1', card.id, undefined, NEVER)

    // Any settings save rebuilds the registry, closing the board the run started on.
    saveSettings(h)
    firstRun(h).finish({ stopReason: 'completed', output: [] })
    await settle()

    const reopened = h.ctx.tasks.boardForCwd(h.root)
    expect(reopened.detail(card.id).task.runningJobId).toBeUndefined()
    expect(reopened.detail(card.id).task.lastRun?.status).toBe('completed')
    await expect(h.ctx.tasks.dispatch('s1', card.id, undefined, NEVER)).resolves.toMatchObject({ jobId: 'task-2' })
  })

  it('settles a run that outlives a plugin reload', async () => {
    const h = await harness()
    h.sessions.add('s1', h.root)
    h.agents.add('s1')
    const card = h.ctx.tasks.boardForCwd(h.root).create({ title: 'card' }, { actor: 'user' }, Date.now())
    await h.ctx.tasks.dispatch('s1', card.id, undefined, NEVER)

    await h.reload()
    // The job registry is a separate service and keeps running the job across the reload.
    firstRun(h).finish({ stopReason: 'completed', output: [{ type: 'text', text: 'done after reload' }] })
    await settle()

    const detail = h.ctx.tasks.boardForCwd(h.root).detail(card.id)
    expect(detail.task.runningJobId).toBeUndefined()
    expect(detail.task.lastRun?.status).toBe('completed')
    expect(detail.comments.at(-1)?.body).toContain('done after reload')
  })

  it('records a lost settlement from the job registry when the board is next opened', async () => {
    const h = await harness()
    h.sessions.add('s1', h.root)
    const agent = h.agents.add('s1')
    const card = h.ctx.tasks.boardForCwd(h.root).create({ title: 'card' }, { actor: 'user' }, Date.now())
    // A run this process owns, settled in the registry, whose settlement never reached the card.
    const job = h.jobs.external('task', agent)
    h.ctx.tasks.boardForCwd(h.root).startRun(card.id, job.id, currentRunOwner('s1'), { actor: 'user' }, Date.now())
    job.settle({ status: 'failed', detail: 'the write was lost' })
    await settle()

    saveSettings(h)
    const reopened = h.ctx.tasks.boardForCwd(h.root)

    expect(reopened.detail(card.id).task.runningJobId).toBeUndefined()
    expect(reopened.detail(card.id).task.lastRun).toMatchObject({ jobId: job.id, status: 'failed', detail: 'the write was lost' })
  })

  it('clears a marker whose owning agent is gone instead of refusing as "already running"', async () => {
    const h = await harness()
    h.sessions.add('s1', h.root)
    h.agents.add('s1')
    const board = h.ctx.tasks.boardForCwd(h.root)
    const card = board.create({ title: 'card' }, { actor: 'user' }, Date.now())
    // Written by this process for a session whose agent has since been disposed — and the registry
    // disposes an owner's jobs with it.
    board.startRun(card.id, 'task-41', currentRunOwner('a-closed-session'), { actor: 'user' }, Date.now())

    const { task } = await h.ctx.tasks.dispatch('s1', card.id, undefined, NEVER)

    expect(task.runningJobId).toBe('task-1')
  })
})

describe('deleting a dispatched card', () => {
  it('stops the run as its owner when the card is deleted from another session', async () => {
    const h = await harness()
    h.sessions.add('s1', h.root)
    h.sessions.add('s2', h.root)
    h.agents.add('s1')
    const other = h.agents.add('s2')
    const board = h.ctx.tasks.boardForCwd(h.root)
    const card = board.create({ title: 'dispatched' }, { actor: 'user' }, Date.now())
    const { jobId } = await h.ctx.tasks.dispatch('s1', card.id, undefined, NEVER)
    // The registry fences the job: session 2 cannot stop it as itself.
    expect(() => h.jobs.kill(jobId, other)).toThrow(/belongs to another session/u)

    h.ctx.tasks.removeTask(board, card.id)

    expect(h.jobs.kills).toEqual([{ id: jobId, caller: 's1', reason: expect.stringContaining('deleted') as unknown as string }])
    expect(h.subagents.runs[0]?.request.signal.aborted).toBe(true)
    expect(board.read().tasks).toEqual([])
    await settle()
    expect(h.jobs.get(jobId, h.agents.get('s1')).status).toBe('killed')
  })

  it('refuses while a run in another live dsh process holds the card', async () => {
    const h = await harness()
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      await new Promise<void>((resolve) => { child.once('spawn', () => { resolve() }) })
      const board = h.ctx.tasks.boardForCwd(h.root)
      const card = board.create({ title: 'worked elsewhere' }, { actor: 'user' }, Date.now())
      board.startRun(card.id, 'task-1', { ...currentRunOwner('s9'), pid: child.pid as number, instance: 'b' }, { actor: 'user' }, Date.now())

      expect(() => { h.ctx.tasks.removeTask(board, card.id) }).toThrow(/another dsh process/u)
      expect(board.read().tasks).toHaveLength(1)
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('deletes an idle card without troubling the registry', async () => {
    const h = await harness()
    const board = h.ctx.tasks.boardForCwd(h.root)
    const card = board.create({ title: 'idle' }, { actor: 'user' }, Date.now())

    h.ctx.tasks.removeTask(board, card.id)

    expect(h.jobs.kills).toEqual([])
    expect(board.read().tasks).toEqual([])
  })

  it('deletes a card whose run can no longer be stopped', async () => {
    const ctx = await mount()
    // No job registry composed at all: the run this process recorded cannot still exist.
    const board = ctx.tasks.boardForCwd(project())
    const card = board.create({ title: 'orphan' }, { actor: 'user' }, Date.now())
    board.startRun(card.id, 'task-9', currentRunOwner('session-1'), { actor: 'user' }, Date.now())

    ctx.tasks.removeTask(board, card.id)

    expect(board.read().tasks).toEqual([])
  })
})

describe('the board\'s job controls', () => {
  it('stops a card\'s run started by another session in this process', async () => {
    const h = await harness()
    h.sessions.add('s1', h.root)
    h.sessions.add('s2', h.root)
    h.agents.add('s1')
    h.agents.add('s2')
    const card = h.ctx.tasks.boardForCwd(h.root).create({ title: 'card' }, { actor: 'user' }, Date.now())
    const { jobId } = await h.ctx.tasks.dispatch('s1', card.id, undefined, NEVER)

    await expect(h.ctx.tasks.killJob('s2', jobId)).resolves.toEqual({ outcome: 'requested' })
    expect(h.jobs.kills.map(kill => kill.caller)).toEqual(['s1'])
  })

  it('still refuses another session\'s job that no card on this board is running', async () => {
    const h = await harness()
    h.sessions.add('s2', h.root)
    const owner = h.agents.add('s1')
    h.agents.add('s2')
    const shell = h.jobs.external('bash', owner)

    await expect(h.ctx.tasks.killJob('s2', shell.id)).rejects.toThrow(/belongs to another session/u)
  })

  it('leaves a stream job\'s output for the agent to read', async () => {
    const h = await harness()
    const agent = h.agents.add('s1')
    const pending = ['line 1\n']
    const shell = h.jobs.external('bash', agent, () => pending.splice(0).join(''))

    const read = h.ctx.tasks.readJob('s1', shell.id)

    expect(read).toMatchObject({ text: '', outputWithheld: true, job: { id: shell.id, status: 'running' } })
    expect(h.jobs.read(shell.id, agent).text).toBe('line 1\n')
  })

  it('reads a finished card run\'s output as often as it is asked', async () => {
    const h = await harness()
    h.sessions.add('s1', h.root)
    h.agents.add('s1')
    const card = h.ctx.tasks.boardForCwd(h.root).create({ title: 'card' }, { actor: 'user' }, Date.now())
    const { jobId } = await h.ctx.tasks.dispatch('s1', card.id, undefined, NEVER)
    firstRun(h).finish({ stopReason: 'completed', output: [{ type: 'text', text: 'report' }] })
    await settle()

    expect(h.ctx.tasks.readJob('s1', jobId).text).toBe('report')
    expect(h.ctx.tasks.readJob('s1', jobId).text).toBe('report')
  })
})

describe('resolving a session that is no longer live', () => {
  it('reads the working directory off the installed snapshot shape, once', async () => {
    const ctx = await mount()
    const root = project()
    const calls: string[] = []
    ctx.provide('sessionPersistence', {
      // `SessionPersistenceSnapshot` on 0.1.5-rc.2: the header is nested.
      stat: (id: string) => {
        calls.push(`stat ${id}`)
        return Promise.resolve(id === 'finished-run'
          ? { header: { id, version: 3, cwd: root }, revision: 'r1', sizeBytes: 10 }
          : undefined)
      },
      list: () => { calls.push('list'); return Promise.resolve([]) },
    })

    const board = await ctx.tasks.boardForSession('finished-run')
    expect(board.databasePath).toBe(join(realpathSync.native(root), '.dsh', 'tasks.db'))
    await ctx.tasks.boardForSession('finished-run')

    expect(calls).toEqual(['stat finished-run'])
  })

  it('backs off a session persistence does not know, rather than asking on every poll', async () => {
    const ctx = await mount()
    const calls: string[] = []
    ctx.provide('sessionPersistence', {
      stat: (id: string) => { calls.push(id); return Promise.resolve(undefined) },
      list: () => Promise.resolve([]),
    })

    await expect(ctx.tasks.boardForSession('gone')).rejects.toThrow(/no working directory/u)
    await expect(ctx.tasks.boardForSession('gone')).rejects.toThrow(/no working directory/u)

    expect(calls).toEqual(['gone'])
  })

  it('fills every session from one listing when the backend has no stat', async () => {
    const ctx = await mount()
    const first = project()
    const second = project()
    let listings = 0
    ctx.provide('sessionPersistence', {
      list: () => {
        listings++
        return Promise.resolve([
          { header: { id: 'a', cwd: first }, revision: 'r' },
          { header: { id: 'b', cwd: second }, revision: 'r' },
        ])
      },
    })

    await ctx.tasks.boardForSession('a')
    await ctx.tasks.boardForSession('b')

    expect(listings).toBe(1)
  })
})

describe('ctx.tasks', () => {
  it('serves a board through the service proxy', async () => {
    const ctx = await mount()
    const root = project()

    // Reached exactly as the tools reach it: a property read off the context, not a held instance.
    const board = ctx.tasks.boardForCwd(root)
    const created = board.create({ title: 'through the proxy' }, { actor: 'agent' }, Date.now())

    expect(created.ref).toBe(1)
    expect(board.read().tasks.map(task => task.title)).toEqual(['through the proxy'])
    expect(board.databasePath).toBe(join(realpathSync.native(root), '.dsh', 'tasks.db'))
  })

  it('roots the board at the marker directory, not the session cwd', async () => {
    const ctx = await mount()
    const root = project()
    const nested = join(root, 'packages', 'deep')
    mkdirSync(nested, { recursive: true })

    expect(ctx.tasks.boardForCwd(nested).databasePath).toBe(join(realpathSync.native(root), '.dsh', 'tasks.db'))
  })

  it('serves one board per project and reuses the open handle', async () => {
    const ctx = await mount()
    const first = project()
    const second = project()

    expect(ctx.tasks.boardForCwd(first)).toBe(ctx.tasks.boardForCwd(first))
    expect(ctx.tasks.boardForCwd(first)).not.toBe(ctx.tasks.boardForCwd(second))
  })

  it('refuses a session with no working directory', async () => {
    const ctx = await mount()
    expect(() => ctx.tasks.boardForCwd(undefined)).toThrow(/no working directory/u)
  })

  it('exposes the deployment settings the browser polls with', async () => {
    const ctx = await mount()
    expect(ctx.tasks.settings.databasePath).toBe('.dsh/tasks.db')
    expect(ctx.tasks.settings.pollIntervalMs).toBeGreaterThan(0)
  })

  it('lists no background jobs when no registry is composed', async () => {
    const ctx = await mount()
    expect(ctx.tasks.listJobs('s1')).toEqual([])
  })

  it('orders outstanding work by urgency for the model', async () => {
    const ctx = await mount()
    const board = ctx.tasks.boardForCwd(project())
    board.create({ title: 'later', priority: 'low' }, { actor: 'agent' }, 1)
    board.create({ title: 'now', priority: 'urgent', status: 'in_progress' }, { actor: 'agent' }, 2)
    board.create({ title: 'finished', status: 'done' }, { actor: 'agent' }, 3)

    expect(board.outstanding(ctx.tasks.settings.digestSize).map(task => task.title))
      .toEqual(['now', 'later'])
  })
})
