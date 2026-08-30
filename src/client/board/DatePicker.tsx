/**
 * The due-date field: a field-shaped trigger over a month calendar.
 *
 * Replaces `<input type="date">`, whose entire interior — the segmented editor, the picker, the
 * indicator glyph — is drawn by the browser. It could not be made to match the board in either
 * theme, and on a dark surface the indicator arrived as a black square on a black field.
 *
 * The grid is a roving-tabindex `grid`: one stop on the way in, then arrows to move, Enter to
 * choose. `Escape` and outside clicks are the popover's business.
 *
 * @module @achasoft/dsh-tasks-manager/client/board/DatePicker
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  IconChevronDownOutline14,
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconCloseFill14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { BoardTranslate } from './contract.ts'
import type { DueTone } from './format.ts'
import {
  CALENDAR_COLUMNS,
  addDays,
  addMonths,
  dayText,
  documentLocale,
  monthGrid,
  monthLabel,
  monthOf,
  shiftMonth,
  weekStartFor,
  weekdayLabels,
  type CalendarMonth,
} from './calendar.ts'
import { Popover } from './Popover.tsx'
import fields from './fields.module.css'
import css from './DatePicker.module.css'

/** Where an arrow key moves the focused day. */
const ARROW_STEPS: Readonly<Record<string, number>> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -CALENDAR_COLUMNS,
  ArrowDown: CALENDAR_COLUMNS,
}

/** Render the due-date field. */
export function DatePicker({ value, onChange, label, placeholder, tone, now = Date.now(), t }: {
  /** The chosen day as `YYYY-MM-DD`, or `undefined` when the card has no due date. */
  value: string | undefined
  /** Called with the new day, or the empty string when the date is cleared. */
  onChange: (date: string) => void
  /** Accessible name for the trigger, since the visible label is a separate `<dt>`. */
  label: string
  /** What the trigger reads as while no date is set. */
  placeholder: string
  /** How urgently the chosen date reads, which colours the trigger's text. */
  tone?: DueTone
  /** Epoch ms of the render, so "today" and the opening month are injectable in a test. */
  now?: number
  /** Translate. */
  t: BoardTranslate
}) {
  const [open, setOpen] = useState(false)
  const [month, setMonth] = useState<CalendarMonth>(() => monthOf(value, now))
  const [focused, setFocused] = useState<string>(() => value ?? dayText(now))
  const seat = useRef<HTMLSpanElement | null>(null)
  const grid = useRef<HTMLDivElement | null>(null)

  const locale = documentLocale()
  const weekStart = weekStartFor(locale)
  const today = dayText(now)
  const days = useMemo(() => monthGrid(month, weekStart), [month, weekStart])
  const weekdays = useMemo(() => weekdayLabels(locale, weekStart), [locale, weekStart])

  // Opening lands on the chosen day — or on today when there is none — rather than wherever the
  // last visit left the month.
  useEffect(() => {
    if (!open) return
    setMonth(monthOf(value, now))
    setFocused(value ?? dayText(now))
  }, [open, value, now])

  // The focused cell only holds the tab stop while the grid already owns focus; moving it into view
  // otherwise would steal focus from the trigger the moment the popover mounted.
  useEffect(() => {
    if (!open) return
    const owned = grid.current?.contains(document.activeElement) === true
    if (!owned) return
    grid.current?.querySelector<HTMLButtonElement>(`[data-date="${focused}"]`)?.focus()
  }, [open, focused])

  /**
   * Commit a day and close.
   * @param date - the `YYYY-MM-DD` day chosen, or the empty string to clear.
   */
  function commit(date: string): void {
    setOpen(false)
    seat.current?.querySelector('button')?.focus()
    onChange(date)
  }

  /**
   * Move the focused day, paging the month when the move leaves it.
   * @param event - the keydown on the grid.
   */
  function onGridKeyDown(event: React.KeyboardEvent): void {
    const step = ARROW_STEPS[event.key]
    if (step !== undefined) {
      event.preventDefault()
      const next = addDays(focused, step)
      setFocused(next)
      setMonth(monthOf(next, now))
      return
    }
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault()
      const next = shiftMonth(focused, event.key === 'PageUp' ? -1 : 1)
      setFocused(next)
      setMonth(monthOf(next, now))
    }
  }

  return (
    <>
      {/* The clear affordance is a sibling of the trigger, not a child: an interactive element
          inside a button is neither valid nor reachable. */}
      <span ref={seat} className={fields.seat}>
        <button
          type="button"
          className={clsx(fields.trigger, value !== undefined && fields.triggerClearable)}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-tone={tone === undefined || tone === 'none' ? undefined : tone}
          onClick={() => { setOpen(current => !current) }}
        >
          <span className={clsx(fields.triggerText, css.value, value === undefined && fields.triggerEmpty)}>
            {value ?? placeholder}
          </span>
          {/* The chevron and the clear affordance share the right edge: whichever the field can
              currently offer is the one drawn there. */}
          {value === undefined && <IconChevronDownOutline14 size={14} className={fields.triggerIcon} />}
        </button>
        {value !== undefined && (
          <button
            type="button"
            className={fields.clear}
            aria-label={t('date.clear')}
            onClick={() => { onChange('') }}
          >
            <IconCloseFill14 size={12} />
          </button>
        )}
      </span>

      <Popover open={open} anchorRef={seat} onClose={() => { setOpen(false) }} label={label}>
        <div className={css.head}>
          <button
            type="button"
            className={css.page}
            aria-label={t('date.previousMonth')}
            onClick={() => { setMonth(current => addMonths(current, -1)) }}
          >
            <IconChevronLeftOutline14 size={14} />
          </button>
          <span className={css.month} aria-live="polite">{monthLabel(locale, month)}</span>
          <button
            type="button"
            className={css.page}
            aria-label={t('date.nextMonth')}
            onClick={() => { setMonth(current => addMonths(current, 1)) }}
          >
            <IconChevronRightOutline14 size={14} />
          </button>
        </div>

        <div className={css.weekdays} role="presentation">
          {/* Keyed by position: narrow weekday names repeat in English (S, M, T, W, T, F, S). */}
          {weekdays.map((day, index) => <span key={index} className={css.weekday}>{day}</span>)}
        </div>

        <div
          ref={grid}
          className={css.grid}
          role="grid"
          aria-label={label}
          onKeyDown={onGridKeyDown}
        >
          {days.map(cell => (
            <button
              key={cell.date}
              type="button"
              role="gridcell"
              data-date={cell.date}
              className={clsx(
                css.day,
                !cell.inMonth && css.outside,
                cell.date === today && css.today,
                cell.date === value && css.selected,
              )}
              aria-selected={cell.date === value}
              aria-current={cell.date === today ? 'date' : undefined}
              tabIndex={cell.date === focused ? 0 : -1}
              onFocus={() => { setFocused(cell.date) }}
              onClick={() => { commit(cell.date) }}
            >
              {cell.day}
            </button>
          ))}
        </div>

        <div className={css.foot}>
          <button type="button" className={css.action} onClick={() => { commit(today) }}>
            {t('date.today')}
          </button>
          <button
            type="button"
            className={clsx(css.action, css.actionMuted)}
            disabled={value === undefined}
            onClick={() => { commit('') }}
          >
            {t('date.clear')}
          </button>
        </div>
      </Popover>
    </>
  )
}
