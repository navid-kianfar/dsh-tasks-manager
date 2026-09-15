/**
 * Mounting the board's RPC channel on the Host web server.
 *
 * The client half calls `ctx.connection.rpc.call('/dsh-tasks', endpoint, payload)`, which POSTs a
 * `client-request` envelope to `/dsh-tasks/<endpoint>` and expects a `server-response` envelope back.
 * The harness offers `connection.rpc.handle` to serve exactly that, but on the shipped harness it
 * cannot be used from a plugin: it mounts the route inside an effect on the connection service's own
 * context, which does not inject `webServer`, so Cordis throws "cannot get property "webServer"
 * without inject". The throw is swallowed, the route never exists, and every board call falls
 * through to the static fallback's HTTP 405 — a board that looks unable to read its database.
 *
 * So this module mounts the route from the plugin's own context, the way the harness's own
 * open-in-app routes are mounted, and speaks the same envelope. The connection's
 * `requestRejection` is the gate: it is what enforces the Host/Origin fence and the browser token
 * on `/api`, and the board holds nothing a request outside that fence should reach. A harness
 * without `requestRejection` falls back to `rpc.handle` rather than serving an ungated route.
 *
 * @module @achasoft/dsh-tasks-manager/host/channel
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from 'zod'

/** What a channel handler returns: the RPC result the client unwraps. */
export type ChannelResult =
  | { readonly ok: true, readonly value: unknown }
  | { readonly ok: false, readonly error: { readonly code: string, readonly message: string, readonly details: Readonly<Record<string, unknown>> } }

/** Serves one endpoint call. */
export type ChannelHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<ChannelResult>

/** The connection service's request gate, as the shipped harness exposes it. */
interface RequestGate {
  requestRejection?: (request: IncomingMessage) => 401 | 403 | undefined
}

/**
 * The most a board request body may be. Cards, comments, and patches are text; a megabyte is far
 * beyond any of them and still small enough to buffer.
 */
export const MAX_BODY_BYTES = 1024 * 1024

/** One endpoint segment, as the connection's channel grammar allows it. */
const ENDPOINT_SEGMENT = /^[A-Za-z0-9_$.-]+$/

/** The client-request envelope `connection.rpc.call` sends. */
const clientRequest = z.object({
  type: z.literal('client-request'),
  rpcId: z.string(),
  method: z.string(),
  payload: z.unknown(),
})

/**
 * The endpoint a request path names under the channel.
 * @param channel - the mounted channel, e.g. `/dsh-tasks`.
 * @param pathname - the request path.
 * @returns the endpoint, or undefined when the path is not a well-formed endpoint of this channel.
 */
export function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT.test(segment))) {
    return undefined
  }
  return endpoint
}

/**
 * Write a plain-text status response.
 * @param res - the response.
 * @param status - HTTP status.
 * @param text - the body.
 */
function plain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

/**
 * Write a server-response envelope.
 * @param res - the response.
 * @param rpcId - the correlation id the client sent.
 * @param result - the endpoint result.
 */
function envelope(res: ServerResponse, rpcId: string, result: ChannelResult): void {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
}

/**
 * Buffer a request body up to the cap.
 * @param req - the request.
 * @returns the body, or undefined when it exceeded {@link MAX_BODY_BYTES}.
 */
async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const declared = req.headers['content-length']
  if (declared !== undefined && Number(declared) > MAX_BODY_BYTES) return undefined
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    received += buffer.byteLength
    if (received > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/**
 * Serve one request on the channel.
 * @param channel - the mounted channel.
 * @param gate - the connection's request gate.
 * @param handler - the endpoint dispatcher.
 * @param req - the request.
 * @param res - the response.
 */
export async function serveChannelRequest(
  channel: string,
  gate: Required<RequestGate>,
  handler: ChannelHandler,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const rejection = gate.requestRejection(req)
  if (rejection !== undefined) {
    plain(res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  const endpoint = endpointFromPath(channel, url.pathname)
  if (req.method !== 'POST' || endpoint === undefined) {
    plain(res, 404, 'not found')
    return
  }
  const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    plain(res, 415, 'content type must be application/json')
    return
  }
  const body = await readBody(req)
  if (body === undefined) {
    res.writeHead(413, { connection: 'close' })
    res.end()
    req.destroy()
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    plain(res, 400, 'body is not JSON')
    return
  }
  const message = clientRequest.safeParse(parsed)
  if (!message.success) {
    const rawId = (parsed as { rpcId?: unknown } | null)?.rpcId
    envelope(res, typeof rawId === 'string' ? rawId : 'invalid-request', {
      ok: false,
      error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: { issues: message.error.issues } },
    })
    return
  }
  if (message.data.method !== endpoint) {
    envelope(res, message.data.rpcId, {
      ok: false,
      error: {
        code: 'gateway/bad-request',
        message: `method ${JSON.stringify(message.data.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
        details: { issues: [] },
      },
    })
    return
  }
  const abort = new AbortController()
  res.on('close', () => { if (!res.writableEnded) abort.abort() })
  let result: ChannelResult
  try {
    result = await handler(endpoint, message.data.payload, abort.signal)
  } catch (error) {
    plain(res, 500, `handler failure: ${String(error)}`)
    return
  }
  if (!res.writableEnded && !res.destroyed) envelope(res, message.data.rpcId, result)
}

/**
 * Mount the channel once the Host has both a web server and a connection, and unmount it with the
 * owning context. A headless deployment has neither, and the inject face simply never runs.
 * @param ctx - the owning plugin context.
 * @param channel - the channel path, e.g. `/dsh-tasks`.
 * @param handler - the endpoint dispatcher.
 */
export function mountChannel(ctx: Context, channel: string, handler: ChannelHandler): void {
  ctx.inject(['connection', 'webServer'], (routeCtx) => {
    // Read through Reflect and typed locally, as the harness's own open-in-app does: the connection's
    // Host half is not part of its published browser-side types.
    const connection = Reflect.get(routeCtx, 'connection') as RequestGate & {
      rpc: { handle: (channel: string, handler: ChannelHandler, options: { authority: 'trusted-host' }) => unknown }
    }
    const webServer = Reflect.get(routeCtx, 'webServer') as {
      register: (route: {
        kind: 'prefix'
        path: string
        handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
      }) => () => void
    }
    if (typeof connection.requestRejection !== 'function') {
      // An older harness without the gate: its own registration path is the only gated one there.
      connection.rpc.handle(channel, handler, { authority: 'trusted-host' })
      return
    }
    const gate = { requestRejection: connection.requestRejection.bind(connection) }
    return webServer.register({
      kind: 'prefix',
      path: channel,
      handler: (req, res) => serveChannelRequest(channel, gate, handler, req, res),
    })
  })
}
