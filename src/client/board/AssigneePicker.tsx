/**
 * The assignee field: whoever has committed to this project, and nobody else.
 *
 * It used to be a free-text box, which meant `alex`, `Alex`, and `alex@…` were three different
 * people to every filter and every sort. The roster a project actually carries is its commit
 * history, so that is what this offers — read from `git log` by the host, ranked by how much of the
 * project each person has written, with the identity `git config` names in this repository first.
 *
 * A value already on a card that is not in that history is still shown, and still selected: the
 * picker narrows what can be *chosen*, and must not silently drop what a card already says.
 *
 * @module @achasoft/dsh-tasks-manager/client/board/AssigneePicker
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  IconCheckOutline14,
  IconChevronDownOutline14,
  IconCloseFill14,
  IconSearchOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitAuthor } from '../../host/protocol.ts'
import type { BoardTranslate } from './contract.ts'
import { Popover } from './Popover.tsx'
import fields from './fields.module.css'
import css from './AssigneePicker.module.css'

/** One row the list can offer. */
interface AssigneeRow {
  /** The value written when the row is chosen; the empty string clears the assignee. */
  value: string
  /** The name drawn on the row. */
  name: string
  /** The email drawn under it, when the person has one. */
  email?: string
  /** How many of the scanned commits are theirs, drawn as the row's trailing count. */
  commits?: number
  /** Whether the row is the identity this repository is configured with. */
  self?: boolean
  /** Whether the row exists only because a card already names them. */
  unknown?: boolean
}

/** How many initials an avatar shows. */
const INITIAL_COUNT = 2

/**
 * The initials drawn in a person's avatar.
 *
 * Word-initial letters where a name has them, otherwise the first characters of the whole string —
 * an assignee recorded as an email address still gets a legible mark rather than an empty circle.
 * @param name - the person's name.
 * @returns one or two characters, upper-cased.
 */
export function initialsOf(name: string): string {
  const words = name.trim().split(/[\s._@-]+/u).filter(word => word !== '')
  const [first, second] = words
  if (first === undefined) return '?'
  // Characters, not code units: an emoji or an astral-plane letter is one initial, not half of one.
  const letters = second === undefined
    ? [...first].slice(0, INITIAL_COUNT)
    : [[...first][0], [...second][0]]
  return letters.join('').toUpperCase()
}

/**
 * The rows a query matches, in offer order.
 * @param authors - the project's committers.
 * @param value - the assignee already on the card, if any.
 * @param search - what has been typed into the picker's search box.
 * @returns the rows to draw.
 */
export function assigneeRows(
  authors: readonly GitAuthor[],
  value: string | undefined,
  search: string,
): AssigneeRow[] {
  const rows: AssigneeRow[] = authors.map(author => ({
    value: author.name,
    name: author.name,
    ...author.email === '' ? {} : { email: author.email },
    commits: author.commits,
    ...author.self === true ? { self: true } : {},
  }))

  // A card assigned before this rule existed — or by the agent, or by hand in sqlite3 — keeps its
  // value visible and selectable. Dropping it would make opening a card silently disagree with
  // what the board shows on it.
  const current = (value ?? '').trim()
  if (current !== '' && !rows.some(row => row.value.toLowerCase() === current.toLowerCase())) {
    rows.unshift({ value: current, name: current, unknown: true })
  }

  const needle = search.trim().toLowerCase()
  if (needle === '') return rows
  return rows.filter(row =>
    row.name.toLowerCase().includes(needle) || (row.email ?? '').includes(needle))
}

/** Render the assignee field. */
export function AssigneePicker({ value, authors, available, onChange, label, t }: {
  /** The assignee on the card, or `undefined` when nobody is named. */
  value: string | undefined
  /** The project's committers, as the host read them. */
  authors: readonly GitAuthor[]
  /** Whether git could be read at all; `false` explains an empty list. */
  available: boolean
  /** Called with the chosen name, or the empty string to clear the assignee. */
  onChange: (assignee: string) => void
  /** Accessible name for the trigger, since the visible label is a separate `<dt>`. */
  label: string
  /** Translate. */
  t: BoardTranslate
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [active, setActive] = useState(0)
  const seat = useRef<HTMLSpanElement | null>(null)
  const box = useRef<HTMLInputElement | null>(null)

  const rows = useMemo(() => assigneeRows(authors, value, search), [authors, value, search])

  // Every visit starts from an empty query on the first row: a picker that remembers the last
  // search shows a filtered list to someone who came back to browse.
  useEffect(() => {
    if (!open) return
    setSearch('')
    setActive(0)
    box.current?.focus()
  }, [open])

  useEffect(() => { setActive(0) }, [search])

  /**
   * Commit a choice and close.
   * @param assignee - the name chosen, or the empty string to clear.
   */
  function commit(assignee: string): void {
    setOpen(false)
    seat.current?.querySelector('button')?.focus()
    if (assignee !== (value ?? '')) onChange(assignee)
  }

  /**
   * Drive the list from the search box.
   * @param event - the keydown.
   */
  function onSearchKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (rows.length === 0) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive(current => (current + step + rows.length) % rows.length)
      return
    }
    if (event.key !== 'Enter') return
    event.preventDefault()
    const row = rows[active]
    if (row !== undefined) commit(row.value)
  }

  return (
    <>
      <span ref={seat} className={fields.seat}>
        <button
          type="button"
          className={clsx(fields.trigger, value !== undefined && fields.triggerClearable)}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => { setOpen(current => !current) }}
        >
          {value === undefined
            ? <span className={clsx(fields.triggerText, fields.triggerEmpty)}>{t('detail.assigneePlaceholder')}</span>
            : (
                <>
                  <span className={css.avatar} aria-hidden="true">{initialsOf(value)}</span>
                  <span className={fields.triggerText}>{value}</span>
                </>
              )}
          {value === undefined && <IconChevronDownOutline14 size={14} className={fields.triggerIcon} />}
        </button>
        {value !== undefined && (
          <button
            type="button"
            className={fields.clear}
            aria-label={t('detail.assigneeClear')}
            onClick={() => { onChange('') }}
          >
            <IconCloseFill14 size={12} />
          </button>
        )}
      </span>

      <Popover open={open} anchorRef={seat} onClose={() => { setOpen(false) }} label={label} className={css.popover}>
        <div className={css.searchSeat}>
          <IconSearchOutline16 size={14} className={css.searchIcon} />
          <input
            ref={box}
            className={css.search}
            type="text"
            value={search}
            placeholder={t('detail.assigneeSearch')}
            aria-label={t('detail.assigneeSearch')}
            onChange={(event) => { setSearch(event.currentTarget.value) }}
            onKeyDown={onSearchKeyDown}
          />
        </div>

        <div className={clsx(css.list, fields.popoverScroll)} role="listbox" aria-label={label}>
          {search === '' && (
            <button
              type="button"
              role="option"
              aria-selected={value === undefined}
              className={clsx(fields.option, css.row)}
              onClick={() => { commit('') }}
            >
              <span className={clsx(css.avatar, css.avatarEmpty)} aria-hidden="true">—</span>
              <span className={fields.optionLabel}>{t('detail.assigneePlaceholder')}</span>
              {value === undefined
                ? <IconCheckOutline14 size={14} className={fields.optionCheck} />
                : <span className={fields.optionCheckSpacer} />}
            </button>
          )}

          {rows.map((row, index) => (
            <button
              key={`${row.value}:${row.email ?? ''}`}
              type="button"
              role="option"
              aria-selected={row.value === value}
              className={clsx(fields.option, css.row, index === active && fields.optionActive)}
              onPointerEnter={() => { setActive(index) }}
              onClick={() => { commit(row.value) }}
            >
              <span className={css.avatar} aria-hidden="true">{initialsOf(row.name)}</span>
              <span className={css.identity}>
                <span className={css.name}>
                  {row.name}
                  {row.self === true && <span className={css.you}>{t('detail.assigneeYou')}</span>}
                </span>
                <span className={css.email}>
                  {row.unknown === true ? t('detail.assigneeUnknown') : row.email ?? ''}
                </span>
              </span>
              {row.commits !== undefined && row.commits > 0 && (
                <span className={fields.optionMeta}>{t('detail.assigneeCommits', { count: row.commits })}</span>
              )}
              {row.value === value
                ? <IconCheckOutline14 size={14} className={fields.optionCheck} />
                : <span className={fields.optionCheckSpacer} />}
            </button>
          ))}

          {rows.length === 0 && (
            <p className={fields.popoverEmpty}>
              {!available
                ? t('detail.assigneeNoGit')
                : search === '' ? t('detail.assigneeNoAuthors') : t('detail.assigneeNoMatch')}
            </p>
          )}
        </div>
      </Popover>
    </>
  )
}
