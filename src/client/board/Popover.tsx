/**
 * An anchored surface portalled to `document.body`.
 *
 * The card detail is a scrolling panel inside an `overflow: hidden` board, so a picker rendered in
 * place is clipped by two ancestors before it reaches its second row. Portalling escapes both; the
 * cost is that position has to be computed rather than inherited, which is what this module is.
 *
 * The design system ships `Menu`, and the status and priority pickers use it. This exists for the
 * two surfaces `Menu` cannot be: a calendar grid, and a list with a search box above it.
 *
 * @module @achasoft/dsh-tasks-manager/client/board/Popover
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import fields from './fields.module.css'
import css from './Popover.module.css'

/** Gap between the anchor and the surface, matching the design system's own dropdown offset. */
const OFFSET = 4

/** Clearance kept to every viewport edge. */
const MARGIN = 8

/** Where the surface sits once it has been measured. */
interface Placement {
  /** Distance from the viewport's left edge, in pixels. */
  left: number
  /** Distance from the viewport's top edge, in pixels. */
  top: number
  /** The tallest the surface may be before it scrolls internally. */
  maxHeight: number
}

/**
 * Place the surface against its anchor, flipping above it when below does not fit.
 * @param anchor - the trigger's rect.
 * @param surface - the surface's own measured size.
 * @param viewport - the visible area.
 * @param align - which edge of the anchor the surface lines up with.
 * @returns the resolved placement.
 */
export function placeSurface(
  anchor: { left: number; right: number; top: number; bottom: number },
  surface: { width: number; height: number },
  viewport: { width: number; height: number },
  align: 'start' | 'end',
): Placement {
  const below = viewport.height - anchor.bottom - OFFSET - MARGIN
  const above = anchor.top - OFFSET - MARGIN
  // Below unless it does not fit AND above is genuinely roomier: flipping to a shorter side would
  // trade a scrolling surface for a smaller scrolling surface.
  const flip = surface.height > below && above > below
  const maxHeight = Math.max(120, flip ? above : below)

  const preferred = align === 'end' ? anchor.right - surface.width : anchor.left
  const left = Math.max(MARGIN, Math.min(preferred, viewport.width - surface.width - MARGIN))
  const top = flip
    ? Math.max(MARGIN, anchor.top - OFFSET - Math.min(surface.height, maxHeight))
    : anchor.bottom + OFFSET

  return { left, top, maxHeight }
}

/** Render an anchored popover surface. */
export function Popover({ open, anchorRef, onClose, align = 'start', label, className, children }: {
  /** Whether the surface is showing; the owner holds this. */
  open: boolean
  /** The trigger the surface is placed against and whose clicks do not count as "outside". */
  anchorRef: RefObject<HTMLElement | null>
  /** Escape, an outside click, or a scroll that took the anchor away. */
  onClose: () => void
  /** Which edge of the anchor the surface lines up with. */
  align?: 'start' | 'end'
  /** Accessible name for the surface. */
  label: string
  /** Extra class for the surface, applied over the shared popover shape. */
  className?: string | undefined
  /** The surface's contents. */
  children: ReactNode
}) {
  const surface = useRef<HTMLDivElement | null>(null)
  const [placement, setPlacement] = useState<Placement | null>(null)

  const reposition = useCallback(() => {
    const anchor = anchorRef.current
    const node = surface.current
    if (anchor === null || node === null) return
    setPlacement(placeSurface(
      anchor.getBoundingClientRect(),
      { width: node.offsetWidth, height: node.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      align,
    ))
  }, [anchorRef, align])

  // Measured before paint, so the surface never appears at the origin and jumps to the anchor.
  useLayoutEffect(() => {
    if (!open) { setPlacement(null); return }
    reposition()
  }, [open, reposition])

  useEffect(() => {
    if (!open) return
    /** Follow the anchor while any ancestor scrolls or the window changes size. */
    function onViewportChange(): void { reposition() }
    // Capture: the board's own panes scroll, and a scroll event on a nested pane does not bubble.
    window.addEventListener('scroll', onViewportChange, true)
    window.addEventListener('resize', onViewportChange)
    return () => {
      window.removeEventListener('scroll', onViewportChange, true)
      window.removeEventListener('resize', onViewportChange)
    }
  }, [open, reposition])

  useEffect(() => {
    if (!open) return
    /**
     * Close on Escape, before anything behind the surface reads the key.
     * @param event - the keydown.
     */
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    /**
     * Close on a press outside both the surface and its trigger.
     *
     * The trigger is excluded because it toggles: closing here as well would close and reopen in
     * one press, which reads as the picker refusing to open.
     * @param event - the pointer press.
     */
    function onPointerDown(event: Event): void {
      const target = event.target as Node | null
      if (target === null) return
      if (surface.current?.contains(target) === true) return
      if (anchorRef.current?.contains(target) === true) return
      onClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open, onClose, anchorRef])

  if (!open) return null

  return createPortal(
    <div
      ref={surface}
      role="dialog"
      aria-label={label}
      className={clsx(fields.fields, fields.popover, css.surface, className)}
      style={placement === null
        // Laid out but not yet placed: hidden rather than absent, so the first measurement reads a
        // real size instead of zero.
        ? { visibility: 'hidden', left: 0, top: 0 }
        : { left: placement.left, top: placement.top, maxHeight: placement.maxHeight }}
    >
      {children}
    </div>,
    document.body,
  )
}
