/** The board's display helpers: the pure functions two surfaces must agree on. */

import { describe, expect, it } from 'vitest'
import {
  activeFilterCount,
  collectLabels,
  composerStatus,
  describeActivity,
  describeDue,
  duration,
  fromDateText,
  relativeTime,
  sortTasks,
  toDateText,
} from '../../src/client/board/format.ts'
import { TaskId, type Task, type TaskActivity } from '../../src/domain/types.ts'
import type { BoardTranslate } from '../../src/client/board/contract.ts'

/** A translate that echoes the key and its params, so assertions read as the lookup that happened. */
const t: BoardTranslate = (key, params) =>
  params === undefined ? key : `${key}(${Object.entries(params).map(([k, v]) => `${k}=${String(v)}`).join(',')})`

/** Midnight UTC on 2026-06-15, the reference "now" for the date bands. */
const NOW = Date.parse('2026-06-15T12:00:00.000Z')
/** Milliseconds in a day. */
const DAY = 86_400_000

/**
 * A card with only the fields a given assertion cares about.
 * @param over - fields to override.
 * @returns the card.
 */
function task(over: Partial<Task> = {}): Task {
  return {
    id: TaskId('t_0000000000000000000000'),
    ref: 1,
    title: 'card',
    body: '',
    status: 'backlog',
    priority: 'normal',
    labels: [],
    rank: 'V',
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: 'user',
    ...over,
  }
}

describe('relativeTime', () => {
  it('bands elapsed time and falls back to a date past a week', () => {
    expect(relativeTime(NOW, NOW, t)).toBe('time.now')
    expect(relativeTime(NOW - 30_000, NOW, t)).toBe('time.now')
    expect(relativeTime(NOW - 5 * 60_000, NOW, t)).toBe('time.minutes(value=5)')
    expect(relativeTime(NOW - 3 * 3_600_000, NOW, t)).toBe('time.hours(value=3)')
    expect(relativeTime(NOW - 3 * DAY, NOW, t)).toBe('time.days(value=3)')
    expect(relativeTime(NOW - 30 * DAY, NOW, t)).toBe('2026-05-16')
  })

  it('never reports a negative elapsed time for a clock-skewed future stamp', () => {
    expect(relativeTime(NOW + 60_000, NOW, t)).toBe('time.now')
  })
})

describe('duration', () => {
  it('renders the three magnitudes a job runs for', () => {
    expect(duration(0)).toBe('0s')
    expect(duration(12_400)).toBe('12s')
    expect(duration(245_000)).toBe('4m 05s')
    expect(duration(4_320_000)).toBe('1h 12m')
  })
})

describe('describeDue', () => {
  it('reads a due date by calendar day, not by hours remaining', () => {
    expect(describeDue(undefined, NOW, t)).toBeUndefined()
    // Same calendar day, twelve hours earlier: still due today, not overdue.
    expect(describeDue(Date.parse('2026-06-15T00:00:00.000Z'), NOW, t))
      .toEqual({ text: 'card.dueToday', tone: 'today' })
    expect(describeDue(NOW - 2 * DAY, NOW, t)).toEqual({ text: 'card.overdue(days=2)', tone: 'overdue' })
    expect(describeDue(NOW + DAY, NOW, t)?.tone).toBe('soon')
    expect(describeDue(NOW + 10 * DAY, NOW, t)?.tone).toBe('none')
  })
})

describe('date text', () => {
  it('round-trips a calendar date', () => {
    const at = fromDateText('2026-09-01')
    expect(at).toBeDefined()
    expect(toDateText(at as number)).toBe('2026-09-01')
  })

  it('rejects anything that is not a plain calendar date', () => {
    expect(fromDateText('')).toBeUndefined()
    expect(fromDateText('01/09/2026')).toBeUndefined()
    expect(fromDateText('2026-13-01')).toBeUndefined()
  })
})

describe('describeActivity', () => {
  it('renders an entry through its kind, filling absent sides with a dash', () => {
    const entry: TaskActivity = {
      seq: 1, taskId: TaskId('t_0000000000000000000000'), kind: 'status', actor: 'agent', at: NOW,
      from: 'backlog', to: 'done',
    }
    expect(describeActivity(entry, t)).toBe('activity.status(from=backlog,to=done)')
    expect(describeActivity({ ...entry, kind: 'created', from: undefined, to: undefined }, t))
      .toBe('activity.created(from=—,to=—)')
  })
})

describe('sortTasks', () => {
  it('sorts undated cards last in both directions', () => {
    const dated = task({ ref: 1, dueAt: NOW })
    const undated = task({ ref: 2, id: TaskId('t_1000000000000000000000') })
    expect(sortTasks([undated, dated], { column: 'dueAt', direction: 'asc' }).map(x => x.ref))
      .toEqual([1, 2])
    expect(sortTasks([dated, undated], { column: 'dueAt', direction: 'desc' }).map(x => x.ref))
      .toEqual([2, 1])
  })

  it('orders priority by urgency, not alphabetically', () => {
    const cards = [
      task({ ref: 1, priority: 'low', id: TaskId('t_1000000000000000000000') }),
      task({ ref: 2, priority: 'urgent', id: TaskId('t_2000000000000000000000') }),
      task({ ref: 3, priority: 'normal', id: TaskId('t_3000000000000000000000') }),
    ]
    expect(sortTasks(cards, { column: 'priority', direction: 'asc' }).map(x => x.priority))
      .toEqual(['urgent', 'normal', 'low'])
  })

  it('breaks ties on ref so the order is total', () => {
    const cards = [task({ ref: 9 }), task({ ref: 2, id: TaskId('t_1000000000000000000000') })]
    expect(sortTasks(cards, { column: 'status', direction: 'asc' }).map(x => x.ref)).toEqual([2, 9])
  })

  it('leaves the input array untouched', () => {
    const cards = [task({ ref: 2 }), task({ ref: 1, id: TaskId('t_1000000000000000000000') })]
    sortTasks(cards, { column: 'ref', direction: 'asc' })
    expect(cards.map(x => x.ref)).toEqual([2, 1])
  })
})

describe('collectLabels', () => {
  it('returns every label once, sorted', () => {
    expect(collectLabels([task({ labels: ['b', 'a'] }), task({ labels: ['a', 'c'] })]))
      .toEqual(['a', 'b', 'c'])
  })
})

describe('activeFilterCount', () => {
  it('counts only the filters that actually narrow the board', () => {
    expect(activeFilterCount({})).toBe(0)
    expect(activeFilterCount({ archived: 'active' })).toBe(0)
    expect(activeFilterCount({ status: [] })).toBe(0)
    expect(activeFilterCount({ search: '' })).toBe(0)
    expect(activeFilterCount({ status: ['todo'], search: 'x', archived: 'all' })).toBe(3)
  })
})

describe('composerStatus', () => {
  it('uses the configured default column when no filter narrows the board', () => {
    expect(composerStatus(undefined, 'todo')).toBe('todo')
    expect(composerStatus([], 'in_progress')).toBe('in_progress')
  })

  it('keeps the default when the status filter still shows that column', () => {
    expect(composerStatus(['done', 'todo'], 'todo')).toBe('todo')
  })

  it('lands in a filtered column when the default one is filtered out, so the new card stays in view', () => {
    expect(composerStatus(['blocked', 'done'], 'backlog')).toBe('blocked')
  })

  it('leaves the column to the host while the settings are unread, rather than guessing backlog', () => {
    expect(composerStatus(undefined, undefined)).toBeUndefined()
    expect(composerStatus(['done'], undefined)).toBe('done')
  })
})
