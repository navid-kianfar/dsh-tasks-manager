/**
 * The one shape the session checklist is read as.
 *
 * Restated here rather than imported from `@deepseek-ai/dsh-tool-todo` so the presentational layer
 * stays free of harness imports and can be rendered in a test with plain data. The container reads
 * the real `todos` projection and passes it straight through; a mismatch would be a compile error
 * there, which is where it belongs.
 *
 * @module @achasoft/dsh-tasks-manager/client/board/session-todo
 */

/** One step of the current session's checklist, as `todo_write` records it. */
export interface SessionTodo {
  /** What the step is — a short imperative line. */
  content: string
  /** Whether it is waiting, being worked now, or finished. */
  status: 'pending' | 'in_progress' | 'completed'
}
