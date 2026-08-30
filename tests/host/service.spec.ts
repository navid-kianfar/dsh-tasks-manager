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
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import TasksService, { Config } from '../../src/host/index.ts'

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

/**
 * A stand-in job registry, recording what was asked to stop.
 *
 * The real one lives in `@deepseek-ai/dsh-jobs`, which this package does not depend on: the service
 * reaches it through `ctx.get('jobs')` precisely so a deployment without it still works, and that
 * seam is what a test can stand in at.
 */
function jobRegistry(): { killed: string[]; kill: (jobId: string) => { outcome: string } } {
  const killed: string[] = []
  return {
    killed,
    kill: (jobId: string) => {
      killed.push(jobId)
      return { outcome: 'requested' }
    },
  }
}

describe('deleting a dispatched card', () => {
  it('stops the run working it before the row goes', async () => {
    const ctx = await mount()
    const jobs = jobRegistry()
    ctx.provide('jobs', jobs)
    const board = ctx.tasks.boardForCwd(project())
    const card = board.create({ title: 'dispatched' }, { actor: 'user' }, Date.now())
    board.startRun(card.id, 'task-9', { actor: 'user' }, Date.now())

    ctx.tasks.removeTask(board, card.id, 'session-1')

    // The subagent is stopped, not left running against a task nobody can see any more.
    expect(jobs.killed).toEqual(['task-9'])
    expect(board.read().tasks).toEqual([])
  })

  it('deletes an idle card without troubling the registry', async () => {
    const ctx = await mount()
    const jobs = jobRegistry()
    ctx.provide('jobs', jobs)
    const board = ctx.tasks.boardForCwd(project())
    const card = board.create({ title: 'idle' }, { actor: 'user' }, Date.now())

    ctx.tasks.removeTask(board, card.id, 'session-1')

    expect(jobs.killed).toEqual([])
    expect(board.read().tasks).toEqual([])
  })

  it('still deletes the card when the run cannot be stopped', async () => {
    const ctx = await mount()
    // No job registry composed at all: the kill is impossible, and refusing the delete over it
    // would be the wrong trade.
    const board = ctx.tasks.boardForCwd(project())
    const card = board.create({ title: 'orphan' }, { actor: 'user' }, Date.now())
    board.startRun(card.id, 'task-9', { actor: 'user' }, Date.now())

    ctx.tasks.removeTask(board, card.id, 'session-1')

    expect(board.read().tasks).toEqual([])
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
    expect(board.databasePath).toBe(join(root, '.dsh', 'tasks.db'))
  })

  it('roots the board at the marker directory, not the session cwd', async () => {
    const ctx = await mount()
    const root = project()
    const nested = join(root, 'packages', 'deep')
    mkdirSync(nested, { recursive: true })

    expect(ctx.tasks.boardForCwd(nested).databasePath).toBe(join(root, '.dsh', 'tasks.db'))
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
