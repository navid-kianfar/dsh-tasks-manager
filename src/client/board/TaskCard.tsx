/**
 * One card on the board.
 *
 * The card body is a button so the whole surface opens the detail with a click or Enter, and the
 * overflow menu is a sibling button rather than a nested one — a button inside a button is invalid
 * markup and the inner one stops receiving keyboard activation.
 *
 * @module @achasoft/dsh-tasks-manager/client/board/TaskCard
 */

import { useState } from 'react'
import clsx from 'clsx'
import {
  IconArchiveOutline20,
  IconEllipsisOutline16,
  IconLoadingOutline16,
  IconPlayOutline16,
  IconStopFill16,
  IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TaskCardProps } from './contract.ts'
import { describeDue } from './format.ts'
import css from './TaskCard.module.css'

/**
 * Render one board card.
 * @param props - the card, its actions, and the deployment's capabilities.
 * @returns the card element.
 */
export function TaskCard({
  task, selected, canDispatch, canDelete, dragging, onOpen, onArchive, onDelete, onDispatch,
  onStopRun, onDragStart, onDragEnd, t,
}: TaskCardProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const due = describeDue(task.dueAt, Date.now(), t)
  const running = task.runningJobId !== undefined
  // A run with no recorded owner may be long dead, so dispatching again stays on offer; the view
  // asks the person to confirm replacing that marker first.
  const ownerUnknown = task.runOwnerUnknown === true

  const items: MenuEntry[] = [
    { id: 'open', label: t('card.open') },
    ...canDispatch && (!running || ownerUnknown) && !task.archived
      ? [{ id: 'dispatch', label: t('card.dispatch'), icon: <IconPlayOutline16 size={14} /> }]
      : [],
    // A run started from a card must be stoppable from that card: the detail panel is one click
    // further away, and a card that can only be started from here reads as a one-way door.
    ...running
      ? [{ id: 'stop', label: t(ownerUnknown ? 'card.clearRun' : 'card.stopRun'), icon: <IconStopFill16 size={14} /> }]
      : [],
    { type: 'separator', id: 'sep' },
    task.archived
      ? { id: 'restore', label: t('card.restore'), icon: <IconArchiveOutline20 size={14} /> }
      : { id: 'archive', label: t('card.archive'), icon: <IconArchiveOutline20 size={14} /> },
    ...canDelete
      ? [{ id: 'delete', label: t('card.delete'), icon: <IconTrashOutline16 size={14} />, danger: true }]
      : [],
  ]

  /**
   * Route a menu selection to its action.
   * @param id - the selected row's id.
   */
  function select(id: string): void {
    setMenuOpen(false)
    if (id === 'open') onOpen(task.id)
    else if (id === 'dispatch') onDispatch(task.id)
    else if (id === 'stop' && task.runningJobId !== undefined) onStopRun(task.runningJobId, task.id)
    else if (id === 'archive') onArchive(task.id, true)
    else if (id === 'restore') onArchive(task.id, false)
    else if (id === 'delete') onDelete(task.id)
  }

  return (
    <article
      className={clsx(css.card, selected && css.selected, dragging && css.dimmed, task.archived && css.archived)}
      data-task-id={task.id}
      data-priority={task.priority}
      draggable={!task.archived}
      onDragStart={(event) => {
        // The plain-text payload is what makes a drag out of the board (into an editor, say) carry
        // something meaningful instead of nothing.
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', `#${task.ref} ${task.title}`)
        onDragStart(task.id)
      }}
      onDragEnd={onDragEnd}
    >
      <button
        type="button"
        className={css.body}
        onClick={() => { onOpen(task.id) }}
        aria-label={`#${task.ref} ${task.title}`}
      >
        <span className={css.head}>
          <span className={css.ref}>#{task.ref}</span>
          {task.priority !== 'normal' && (
            <span className={css.priority} data-priority={task.priority}>
              {t(`priority.${task.priority}`)}
            </span>
          )}
          {task.archived && <span className={css.badge}>{t('card.archivedBadge')}</span>}
        </span>
        <span className={css.title}>{task.title}</span>
        {task.labels.length > 0 && (
          <span className={css.labels}>
            {task.labels.map(label => <span key={label} className={css.label}>{label}</span>)}
          </span>
        )}
        <span className={css.meta}>
          {running && (
            <span className={css.running}>
              <IconLoadingOutline16 size={12} className={css.spin} />
              {t(ownerUnknown ? 'card.runningOwnerUnknown' : 'card.running')}
            </span>
          )}
          {due !== undefined && <span className={css.due} data-tone={due.tone}>{due.text}</span>}
          {task.assignee !== undefined && <span className={css.assignee}>{task.assignee}</span>}
        </span>
      </button>
      <span className={css.menuSeat}>
        {running && (
          // A sibling of the card's body, not a child: the body is itself a button, and the run
          // must be stoppable without first opening the card.
          <button
            type="button"
            className={css.stopButton}
            aria-label={t(ownerUnknown ? 'card.clearRun' : 'card.stopRun')}
            title={t(ownerUnknown ? 'card.clearRun' : 'card.stopRun')}
            onClick={() => { onStopRun(task.runningJobId as string, task.id) }}
          >
            <IconStopFill16 size={12} />
          </button>
        )}
        <Menu
          open={menuOpen}
          portal
          align="end"
          items={items}
          onSelect={select}
          onClose={() => { setMenuOpen(false) }}
          anchor={
            <button
              type="button"
              className={css.menuButton}
              aria-label={t('card.menu')}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => { setMenuOpen(open => !open) }}
            >
              <IconEllipsisOutline16 size={14} />
            </button>
          }
        />
      </span>
    </article>
  )
}
