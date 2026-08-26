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
