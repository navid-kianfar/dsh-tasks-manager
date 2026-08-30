/**
 * Calendar arithmetic for the due-date picker, in UTC and in `YYYY-MM-DD` text.
 *
 * UTC throughout, deliberately. A due date on this board is a calendar day, not an instant: the
 * store keeps it as epoch ms at UTC midnight and every reader renders it back with `toISOString`.
 * Doing the grid in local time would make the day under the cursor and the day written to the
 * database disagree by one for every reader west of Greenwich after 16:00.
 *
 * Pure text and numbers, no DOM: the picker's month arithmetic is the part worth testing, and it
 * tests without a browser.
 *
 * @module @achasoft/dsh-tasks-manager/client/board/calendar
 */

/** Milliseconds in one day. */
const DAY = 86_400_000

/** Rows in the grid. Fixed at six so the popover does not change height between months. */
export const CALENDAR_ROWS = 6

/** Days in a row. */
export const CALENDAR_COLUMNS = 7

/** One cell of the month grid. */
export interface CalendarDay {
  /** The day as `YYYY-MM-DD`, which is also what the picker commits. */
  date: string
  /** Day of the month, as drawn. */
  day: number
  /** Whether the cell belongs to the month being shown, rather than its padding. */
  inMonth: boolean
}

/** A month, as the picker navigates them. */
export interface CalendarMonth {
  /** Full year. */
  year: number
  /** Month index, `0` for January. */
  month: number
}

/**
 * Render an epoch-ms instant as its UTC calendar day.
 * @param at - epoch ms.
 * @returns the `YYYY-MM-DD` day.
 */
export function dayText(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

/**
 * Parse a `YYYY-MM-DD` day into epoch ms at UTC midnight.
 * @param date - the day text.
 * @returns epoch ms, or `undefined` when the text is not a real calendar day.
 */
export function dayValue(date: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return undefined
  const at = Date.parse(`${date}T00:00:00.000Z`)
  return Number.isNaN(at) ? undefined : at
}

/**
 * The month a day belongs to.
 * @param date - a `YYYY-MM-DD` day, or `undefined`.
 * @param fallback - epoch ms to fall back on when the day is absent or unparseable.
 * @returns the month to open the picker on.
 */
export function monthOf(date: string | undefined, fallback: number): CalendarMonth {
  const at = date === undefined ? undefined : dayValue(date)
  const on = new Date(at ?? fallback)
  return { year: on.getUTCFullYear(), month: on.getUTCMonth() }
}

/**
 * Step a month forward or back, carrying the year.
 * @param from - the month to step from.
 * @param delta - months to add; negative steps back.
 * @returns the resulting month.
 */
export function addMonths(from: CalendarMonth, delta: number): CalendarMonth {
  const total = from.year * 12 + from.month + delta
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 }
}

/**
 * Step a day forward or back.
 * @param date - the `YYYY-MM-DD` day to step from.
 * @param delta - days to add; negative steps back.
 * @returns the resulting day, or the original text when it was not a real day.
 */
export function addDays(date: string, delta: number): string {
  const at = dayValue(date)
  return at === undefined ? date : dayText(at + delta * DAY)
}

/**
 * Step a day by whole months, clamping to the target month's length.
 *
 * The 31st of January paged forward is the 28th of February, not the 3rd of March: paging a
 * calendar moves the month, and a day that does not exist in the new one lands on its last.
 * @param date - the `YYYY-MM-DD` day to step from.
 * @param delta - months to add; negative steps back.
 * @returns the resulting day, or the original text when it was not a real day.
 */
export function shiftMonth(date: string, delta: number): string {
  const at = dayValue(date)
  if (at === undefined) return date
  const on = new Date(at)
  const target = addMonths({ year: on.getUTCFullYear(), month: on.getUTCMonth() }, delta)
  // Day 0 of the following month is the last day of this one.
  const last = new Date(Date.UTC(target.year, target.month + 1, 0)).getUTCDate()
  return dayText(Date.UTC(target.year, target.month, Math.min(on.getUTCDate(), last)))
}

/**
 * Build one month's grid, padded to whole weeks on both sides.
 *
 * Always {@link CALENDAR_ROWS} rows: a month that fits in five would otherwise make the popover
 * shorter, and a picker that changes height as you page through it is hard to aim at.
 * @param month - the month to lay out.
 * @param weekStartsOn - the weekday the row begins on, `0` for Sunday.
 * @returns 42 cells, in reading order.
 */
export function monthGrid(month: CalendarMonth, weekStartsOn: number): CalendarDay[] {
  const first = Date.UTC(month.year, month.month, 1)
  const lead = (new Date(first).getUTCDay() - weekStartsOn + CALENDAR_COLUMNS) % CALENDAR_COLUMNS
  const start = first - lead * DAY
  const cells: CalendarDay[] = []
  for (let index = 0; index < CALENDAR_ROWS * CALENDAR_COLUMNS; index++) {
    const at = new Date(start + index * DAY)
    cells.push({
      date: dayText(at.getTime()),
      day: at.getUTCDate(),
      inMonth: at.getUTCMonth() === month.month && at.getUTCFullYear() === month.year,
    })
  }
  return cells
}

/**
 * The weekday a locale's week begins on.
 *
 * `Intl.Locale.prototype.getWeekInfo` would answer this properly, but it is not in every engine the
 * Web Client runs in, so a small table stands in. Getting it wrong shifts the columns; it never
 * changes which day a cell commits.
 * @param locale - a BCP 47 tag, as `<html lang>` carries it.
 * @returns `0` for Sunday, `1` for Monday.
 */
export function weekStartFor(locale: string): number {
  const language = locale.toLowerCase().split('-')[0] ?? ''
  // Sunday-first is the minority worldwide but the norm in the two locales this plugin ships, plus
  // the handful most likely to be added next.
  return ['en', 'ja', 'ko', 'pt', 'he', 'ar'].includes(language) ? 0 : 1
}

/**
 * The seven weekday headings, in the locale's own words and its own order.
 * @param locale - a BCP 47 tag.
 * @param weekStartsOn - the weekday the row begins on.
 * @returns the short headings, starting at `weekStartsOn`.
 */
export function weekdayLabels(locale: string, weekStartsOn: number): string[] {
  // 2024-01-07 is a Sunday, so `+ index` walks the week from whichever day starts it.
  const sunday = Date.UTC(2024, 0, 7)
  // Narrow rather than short: seven cells of `Sun`/`Mon` would set the popover's width from its
  // headings instead of from its content.
  const format = safeFormat(locale, { weekday: 'narrow', timeZone: 'UTC' })
  return Array.from({ length: CALENDAR_COLUMNS }, (_, index) =>
    format(sunday + ((weekStartsOn + index) % CALENDAR_COLUMNS) * DAY))
}

/**
 * The month heading, in the locale's own words.
 * @param locale - a BCP 47 tag.
 * @param month - the month being shown.
 * @returns the heading, e.g. `March 2026`.
 */
export function monthLabel(locale: string, month: CalendarMonth): string {
  return safeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' })(
    Date.UTC(month.year, month.month, 1))
}

/**
 * A date formatter that never throws.
 *
 * `Intl.DateTimeFormat` rejects a malformed language tag, and `<html lang>` is a value this module
 * does not own. A picker that renders `2026-03-01` in place of `March 2026` is a blemish; one that
 * throws inside a render takes the board down with it.
 * @param locale - a BCP 47 tag.
 * @param options - the formatting to apply.
 * @returns a function from epoch ms to text.
 */
function safeFormat(locale: string, options: Intl.DateTimeFormatOptions): (at: number) => string {
  try {
    const format = new Intl.DateTimeFormat(locale, options)
    return at => format.format(at)
  } catch {
    return at => dayText(at)
  }
}

/**
 * The locale the surrounding app is being read in.
 *
 * `<html lang>` is set by the harness's locale service on every switch, so reading it here keeps
 * the calendar in step with the rest of the UI without this plugin holding a locale of its own.
 * @returns the BCP 47 tag, falling back to English outside a browser.
 */
export function documentLocale(): string {
  if (typeof document === 'undefined') return 'en'
  const lang = document.documentElement.lang
  return lang === '' ? 'en' : lang
}
