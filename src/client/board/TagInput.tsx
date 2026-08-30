/**
 * The labels field: chips you can remove, and a box that suggests the ones already on the board.
 *
 * It was a comma-separated text box, which asked the reader to parse the field's own syntax and hid
 * the one thing the store actually enforces — labels are lowercased, de-duplicated and capped. A
 * chip commits when it is typed and disappears when its cross is clicked, so what is on screen is
 * exactly what is on the card.
 *
 * Suggestions come from the labels already in use across the board, which is what keeps `api` from
 * quietly becoming `api`, `API` and `apis`.
 *
 * @module @achasoft/dsh-tasks-manager/client/board/TagInput
 */

import { useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { IconCloseFill14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { MAX_LABELS, MAX_LABEL_LENGTH } from '../../domain/validate.ts'
import type { BoardTranslate } from './contract.ts'
import { Popover } from './Popover.tsx'
import fields from './fields.module.css'
import css from './TagInput.module.css'

/**
 * Canonicalise one typed label the way the store will.
 *
 * Applied here as well as on the host so the chip that appears is the chip that is stored: a field
 * that accepts `  API ` and shows it back, then reloads as `api`, looks like it lost the edit.
 * @param raw - what was typed.
 * @returns the canonical label, or the empty string when there is nothing to add.
 */
export function canonicalLabel(raw: string): string {
  return raw.trim().replace(/\s+/gu, ' ').toLowerCase().slice(0, MAX_LABEL_LENGTH)
}

/** Render the labels field. */
export function TagInput({ value, suggestions, onChange, label, placeholder, t }: {
  /** The labels on the card. */
  value: readonly string[]
  /** Every label in use across the board, offered as completions. */
  suggestions: readonly string[]
  /** Called with the new label set whenever a chip is added or removed. */
  onChange: (labels: string[]) => void
  /** Accessible name for the entry box, since the visible label is a separate `<dt>`. */
  label: string
  /** What the entry box reads as while the card carries no labels. */
  placeholder: string
  /** Translate. */
  t: BoardTranslate
}) {
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  const seat = useRef<HTMLDivElement | null>(null)
  const box = useRef<HTMLInputElement | null>(null)

  const full = value.length >= MAX_LABELS

  const matches = useMemo(() => {
    const needle = canonicalLabel(draft)
    return suggestions
      .filter(entry => !value.includes(entry))
      .filter(entry => needle === '' || entry.includes(needle))
      .slice(0, 8)
  }, [suggestions, value, draft])

  /**
   * Add one label, unless the card already carries it or is already full.
   * @param raw - the label as typed or chosen.
   */
  function add(raw: string): void {
    const next = canonicalLabel(raw)
    setDraft('')
    setOpen(false)
    if (next === '' || value.includes(next) || full) return
    onChange([...value, next])
  }

  /**
   * Remove one label.
   * @param entry - the label to drop.
   */
  function remove(entry: string): void {
    onChange(value.filter(current => current !== entry))
  }

  /**
   * Commit, complete, or backspace out of the entry box.
   * @param event - the keydown.
   */
  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    // A comma is how this field used to separate labels, so pasting an old list still works — each
    // separator simply commits the chip in front of it.
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      add(draft)
      return
    }
    if (event.key === 'Backspace' && draft === '' && value.length > 0) {
      event.preventDefault()
      remove(value[value.length - 1] as string)
      return
    }
    if (event.key === 'ArrowDown' && matches.length > 0) {
      event.preventDefault()
      setOpen(true)
    }
  }

  return (
    <>
      {/* The whole seat is the field: clicking anywhere in it lands in the entry box, which is what
          a row of chips has to do to still feel like one control. */}
      <div
        ref={seat}
        className={clsx(css.seat, open && css.seatOpen)}
        onClick={(event) => { if (event.target === event.currentTarget) box.current?.focus() }}
      >
        {value.map(entry => (
          <span key={entry} className={css.chip}>
            <span className={css.chipText}>{entry}</span>
            <button
              type="button"
              className={css.chipRemove}
              aria-label={t('detail.labelRemove', { label: entry })}
              onClick={() => { remove(entry) }}
            >
              <IconCloseFill14 size={10} />
            </button>
          </span>
        ))}
        <input
          ref={box}
          className={css.entry}
          value={draft}
          disabled={full}
          placeholder={full
            ? t('detail.labelsFull', { count: MAX_LABELS })
            : value.length === 0 ? placeholder : ''}
          aria-label={label}
          aria-expanded={open}
          onChange={(event) => { setDraft(event.currentTarget.value); setOpen(true) }}
          onFocus={() => { setOpen(true) }}
          onKeyDown={onKeyDown}
          // Committing on blur as well: leaving the field with a half-typed label and finding it
          // gone is the one thing a chip field must not do.
          onBlur={() => { add(draft) }}
        />
      </div>

      <Popover
        open={open && matches.length > 0}
        anchorRef={seat}
        onClose={() => { setOpen(false) }}
        label={t('detail.labelsSuggestions')}
      >
        <div className={fields.popoverScroll}>
          {matches.map(entry => (
            <button
              key={entry}
              type="button"
              className={fields.option}
              // Pointer-down, not click: the entry box's blur would otherwise close the popover
              // before the click landed.
              onPointerDown={(event) => { event.preventDefault(); add(entry) }}
            >
              <span className={fields.optionLabel}>{entry}</span>
            </button>
          ))}
        </div>
      </Popover>
    </>
  )
}
