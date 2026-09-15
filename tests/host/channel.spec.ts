/**
 * The board's RPC channel, mounted in real Cordis against stand-ins shaped like the harness's own
 * web server and connection, and driven over real HTTP with the envelope the client sends.
 *
 * The harness's `connection.rpc.handle` cannot mount a route for a plugin on the shipped harness
 * (it reads `webServer` from a context that does not inject it), so the board used to answer every
 * call with the static fallback's HTTP 405. These tests pin the replacement: the route exists, it
 * speaks the connection envelope, and the connection's gate still guards it.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context, Service } from '@deepseek-ai/cordis'
import TasksService, { Config } from '../../src/host/index.ts'
import { TASKS_RPC_CHANNEL } from '../../src/host/protocol.ts'
import { MAX_BODY_BYTES, endpointFromPath } from '../../src/host/channel.ts'

interface Route {
  readonly kind: 'prefix' | 'exact'
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
}

/** The route table and longest-prefix dispatch of `@deepseek-ai/dsh-host-webserver`. */
class FakeWebServer extends Service {
  readonly prefixes = new Map<string, Route>()

  constructor(ctx: Context) {
    super(ctx, 'webServer')
  }

  register(route: Route): () => void {
    if (this.prefixes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
    this.prefixes.set(route.path, route)
    return () => { this.prefixes.delete(route.path) }
  }

  dispatch(req: IncomingMessage, res: ServerResponse): void {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    let best: Route | undefined
    for (const [prefix, route] of this.prefixes) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
      if (best === undefined || prefix.length > best.path.length) best = route
    }
    if (best === undefined) {
      // The static fallback: what every board call used to get.
      res.writeHead(405)
      res.end()
      return
    }
    void best.handler(req, res)
  }
}

/** The connection's request gate: a request without the token header is unauthorized. */
class FakeConnection extends Service {
  constructor(ctx: Context) {
    super(ctx, 'connection')
  }

  requestRejection(req: IncomingMessage): 401 | 403 | undefined {
    return req.headers['x-test-token'] === 'ok' ? undefined : 401
  }
}

const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

/**
 * Compose the plugin with a web server and connection, and serve the route table over HTTP.
 * @returns the base URL and the composed context.
 */
async function serve(): Promise<{ base: string, ctx: Context }> {
  const ctx = new Context()
  await ctx.plugin(FakeWebServer).await()
  await ctx.plugin(FakeConnection).await()
  const fiber = ctx.plugin(TasksService, new Config({} as never))
  await fiber.await()
  cleanup.push(() => fiber.dispose())
  const web = ctx.get('webServer') as unknown as FakeWebServer
  const server: Server = createServer((req, res) => { web.dispatch(req, res) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  cleanup.push(() => new Promise<void>((resolve) => { server.close(() => { resolve() }) }))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ctx }
}

/**
 * POST one client-request envelope, as `connection.rpc.call` does.
 * @param base - server base URL.
 * @param endpoint - the endpoint.
 * @param payload - the payload.
 * @param init - header and body overrides.
 * @returns the response.
 */
function call(base: string, endpoint: string, payload: unknown, init: { token?: string, method?: string, body?: string } = {}): Promise<Response> {
  return fetch(`${base}${TASKS_RPC_CHANNEL}/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-token': init.token ?? 'ok' },
    body: init.body ?? JSON.stringify({ type: 'client-request', rpcId: 'r1', method: init.method ?? endpoint, payload }),
  })
}

describe('the /dsh-tasks channel', () => {
  it('is mounted, and answers a call with the connection envelope instead of 405', async () => {
    const { base, ctx } = await serve()
    expect([...(ctx.get('webServer') as unknown as FakeWebServer).prefixes.keys()]).toContain(TASKS_RPC_CHANNEL)

    // No job registry is composed, so the listing succeeds with nothing in it.
    const response = await call(base, 'jobs.list', { sessionId: 's1' })
    expect(response.status).toBe(200)
    const body = await response.json() as { type: string, rpcId: string, result: { ok: boolean } }
    expect(body.type).toBe('server-response')
    expect(body.rpcId).toBe('r1')
    expect(body.result.ok).toBe(true)
  })

  it('carries an endpoint failure as a result, not a transport error', async () => {
    const { base } = await serve()
    const response = await call(base, 'task.detail', { sessionId: 'no-such-session', taskId: 'nope' })
    expect(response.status).toBe(200)
    const body = await response.json() as { result: { ok: boolean, error?: { code: string } } }
    expect(body.result.ok).toBe(false)
    expect(body.result.error?.code).toBeTypeOf('string')
  })

  it('refuses a request the connection gate rejects', async () => {
    const { base } = await serve()
    expect((await call(base, 'settings.read', {}, { token: 'wrong' })).status).toBe(401)
  })

  it('refuses malformed calls the way the connection transport does', async () => {
    const { base } = await serve()
    expect((await fetch(`${base}${TASKS_RPC_CHANNEL}/settings.read`, { method: 'GET', headers: { 'x-test-token': 'ok' } })).status).toBe(404)
    expect((await call(base, 'settings.read', {}, { body: 'not json' })).status).toBe(400)
    const mismatch = await (await call(base, 'settings.read', {}, { method: 'board.read' })).json() as { result: { error: { code: string } } }
    expect(mismatch.result.error.code).toBe('gateway/bad-request')
    // An oversized body is cut off mid-upload, as the connection transport does: either the 413
    // arrives first or the client sees the socket close while it is still writing.
    const oversized = await call(base, 'settings.read', {}, { body: 'x'.repeat(MAX_BODY_BYTES + 1) }).then(r => r.status, () => 'reset')
    expect([413, 'reset']).toContain(oversized)
  })

  it('unmounts with the plugin', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeWebServer).await()
    await ctx.plugin(FakeConnection).await()
    const fiber = ctx.plugin(TasksService, new Config({} as never))
    await fiber.await()
    await fiber.dispose()
    expect((ctx.get('webServer') as unknown as FakeWebServer).prefixes.has(TASKS_RPC_CHANNEL)).toBe(false)
  })

  it('still loads the board service in a headless deployment with no web server', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeConnection).await()
    const fiber = ctx.plugin(TasksService, new Config({} as never))
    await fiber.await()
    cleanup.push(() => fiber.dispose())
    expect(ctx.get('tasks')).toBeDefined()
  })
})

describe('endpointFromPath', () => {
  it('accepts dotted endpoints and refuses traversal and foreign channels', () => {
    expect(endpointFromPath('/dsh-tasks', '/dsh-tasks/board.read')).toBe('board.read')
    expect(endpointFromPath('/dsh-tasks', '/dsh-tasks/../api')).toBeUndefined()
    expect(endpointFromPath('/dsh-tasks', '/dsh-tasks/')).toBeUndefined()
    expect(endpointFromPath('/dsh-tasks', '/dsh-tasksx/board.read')).toBeUndefined()
  })
})
