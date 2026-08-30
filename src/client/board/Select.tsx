/**
 * A value picker: a field-shaped trigger over the design system's own dropdown.
 *
 * Replaces the native `<select>` the card detail used to carry. A native select cannot be styled
 * past its border — the list is drawn by the platform, in the platform's colours, at the platform's
 * size — so on a dark board it opened as a bright rectangle that belonged to no theme. Everything
 * here is the same surface, the same hairline and the same check mark the shell's own menus use.
 *
 * @module @achasoft/dsh-tasks-manager/client/board/Select
 */

import { useId, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TaskPriority, TaskStatus } from '../../domain/types.ts'
import fields from './fields.module.css'
import css from './Select.module.css'

/** One choice in a select. */
export interface SelectOption<V extends string = string> {
  /** The value written when this row is chosen. */
  value: V
  /** What the row and the trigger read as. */
  label: string
  /** Colours the row's dot with the board's column vocabulary. */
  status?: TaskStatus
  /** Colours the row's dot with the board's urgency vocabulary. */
  priority?: TaskPriority
}

/**
 * The leading dot, in whichever vocabulary the option carries.
 * @param option - the option to mark.
 * @returns the dot, or `null` for an option with no colour of its own.
 */
function Dot({ option }: { option: SelectOption }): ReactNode {
  if (option.status !== undefined) {
    return <span className={css.dot} data-status={option.status} aria-hidden="true" />
  }
  if (option.priority !== undefined) {
    return <span className={css.dot} data-priority={option.priority} aria-hidden="true" />
  }
  return null
}

/** Render a select. */
export function Select<V extends string>({ value, options, onChange, label, disabled = false, align = 'start' }: {
  /** The chosen value. */
  value: V
  /** Every choice, in the order they are offered. */
  options: readonly SelectOption<V>[]
  /** Called with the new value; never called with the value already chosen. */
  onChange: (value: V) => void
  /** Accessible name for the trigger, since the visible label is a separate `<dt>`. */
  label: string
  /** Whether the field refuses changes. */
  disabled?: boolean
  /** Which edge of the trigger the list lines up with. */
  align?: 'start' | 'end'
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const selected = options.find(option => option.value === value)

  const items: MenuEntry[] = options.map(option => ({
    id: option.value,
    label: (
      <span className={css.row}>
        <Dot option={option} />
        {option.label}
      </span>
    ),
  }))

  return (
    <Menu
      open={open}
      portal
      className={clsx(css.anchor)}
      items={items}
      selectedId={value}
      onSelect={(next) => {
        setOpen(false)
        if (next !== value) onChange(next as V)
      }}
      onClose={() => { setOpen(false) }}
      align={align}
      anchor={
        <button
          type="button"
          id={id}
          className={clsx(fields.trigger, css.trigger)}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => { setOpen(current => !current) }}
        >
          {selected !== undefined && <Dot option={selected} />}
          <span className={fields.triggerText}>{selected?.label ?? value}</span>
          <IconChevronDownOutline14 size={14} className={fields.triggerIcon} />
        </button>
      }
    />
  )
}
