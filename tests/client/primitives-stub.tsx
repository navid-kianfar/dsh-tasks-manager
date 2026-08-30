/**
 * A stand-in for `@deepseek-ai/dsh-client-ui-primitives` in component tests.
 *
 * The real package is a runtime baseline external: the Web Client's module loader supplies it, and
 * this checkout never builds its `lib/`. Pulling its sources in instead would drag the whole
 * markdown stack (shiki, katex) into a test about THIS plugin's components. The stub keeps the
 * boundary honest — same names, same props, plain markup — so assertions read this package's own
 * output rather than the design system's.
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react'

/** Visual variant, accepted and ignored. */
export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'

/** One selectable menu row. */
export interface MenuItem { id: string; label: ReactNode; disabled?: boolean; icon?: ReactNode; danger?: boolean }
/** A hairline between groups. */
export interface MenuSeparator { type: 'separator'; id: string }
/** A non-interactive heading row. */
export interface MenuLabel { type: 'label'; id: string; text: string }
/** One entry in a menu. */
export type MenuEntry = MenuItem | MenuSeparator | MenuLabel

/**
 * A button that forwards its native attributes.
 * @param props - the real component's props; `variant`, `size` and `icon` are accepted and ignored.
 * @returns the button element.
 */
export function Button({ variant, size, icon, children, ...rest }: {
  variant?: ButtonVariant
  size?: 'md' | 'sm'
  icon?: ReactNode
  children?: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  void variant
  void size
  return <button type="button" {...rest}>{icon}{children}</button>
}

/**
 * A chip, interactive when it carries an `onClick`.
 * @param props - the real component's props.
 * @returns the pill element.
 */
export function Pill({ active, children, onClick, ...rest }: {
  active?: boolean
  children?: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  if (onClick === undefined) return <span data-active={active}>{children}</span>
  return <button type="button" data-active={active} onClick={onClick} {...rest}>{children}</button>
}

/**
 * The anchor plus, when open, its rows — enough for a test to click one.
 * @param props - the real component's props.
 * @returns the anchor and the conditional list.
 */
export function Menu({ open, anchor, items, onSelect }: {
  open: boolean
  anchor: ReactNode
  items: readonly MenuEntry[]
  footer?: readonly MenuEntry[]
  selectedId?: string | undefined
  selectedIds?: readonly string[] | undefined
  onSelect: (id: string) => void
  onClose: () => void
  align?: 'start' | 'end'
  side?: 'bottom' | 'top' | 'right'
  portal?: boolean
  className?: string
}) {
  return (
    <span>
      {anchor}
      {open && (
        <div role="menu">
          {items.map(entry => ('type' in entry ? null : (
            <button key={entry.id} type="button" role="menuitem" onClick={() => { onSelect(entry.id) }}>
              {entry.label}
            </button>
          )))}
        </div>
      )}
    </span>
  )
}

/**
 * The dialog's contents when it is open, flat — enough for a test to read the copy and press a
 * button. The real component portals; keeping the tree in place is what lets an assertion query
 * from the mounted container.
 * @param props - the real component's props.
 * @returns the dialog, or nothing while closed.
 */
export function Modal({ open, onClose, title, closeLabel = 'Close', description, children, footer }: {
  open: boolean
  onClose: () => void
  title: string
  closeLabel?: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
  className?: string
  contentClassName?: string
  headless?: boolean
}) {
  if (!open) return null
  return (
    <div role="dialog" aria-label={title}>
      <h2>{title}</h2>
      <button type="button" aria-label={closeLabel} onClick={onClose} />
      {description !== undefined && <p>{description}</p>}
      {children}
      {footer}
    </div>
  )
}

/**
 * Markdown rendered as its source text, which is what an assertion reads anyway.
 * @param props - the real component's props.
 * @returns the text in a block.
 */
export function MarkdownText({ text }: { text: string; streaming?: boolean }) {
  return <div data-markdown>{text}</div>
}

/** Shared icon props. */
export interface IconProps { size?: number | undefined; className?: string | undefined }

/**
 * Build a named icon stub that renders nothing but keeps the name in the DOM.
 * @param name - the icon's export name, stamped as a data attribute.
 * @returns the icon component.
 */
function icon(name: string) {
  return function Icon({ className }: IconProps) {
    return <span data-icon={name} className={className} />
  }
}

export const IconArchiveOutline20 = icon('archive')
export const IconCheckOutline14 = icon('check')
export const IconChevronDownOutline14 = icon('chevron-down')
export const IconChevronLeftOutline14 = icon('chevron-left')
export const IconChevronRightOutline14 = icon('chevron-right')
export const IconChevronUpOutline14 = icon('chevron-up')
export const IconCloseFill14 = icon('close-fill')
export const IconCloseOutline16 = icon('close')
export const IconEllipsisOutline16 = icon('ellipsis')
export const IconLoadingOutline16 = icon('loading')
export const IconPlayOutline16 = icon('play')
export const IconPlusOutline16 = icon('plus')
export const IconRefreshOutline16 = icon('refresh')
export const IconRightUpOutline16 = icon('right-up')
export const IconSearchOutline16 = icon('search')
export const IconStopFill16 = icon('stop')
export const IconTrashOutline16 = icon('trash')
export const IconWarningOutline16 = icon('warning')
