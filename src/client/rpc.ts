/**
 * The browser's typed caller for this plugin's RPC channel.
 *
 * `ctx.connection.rpc.call` is generic — it validates the transport envelope and hands back
 * `RpcResult<unknown>`. This module is the one place that narrows it: every endpoint's request and
 * result come from the shared `TasksRpcMap`, so a typo in an endpoint name or a payload field is a
 * compile error on this side and on the host's dispatch table alike.
 *
 * @module @achasoft/dsh-tasks-manager/client/rpc
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import {
  TASKS_RPC_CHANNEL,
  type TasksRpcEndpoint,
  type TasksRpcRequest,
  type TasksRpcResult,
} from '../host/protocol.ts'

/**
 * A refused call, carrying the host's own message.
 *
 * `retryable` separates the two cases the board reacts to differently: a card that has moved out
 * from under the user is worth re-reading the board for, while a validation message belongs in
 * front of the control that produced it.
 */
export class TasksApiError extends Error {
  /**
   * @param message - the host's message, written for the person reading it.
   * @param code - the wire error code.
   */
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'TasksApiError'
  }

  /** Whether re-reading the board is likely to resolve what went wrong. */
  get retryable(): boolean {
    return this.code === 'bad-request'
  }
}

/** Every board operation the browser can perform, one method per endpoint. */
export interface TasksApi {
  /**
   * Call one endpoint on this plugin's channel.
   * @param endpoint - the endpoint name.
   * @param request - its request payload.
   * @param signal - cancellation for an abandoned call.
   * @returns the endpoint's result.
   * @throws TasksApiError when the host refused the call.
   */
  call<E extends TasksRpcEndpoint>(
    endpoint: E,
    request: TasksRpcRequest<E>,
    signal?: AbortSignal,
  ): Promise<TasksRpcResult<E>>
}

/**
 * Bind the board API to a client context.
 * @param ctx - the client context carrying `ctx.connection`.
 * @returns the typed caller.
 */
export function createTasksApi(ctx: ClientContext): TasksApi {
  // The browser's Connection is not declared on `Context` (only the Host half merges that key), so
  // every consumer narrows it at the injection point — the same line ui-workspace uses.
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  return {
    async call(endpoint, request, signal) {
      const result = await connection.rpc.call(TASKS_RPC_CHANNEL, endpoint, request, signal)
      if (!result.ok) throw new TasksApiError(result.error.message, result.error.code)
      return result.value as TasksRpcResult<typeof endpoint>
    },
  }
}
