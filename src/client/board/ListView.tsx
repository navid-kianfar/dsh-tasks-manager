/**
 * The dense list layout: every card as one row, sortable by column.
 *
 * The table scrolls inside its own container rather than widening the page — the board sits in the
 * app's centre column, and a horizontally scrolling page would drag the conversation with it.
 *
 * @module @achasoft/dsh-tasks-manager/client/board/ListView
 */

import { useState } from 'react'
import clsx from 'clsx'
import {
  IconChevronDownOutline14,
  IconChevronUpOutline14,
  IconEllipsisOutline16,
  IconLoadingOutline16,
  Menu,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Task } from '../../domain/types.ts'
import type { ListViewProps, SortColumn } from './contract.ts'
import { describeDue, relativeTime, sortTasks, toDateText } from './format.ts'
import css from './ListView.module.css'

/**
 * The sortable columns: the sort key, the dictionary key its header reads, and the header cell's
 * own class.
 *
 * The class is named rather than derived from `key`, because the stylesheet also carries body-cell
 * classes called `title`, `status`, and `priority` — deriving would style a `<th>` as a status pill
 * and collapse the header row.
 */
const COLUMNS: readonly {
  key: SortColumn
  label: 'list.ref' | 'list.title' | 'list.status' | 'list.priority' | 'list.assignee' | 'list.due' | 'list.updated'
  cell: 'colRef' | 'colTitle' | 'colStatus' | 'colPriority' | 'colAssignee' | 'colDue' | 'colUpdated'
}[] = [
  { key: 'ref', label: 'list.ref', cell: 'colRef' },
  { key: 'title', label: 'list.title', cell: 'colTitle' },
  { key: 'status', label: 'list.status', cell: 'colStatus' },
  { key: 'priority', label: 'list.priority', cell: 'colPriority' },
  { key: 'assignee', label: 'list.assignee', cell: 'colAssignee' },
  { key: 'dueAt', label: 'list.due', cell: 'colDue' },
  { key: 'updatedAt', label: 'list.updated', cell: 'colUpdated' },
]

/** Render the list layout. */
export function ListView({
  tasks, selectedId, sort, onSortChange, canDispatch, canDelete, onOpen, onArchive, onDelete, onDispatch, t,
}: ListViewProps) {
  const [menuFor, setMenuFor] = useState<string | undefined>(undefined)
  const now = Date.now()
  const rows = sortTasks(tasks, sort)

  /**
   * Toggle the sort on one column.
   *
   * A fresh column starts ascending except the two where "most recent" and "most urgent" are what a
   * reader means by clicking: those start descending.
   * @param column - the column clicked.
   */
  function toggleSort(column: SortColumn): void {
    if (sort.column === column) {
      onSortChange({ column, direction: sort.direction === 'asc' ? 'desc' : 'asc' })
      return
    }
    onSortChange({ column, direction: column === 'updatedAt' || column === 'priority' ? 'desc' : 'asc' })
  }

  /**
   * The overflow-menu rows for one card.
   * @param task - the card.
   * @returns the menu entries.
   */
  function menuFor_(task: Task): MenuEntry[] {
    return [
      { id: 'open', label: t('card.open') },
      // As on the card: a run with no recorded owner can be replaced, after the view confirms it.
      ...canDispatch && (task.runningJobId === undefined || task.runOwnerUnknown === true) && !task.archived
        ? [{ id: 'dispatch', label: t('card.dispatch') }]
        : [],
      { type: 'separator', id: 'sep' },
      task.archived
        ? { id: 'restore', label: t('card.restore') }
        : { id: 'archive', label: t('card.archive') },
      ...canDelete ? [{ id: 'delete', label: t('card.delete'), danger: true }] : [],
    ]
  }

  return (
    <div className={css.scroll}>
      <table className={css.table}>
        <thead>
          <tr>
            {COLUMNS.map(column => (
              <th key={column.key} scope="col" className={clsx(css.th, css[column.cell])}>
                <button
                  type="button"
                  className={css.sort}
                  aria-label={t('list.sortBy', { column: t(column.label) })}
                  aria-sort={sort.column === column.key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                  onClick={() => { toggleSort(column.key) }}
                >
                  {t(column.label)}
                  {sort.column === column.key && (
                    sort.direction === 'asc'
                      ? <IconChevronUpOutline14 size={12} />
                      : <IconChevronDownOutline14 size={12} />
                  )}
                </button>
              </th>
            ))}
            <th scope="col" className={clsx(css.th, css.actions)} />
          </tr>
        </thead>
        <tbody>
          {rows.map((task) => {
            const due = describeDue(task.dueAt, now, t)
            return (
              <tr
                key={task.id}
                className={clsx(css.row, selectedId === task.id && css.selected, task.archived && css.archived)}
                onClick={() => { onOpen(task.id) }}
              >
                <td className={clsx(css.td, css.ref)}>#{task.ref}</td>
                <td className={clsx(css.td, css.titleCell)}>
                  <button type="button" className={css.title} onClick={() => { onOpen(task.id) }}>
                    {task.title}
                  </button>
                  {task.runningJobId !== undefined && (
                    <span className={css.running}>
                      <IconLoadingOutline16 size={12} className={css.spin} />
                      {t(task.runOwnerUnknown === true ? 'card.runningOwnerUnknown' : 'card.running')}
                    </span>
                  )}
                  {task.labels.length > 0 && (
                    <span className={css.labels}>
                      {task.labels.map(label => <span key={label} className={css.label}>{label}</span>)}
                    </span>
                  )}
                </td>
                <td className={css.td}>
                  <span className={css.status} data-status={task.status}>{t(`status.${task.status}`)}</span>
                </td>
                <td className={css.td}>
                  <span className={css.priority} data-priority={task.priority}>{t(`priority.${task.priority}`)}</span>
                </td>
                <td className={clsx(css.td, css.muted)}>{task.assignee ?? '—'}</td>
                <td className={css.td}>
                  {due === undefined
                    ? <span className={css.muted}>—</span>
                    : <span className={css.due} data-tone={due.tone}>{toDateText(task.dueAt as number)}</span>}
                </td>
                <td className={clsx(css.td, css.muted)}>{relativeTime(task.updatedAt, now, t)}</td>
                <td className={clsx(css.td, css.actions)}>
                  <Menu
                    open={menuFor === task.id}
                    portal
                    align="end"
                    items={menuFor_(task)}
                    onSelect={(id) => {
                      setMenuFor(undefined)
                      if (id === 'open') onOpen(task.id)
                      else if (id === 'dispatch') onDispatch(task.id)
                      else if (id === 'archive') onArchive(task.id, true)
                      else if (id === 'restore') onArchive(task.id, false)
                      else if (id === 'delete') onDelete(task.id)
                    }}
                    onClose={() => { setMenuFor(undefined) }}
                    anchor={
                      <button
                        type="button"
                        className={css.menuButton}
                        aria-label={t('card.menu')}
                        aria-haspopup="menu"
                        aria-expanded={menuFor === task.id}
                        onClick={(event) => {
                          // The row itself opens the detail; the menu must not do both.
                          event.stopPropagation()
                          setMenuFor(current => (current === task.id ? undefined : task.id))
                        }}
                      >
                        <IconEllipsisOutline16 size={14} />
                      </button>
                    }
                  />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
