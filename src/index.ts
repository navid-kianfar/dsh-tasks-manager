/**
 * `@achasoft/dsh-tasks-manager` root entry — two roles in one module, because the client module
 * system requires them together.
 *
 * **As a plugin**, this is the task surface's node half. The apply is empty: the browser half ships
 * via `exports["./client"]` and is discovered through the package's `dsh.client` declaration. That
 * discovery resolves `<loader row name>/package.json`, so the row naming this plugin must be the
 * BARE package name — a subpath row resolves nothing and the browser half is silently never served.
 *
 * **As a library**, it re-exports the board's domain vocabulary and the RPC contract, so another
 * plugin can read this one's types without depending on its host implementation.
 *
 * @module @achasoft/dsh-tasks-manager
 */

export type * from './domain/types.ts'
export type * from './host/protocol.ts'
export { TASK_PRIORITIES, TASK_STATUSES, TASK_ACTIVITY_KINDS, TASK_ACTORS } from './domain/types.ts'
export { TASKS_RPC_CHANNEL, TASKS_RPC_ENDPOINTS } from './host/protocol.ts'

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
