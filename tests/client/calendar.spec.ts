/**
 * The due-date picker's month arithmetic.
 *
 * All of it is UTC and all of it is text, which is the point: the day the grid draws and the day
 * the store writes must be the same day for every reader, whatever their clock says.
 */

import { describe, expect, it } from 'vitest'
import {
  CALENDAR_COLUMNS,
  CALENDAR_ROWS,
  addDays,
  addMonths,
  dayText,
  dayValue,
  monthGrid,
  monthLabel,
  monthOf,
  shiftMonth,
  weekStartFor,
  weekdayLabels,
} from '../../src/client/board/calendar.ts'

describe('day text', () => {
  it('round-trips a calendar day through UTC midnight', () => {
    const at = dayValue('2026-03-09')
    expect(at).toBe(Date.UTC(2026, 2, 9))
    expect(dayText(at as number)).toBe('2026-03-09')
  })

  it('refuses text that is not a calendar day', () => {
    expect(dayValue('2026-3-9')).toBeUndefined()
    expect(dayValue('2026-13-01')).toBeUndefined()
    expect(dayValue('')).toBeUndefined()
  })

  it('reads a late-evening instant as its UTC day, not the local one', () => {
    // The bug this rules out: a reader west of Greenwich seeing the cell before the one the store
    // holds, because the grid asked the local clock what day it was.
    expect(dayText(Date.UTC(2026, 2, 9, 23, 30))).toBe('2026-03-09')
  })
})

describe('month navigation', () => {
  it('carries the year in both directions', () => {
    expect(addMonths({ year: 2026, month: 11 }, 1)).toEqual({ year: 2027, month: 0 })
    expect(addMonths({ year: 2026, month: 0 }, -1)).toEqual({ year: 2025, month: 11 })
    expect(addMonths({ year: 2026, month: 5 }, -18)).toEqual({ year: 2024, month: 11 })
  })

  it('opens on the chosen day, and on today when there is none', () => {
    expect(monthOf('2026-03-09', 0)).toEqual({ year: 2026, month: 2 })
    expect(monthOf(undefined, Date.UTC(2026, 7, 30))).toEqual({ year: 2026, month: 7 })
    expect(monthOf('nonsense', Date.UTC(2026, 7, 30))).toEqual({ year: 2026, month: 7 })
  })

  it('steps a day across a month boundary', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2026-03-04', 7)).toBe('2026-03-11')
  })

  it('clamps a paged day to the length of the month it lands in', () => {
    expect(shiftMonth('2026-01-31', 1)).toBe('2026-02-28')
    expect(shiftMonth('2024-01-31', 1)).toBe('2024-02-29')
    expect(shiftMonth('2026-03-31', -1)).toBe('2026-02-28')
    expect(shiftMonth('2026-03-15', 1)).toBe('2026-04-15')
  })
})

describe('monthGrid', () => {
  it('always fills six whole weeks, so the popover keeps its height', () => {
    for (const month of [{ year: 2026, month: 1 }, { year: 2026, month: 4 }, { year: 2027, month: 7 }]) {
      expect(monthGrid(month, 1)).toHaveLength(CALENDAR_ROWS * CALENDAR_COLUMNS)
    }
  })

  it('pads the lead-in from the previous month and marks it as outside', () => {
    // 1 March 2026 is a Sunday, so a Monday-first week leads in with six days of February.
    const cells = monthGrid({ year: 2026, month: 2 }, 1)
    expect(cells[0]?.date).toBe('2026-02-23')
    expect(cells[0]?.inMonth).toBe(false)
    expect(cells[6]).toEqual({ date: '2026-03-01', day: 1, inMonth: true })
  })

  it('starts the week where the caller says', () => {
    const sundayFirst = monthGrid({ year: 2026, month: 2 }, 0)
    expect(sundayFirst[0]).toEqual({ date: '2026-03-01', day: 1, inMonth: true })
  })

  it('holds every day of the month exactly once', () => {
    const days = monthGrid({ year: 2026, month: 1 }, 1).filter(cell => cell.inMonth).map(cell => cell.day)
    expect(days).toEqual(Array.from({ length: 28 }, (_, index) => index + 1))
  })
})

describe('locale', () => {
  it('starts the week where each locale does', () => {
    expect(weekStartFor('en-US')).toBe(0)
    expect(weekStartFor('zh-CN')).toBe(1)
    expect(weekStartFor('de')).toBe(1)
  })

  it('labels the seven columns in the locale, in its own order', () => {
    const labels = weekdayLabels('en-US', 0)
    expect(labels).toHaveLength(CALENDAR_COLUMNS)
    expect(labels[0]).toBe('S')

    expect(weekdayLabels('en-US', 1)[0]).toBe('M')
  })

  it('names the month in the locale', () => {
    expect(monthLabel('en-US', { year: 2026, month: 2 })).toBe('March 2026')
  })

  it('falls back to the ISO day rather than throwing on a malformed tag', () => {
    // `<html lang>` is not this module's value to trust, and a render must not be where it fails.
    expect(monthLabel('not a tag', { year: 2026, month: 2 })).toBe('2026-03-01')
  })
})
