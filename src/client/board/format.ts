/**
 * Pure display helpers shared by the board's components: relative time, due-date urgency, activity
 * lines, and the sort comparator.
 *
 * Separated from the components so each one is testable without a DOM, and so two surfaces cannot
 * describe the same value differently — a card and a list row must not disagree about whether a
 * task is overdue.
 *
 * @module @achasoft/dsh-tasks-manager/client/board/format
 */

import type { Task, TaskActivity } from '../../domain/types.ts'
import type { BoardTranslate, SortColumn, SortState } from './contract.ts'

/** Milliseconds in one day, for the due-date and relative-time bands. */
const DAY = 86_400_000

/**
 * Render a timestamp as coarse relative text.
 *
 * Coarse on purpose: a board is read at a glance, and "3 h ago" answers the question a precise
 * timestamp would make the reader do arithmetic for. Anything older than a week reads as a date.
 * @param at - epoch ms of the event.
 * @param now - epoch ms of the render.
 * @param t - translate.
 * @returns the relative text.
 */
export function relativeTime(at: number, now: number, t: BoardTranslate): string {
  const elapsed = Math.max(0, now - at)
  if (elapsed < 60_000) return t('time.now')
  if (elapsed < 3_600_000) return t('time.minutes', { value: Math.floor(elapsed / 60_000) })
  if (elapsed < DAY) return t('time.hours', { value: Math.floor(elapsed / 3_600_000) })
  if (elapsed < DAY * 7) return t('time.days', { value: Math.floor(elapsed / DAY) })
  return toDateText(at)
}

/**
 * Render a duration in the compact form the background panel uses.
 * @param ms - the duration in milliseconds.
 * @returns `12s`, `4m 05s`, or `1h 12m`.
 */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * Render an epoch-ms timestamp as a calendar date.
 * @param at - epoch ms.
 * @returns the `YYYY-MM-DD` date in UTC.
 */
export function toDateText(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

/**
 * Parse a `YYYY-MM-DD` date entry into epoch ms.
 * @param text - the date text; the empty string means "no date".
 * @returns epoch ms at UTC midnight, or `undefined` when the text is blank or not a real date.
 */
export function fromDateText(text: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text.trim())) return undefined
  const at = Date.parse(`${text.trim()}T00:00:00.000Z`)
  return Number.isNaN(at) ? undefined : at
}

/** How urgently a due date reads on a card. */
export type DueTone = 'none' | 'soon' | 'today' | 'overdue'

/** A due date's display text and its urgency. */
export interface DueDisplay {
  /** The text to show. */
  text: string
  /** How urgently it reads, which decides the colour. */
  tone: DueTone
}

/**
 * Describe a card's due date.
 * @param dueAt - epoch ms the card is due, or `undefined`.
 * @param now - epoch ms of the render.
 * @param t - translate.
 * @returns the text and tone, or `undefined` when the card has no due date.
 */
export function describeDue(dueAt: number | undefined, now: number, t: BoardTranslate): DueDisplay | undefined {
  if (dueAt === undefined) return undefined
  // Compared by calendar day rather than by elapsed milliseconds: a task due today is due today all
  // day, not for the number of hours left in it.
  const dueDay = Math.floor(dueAt / DAY)
  const today = Math.floor(now / DAY)
  if (dueDay < today) return { text: t('card.overdue', { days: today - dueDay }), tone: 'overdue' }
  if (dueDay === today) return { text: t('card.dueToday'), tone: 'today' }
  return {
    text: t('card.due', { date: toDateText(dueAt) }),
    tone: dueDay - today <= 2 ? 'soon' : 'none',
  }
}

/**
 * Render one history entry as a sentence.
 * @param entry - the history entry.
 * @param t - translate.
 * @returns the line shown in the activity timeline.
 */
export function describeActivity(entry: TaskActivity, t: BoardTranslate): string {
  const key = `activity.${entry.kind}` as Parameters<BoardTranslate>[0]
  return t(key, { from: entry.from ?? '—', to: entry.to ?? '—' })
}

/**
 * Compare two cards on one column, for the list view's sort.
 * @param a - the first card.
 * @param b - the second card.
 * @param column - the column being sorted on.
 * @returns a negative, zero, or positive ordering.
 */
function compareOn(a: Task, b: Task, column: SortColumn): number {
  switch (column) {
    case 'ref':
      return a.ref - b.ref
    case 'title':
      return a.title.localeCompare(b.title)
    case 'status':
      return STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
    case 'priority':
      return PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority)
    case 'assignee':
      return (a.assignee ?? '￿').localeCompare(b.assignee ?? '￿')
    case 'dueAt':
      // Cards with no due date sort last in both directions: an absent date is not "very early",
      // and letting it act like one buries the dated cards the reader sorted to find.
      return (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER)
    case 'updatedAt':
      return a.updatedAt - b.updatedAt
    default:
      return 0
  }
}

/** Board order of the columns, so a status sort reads left to right. */
const STATUS_ORDER = ['backlog', 'todo', 'in_progress', 'blocked', 'done'] as const
/** Descending urgency, so a priority sort puts the pressing work first. */
const PRIORITY_ORDER = ['urgent', 'high', 'normal', 'low'] as const

/**
 * Sort cards for the list view.
 *
 * Ties break on `ref` so the order is total: two cards with the same status and no other difference
 * would otherwise swap places between renders, which reads as the list flickering.
 * @param tasks - the cards to sort.
 * @param sort - the column and direction.
 * @returns a new sorted array.
 */
export function sortTasks(tasks: readonly Task[], sort: SortState): Task[] {
  const sign = sort.direction === 'asc' ? 1 : -1
  return [...tasks].sort((a, b) => {
    const primary = compareOn(a, b, sort.column)
    return primary !== 0 ? primary * sign : a.ref - b.ref
  })
}

/**
 * Every label in use across a set of cards.
 * @param tasks - the cards to scan.
 * @returns the labels, sorted and de-duplicated.
 */
export function collectLabels(tasks: readonly Task[]): string[] {
  const labels = new Set<string>()
  for (const task of tasks) {
    for (const label of task.labels) labels.add(label)
  }
  return [...labels].sort()
}

/**
 * How many filters a query has switched on, for the toolbar's badge.
 * @param query - the current filters.
 * @returns the count of active filters.
 */
export function activeFilterCount(query: {
  status?: readonly string[] | undefined
  priority?: readonly string[] | undefined
  labels?: readonly string[] | undefined
  assignee?: string | undefined
  search?: string | undefined
  archived?: string | undefined
}): number {
  let count = 0
  if ((query.status?.length ?? 0) > 0) count++
  if ((query.priority?.length ?? 0) > 0) count++
  if ((query.labels?.length ?? 0) > 0) count++
  if ((query.assignee ?? '') !== '') count++
  if ((query.search ?? '') !== '') count++
  if (query.archived !== undefined && query.archived !== 'active') count++
  return count
}
