/**
 * The kanban layout: one scrollable column per status, with drag-and-drop between and within them.
 *
 * Drag uses the native HTML5 API rather than a library, because the only thing being dragged is a
 * card between two lists and the native API already knows how to do that — including out of the
 * window, which a pointer-event reimplementation would silently lose.
 *
 * A drop is expressed as the two cards it landed between, never as an index. An index computed at
 * drag start is wrong the moment another writer touches the column; neighbours still describe what
 * the user meant, and the store degrades a neighbour that has since moved to the nearest end.
 *
 * Every drag gesture has a keyboard equivalent: `Ctrl/Cmd + Arrow` on a focused card moves it
 * between columns and within one, because drag-and-drop alone is not operable without a pointer.
 *
 * @module @achasoft/dsh-tasks-manager/client/board/Kanban
 */

import { useRef, useState } from 'react'
import clsx from 'clsx'
import { IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { TASK_STATUSES, type Task, type TaskPlacement, type TaskStatus } from '../../domain/types.ts'
import type { KanbanProps } from './contract.ts'
import { TaskCard } from './TaskCard.tsx'
import css from './Kanban.module.css'

/** Where a drop would land: a column, and the card it would sit above. */
interface DropTarget {
  status: TaskStatus
  /** The card the dragged one would land above, or `undefined` for the end of the column. */
  beforeId: string | undefined
}

/**
 * Group cards into columns, preserving the board order the store returned.
 * @param tasks - the cards to lay out.
 * @returns cards by status.
 */
function byStatus(tasks: readonly Task[]): Record<TaskStatus, Task[]> {
  const columns = Object.fromEntries(TASK_STATUSES.map(status => [status, [] as Task[]])) as Record<TaskStatus, Task[]>
  for (const task of tasks) {
    // A status the store returned that this build does not know (a hand-edited row) has no column;
    // dropping it here is better than inventing a sixth column the user cannot act on.
    columns[task.status]?.push(task)
  }
  return columns
}

/**
 * The neighbours a drop lands between.
 * @param column - the destination column's cards, with the dragged card removed.
 * @param beforeId - the card the drop would land above, or `undefined` for the end.
 * @returns the `after`/`before` pair describing the gap.
 */
function neighbours(column: readonly Task[], beforeId: string | undefined): TaskPlacement {
  const index = beforeId === undefined ? column.length : column.findIndex(task => task.id === beforeId)
  const at = index < 0 ? column.length : index
  return {
    ...at === 0 ? {} : { after: column[at - 1]?.id },
    ...at >= column.length ? {} : { before: column[at]?.id },
  }
}

/** Render the kanban board. */
export function Kanban({
  tasks, counts, selectedId, canDispatch, canDelete, onQuickAdd, onOpen, onMove, onArchive, onDelete,
  onDispatch, onStopRun, t,
}: KanbanProps) {
  // The drag is held in refs and MIRRORED into state. `drop` fires in the same task as the last
  // `dragover`, and a state update queued by that `dragover` has not been applied yet when it does,
  // so reading the target from state would commit whatever the previous render saw. The refs are
  // what the drop reads; the state exists only to re-render the insertion marker.
  const dragRef = useRef<string | undefined>(undefined)
  const dropRef = useRef<DropTarget | undefined>(undefined)
  const [dragId, setDragId] = useState<string | undefined>(undefined)
  const [drop, setDrop] = useState<DropTarget | undefined>(undefined)
  const [adding, setAdding] = useState<TaskStatus | undefined>(undefined)
  const draft = useRef<HTMLInputElement | null>(null)
  const columns = byStatus(tasks)

  /**
   * Record where the drop would land, for both the marker and the commit.
   * @param target - the column and the card the drop would sit above.
   */
  function aim(target: DropTarget): void {
    dropRef.current = target
    setDrop(current =>
      (current?.status === target.status && current.beforeId === target.beforeId ? current : target))
  }

  /** Clear the drag from both the refs and the render state. */
  function clearDrag(): void {
    dragRef.current = undefined
    dropRef.current = undefined
    setDragId(undefined)
    setDrop(undefined)
  }

  /**
   * Begin dragging one card.
   * @param taskId - the card picked up.
   */
  function beginDrag(taskId: string): void {
    dragRef.current = taskId
    setDragId(taskId)
  }

  /**
   * Commit the current drag to the column it was released over.
   * @param status - the column the pointer released in.
   */
  function commit(status: TaskStatus): void {
    const id = dragRef.current
    const target = dropRef.current
    const beforeId = target?.status === status ? target.beforeId : undefined
    clearDrag()
    if (id === undefined) return
    const column = (columns[status] ?? []).filter(task => task.id !== id)
    onMove(id, status, neighbours(column, beforeId))
  }

  /**
   * Move a focused card with the keyboard.
   * @param task - the card to move.
   * @param event - the keydown, already known to carry the platform modifier.
   */
  function keyboardMove(task: Task, event: React.KeyboardEvent): void {
    const column = (columns[task.status] ?? [])
    const at = column.findIndex(entry => entry.id === task.id)
    const lane = TASK_STATUSES.indexOf(task.status)

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const next = TASK_STATUSES[lane + (event.key === 'ArrowRight' ? 1 : -1)]
      if (next === undefined) return
      event.preventDefault()
      // Landing at the head of the destination column keeps the moved card in view; landing at an
      // arbitrary depth would scroll it out from under the person who just moved it.
      onMove(task.id, next, neighbours(columns[next] ?? [], (columns[next] ?? [])[0]?.id))
      return
    }
    if (event.key === 'ArrowUp' && at > 0) {
      event.preventDefault()
      const rest = column.filter(entry => entry.id !== task.id)
      onMove(task.id, task.status, neighbours(rest, rest[at - 1]?.id))
      return
    }
    if (event.key === 'ArrowDown' && at >= 0 && at < column.length - 1) {
      event.preventDefault()
      const rest = column.filter(entry => entry.id !== task.id)
      onMove(task.id, task.status, neighbours(rest, rest[at + 1]?.id))
    }
  }

  return (
    <div className={css.board} role="list" aria-label={t('view.aria')}>
      {TASK_STATUSES.map((status) => {
        const column = columns[status] ?? []
        const hovered = drop?.status === status
        return (
          <section
            key={status}
            className={clsx(css.column, hovered && css.columnActive)}
            role="listitem"
            aria-label={`${t(`status.${status}`)} (${counts[status]})`}
            onDragOver={(event) => {
              if (dragRef.current === undefined) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              // Only claim the column's tail here; a card's own handler claims the gap above it and
              // stops the event before it reaches this one.
              aim({ status, beforeId: undefined })
            }}
            onDrop={(event) => {
              if (dragRef.current === undefined) return
              event.preventDefault()
              commit(status)
            }}
          >
            <header className={css.head}>
              <span className={css.dot} data-status={status} aria-hidden="true" />
              <h3 className={css.name}>{t(`status.${status}`)}</h3>
              <span className={css.count}>{counts[status]}</span>
              <button
                type="button"
                className={css.add}
                aria-label={t('board.newInColumn')}
                onClick={() => {
                  setAdding(status)
                  // Focus after the input exists; the state update that renders it has not
                  // committed yet at this point.
                  requestAnimationFrame(() => draft.current?.focus())
                }}
              >
                <IconPlusOutline16 size={14} />
              </button>
            </header>

            <div className={css.scroll}>
              {adding === status && (
                <input
                  ref={draft}
                  className={css.draft}
                  placeholder={t('compose.newTaskTitle')}
                  aria-label={t('compose.newTaskTitle')}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      setAdding(undefined)
                      return
                    }
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    const title = event.currentTarget.value.trim()
                    if (title === '') return
                    onQuickAdd(status, title)
                    event.currentTarget.value = ''
                  }}
                  onBlur={() => { setAdding(undefined) }}
                />
              )}

              {column.length === 0 && adding !== status && (
                <p className={css.empty}>{t('empty.column')}</p>
              )}

              {column.map(task => (
                <div
                  key={task.id}
                  className={css.slot}
                  onDragOver={(event) => {
                    if (dragRef.current === undefined) return
                    event.preventDefault()
                    event.stopPropagation()
                    const box = event.currentTarget.getBoundingClientRect()
                    const above = event.clientY < box.top + box.height / 2
                    const index = column.findIndex(entry => entry.id === task.id)
                    aim({ status, beforeId: above ? task.id : column[index + 1]?.id })
                  }}
                  onKeyDown={(event) => {
                    if (!(event.metaKey || event.ctrlKey)) return
                    keyboardMove(task, event)
                  }}
                >
                  {hovered && drop?.beforeId === task.id && <div className={css.marker} aria-hidden="true" />}
                  <TaskCard
                    task={task}
                    selected={selectedId === task.id}
                    canDispatch={canDispatch}
                    canDelete={canDelete}
                    dragging={dragId !== undefined && dragId !== task.id}
                    onOpen={onOpen}
                    onMove={onMove}
                    onArchive={onArchive}
                    onDelete={onDelete}
                    onDispatch={onDispatch}
                    onStopRun={onStopRun}
                    onDragStart={beginDrag}
                    onDragEnd={clearDrag}
                    t={t}
                  />
                </div>
              ))}

              {hovered && drop?.beforeId === undefined && column.length > 0 && (
                <div className={css.marker} aria-hidden="true" />
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}
