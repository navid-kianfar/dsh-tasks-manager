/**
 * Normalisation and validation for every task value that arrives from outside this process — model
 * tool JSON on one side, browser RPC on the other. Both are untrusted wire boundaries, so both go
 * through here before anything reaches SQLite.
 *
 * Normalising and validating are one pass on purpose: "is this title acceptable" and "what exactly
 * gets stored" must not be able to disagree. Every function returns the canonical value or throws
 * {@link TaskValidationError}, whose message is written to be read by whoever sent the bad value —
 * a model reading a tool error, or a person reading a toast.
 *
 * @module @achasoft/dsh-tasks-manager/domain/validate
 */

import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  TaskId,
  type TaskPriority,
  type TaskStatus,
} from './types.ts'

/** Longest accepted card title, in characters. */
export const MAX_TITLE_LENGTH = 200
/** Longest accepted card body, in characters. */
export const MAX_BODY_LENGTH = 20_000
/** Longest accepted comment, in characters. */
export const MAX_COMMENT_LENGTH = 20_000
/** Longest accepted label, in characters. */
export const MAX_LABEL_LENGTH = 40
/** Most labels one card may carry. */
export const MAX_LABELS = 20
/** Longest accepted assignee name, in characters. */
export const MAX_ASSIGNEE_LENGTH = 80
/** Most cards one board read returns when the caller names no limit. */
export const DEFAULT_QUERY_LIMIT = 500
/** Hard ceiling on a board read, whatever limit the caller names. */
export const MAX_QUERY_LIMIT = 2000

/**
 * A rejected value from a model or the browser. Carried as its own class so the tool layer can
 * turn it into a model-readable error while letting genuine faults propagate as faults.
 */
export class TaskValidationError extends Error {
  /**
   * @param message - what was wrong, phrased for whoever sent the value.
   */
  constructor(message: string) {
    super(message)
    this.name = 'TaskValidationError'
  }
}

/**
 * Collapse runs of whitespace in a single-line field and trim the ends, so a title pasted out of a
 * document does not store embedded newlines that the board then has to render.
 * @param value - the raw text.
 * @returns the collapsed text.
 */
function collapse(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

/**
 * Validate a required card title.
 * @param value - the raw title.
 * @returns the trimmed, whitespace-collapsed title.
 * @throws TaskValidationError when it is empty or too long.
 */
export function parseTitle(value: string): string {
  const title = collapse(value)
  if (title === '') throw new TaskValidationError('a task title cannot be empty')
  if (title.length > MAX_TITLE_LENGTH) {
    throw new TaskValidationError(`a task title cannot exceed ${MAX_TITLE_LENGTH} characters (got ${title.length})`)
  }
  return title
}

/**
 * Validate a card body. Interior formatting is preserved — the body is Markdown — so only the ends
 * are trimmed.
 * @param value - the raw body.
 * @returns the trimmed body, possibly empty.
 * @throws TaskValidationError when it is too long.
 */
export function parseBody(value: string): string {
  const body = value.trim()
  if (body.length > MAX_BODY_LENGTH) {
    throw new TaskValidationError(`a task body cannot exceed ${MAX_BODY_LENGTH} characters (got ${body.length})`)
  }
  return body
}

/**
 * Validate a comment body.
 * @param value - the raw comment.
 * @returns the trimmed comment.
 * @throws TaskValidationError when it is empty or too long.
 */
export function parseComment(value: string): string {
  const body = value.trim()
  if (body === '') throw new TaskValidationError('a comment cannot be empty')
  if (body.length > MAX_COMMENT_LENGTH) {
    throw new TaskValidationError(`a comment cannot exceed ${MAX_COMMENT_LENGTH} characters (got ${body.length})`)
  }
  return body
}

/**
 * Validate a status name.
 * @param value - the raw status.
 * @returns the status.
 * @throws TaskValidationError when it is not one of the board's columns.
 */
export function parseStatus(value: string): TaskStatus {
  const found = TASK_STATUSES.find(status => status === value)
  if (found === undefined) {
    throw new TaskValidationError(`unknown status ${JSON.stringify(value)}; expected one of ${TASK_STATUSES.join(', ')}`)
  }
  return found
}

/**
 * Validate a priority name.
 * @param value - the raw priority.
 * @returns the priority.
 * @throws TaskValidationError when it is not a known priority.
 */
export function parsePriority(value: string): TaskPriority {
  const found = TASK_PRIORITIES.find(priority => priority === value)
  if (found === undefined) {
    throw new TaskValidationError(`unknown priority ${JSON.stringify(value)}; expected one of ${TASK_PRIORITIES.join(', ')}`)
  }
  return found
}

/**
 * Canonicalise a label set: lowercased, trimmed, de-duplicated, sorted.
 *
 * Sorting is what makes the stored JSON stable, so two callers that set the same labels in
 * different orders produce one row value and one activity entry rather than a spurious change.
 * @param values - the raw labels.
 * @returns the canonical label list.
 * @throws TaskValidationError when a label is empty, too long, or there are too many.
 */
export function parseLabels(values: readonly string[]): string[] {
  const labels = new Set<string>()
  for (const raw of values) {
    const label = collapse(raw).toLowerCase()
    if (label === '') throw new TaskValidationError('a label cannot be empty')
    if (label.length > MAX_LABEL_LENGTH) {
      throw new TaskValidationError(`a label cannot exceed ${MAX_LABEL_LENGTH} characters (got ${JSON.stringify(label)})`)
    }
    labels.add(label)
  }
  if (labels.size > MAX_LABELS) {
    throw new TaskValidationError(`a task cannot carry more than ${MAX_LABELS} labels (got ${labels.size})`)
  }
  return [...labels].sort()
}

/**
 * Validate an assignee name.
 * @param value - the raw name.
 * @returns the collapsed name, or `undefined` when it was blank.
 * @throws TaskValidationError when it is too long.
 */
export function parseAssignee(value: string): string | undefined {
  const assignee = collapse(value)
  if (assignee === '') return undefined
  if (assignee.length > MAX_ASSIGNEE_LENGTH) {
    throw new TaskValidationError(`an assignee cannot exceed ${MAX_ASSIGNEE_LENGTH} characters (got ${assignee.length})`)
  }
  return assignee
}

/**
 * Validate an epoch-millisecond timestamp supplied from outside.
 * @param value - the raw timestamp.
 * @param field - the field name, for the error message.
 * @returns the timestamp.
 * @throws TaskValidationError when it is not a finite, non-negative integer.
 */
export function parseTimestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TaskValidationError(`${field} must be a whole number of milliseconds since the epoch (got ${value})`)
  }
  return value
}

/**
 * Validate a board-read limit.
 * @param value - the requested limit, or `undefined` for the default.
 * @returns the effective limit.
 * @throws TaskValidationError when it is not a positive integer.
 */
export function parseLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_QUERY_LIMIT
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TaskValidationError(`limit must be a positive whole number (got ${value})`)
  }
  return Math.min(value, MAX_QUERY_LIMIT)
}

/**
 * Validate a card id that arrived from outside.
 *
 * Ids this plugin mints are `t_` plus 22 lowercase base-36 characters; anything else could not name
 * a real card, and rejecting it here turns a typo into a clear message rather than an empty result
 * the caller has to interpret.
 * @param value - the raw id.
 * @returns the branded id.
 * @throws TaskValidationError when the id is not well-formed.
 */
export function parseTaskId(value: string): TaskId {
  if (!/^t_[0-9a-z]{22}$/u.test(value)) {
    throw new TaskValidationError(`${JSON.stringify(value)} is not a task id (expected the "t_…" form shown on each card)`)
  }
  return TaskId(value)
}

/**
 * Validate a comment id that arrived from outside.
 * @param value - the raw id.
 * @returns the raw id, once its form is known good.
 * @throws TaskValidationError when the id is not well-formed.
 */
export function parseCommentIdText(value: string): string {
  if (!/^c_[0-9a-z]{22}$/u.test(value)) {
    throw new TaskValidationError(`${JSON.stringify(value)} is not a comment id`)
  }
  return value
}
