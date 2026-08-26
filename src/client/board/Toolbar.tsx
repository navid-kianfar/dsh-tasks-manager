/**
 * The board header: search, filters, the layout switch, and the New task action.
 *
 * The search box is debounced locally rather than filtering on every keystroke, because each change
 * is a host round trip; the filter menus commit immediately, because each is one deliberate click.
 *
 * @module @achasoft/dsh-tasks-manager/client/board/Toolbar
 */

import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Button,
  IconCloseFill14,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconSearchOutline16,
  Menu,
  Pill,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { TASK_PRIORITIES, TASK_STATUSES } from '../../domain/types.ts'
import type { BoardMode, ToolbarProps } from './contract.ts'
import { activeFilterCount } from './format.ts'
import css from './Toolbar.module.css'

/** How long the search box waits after the last keystroke before it asks the host. */
const SEARCH_DEBOUNCE_MS = 250

/** The three archive states, as a segmented control. */
const ARCHIVE_MODES = ['active', 'archived', 'all'] as const

/** Render the board toolbar. */
export function Toolbar({
  query, onQueryChange, mode, onModeChange, counts, archivedCount, shown, total, runningJobs,
  knownLabels, onNewTask, onRefresh, busy, t,
}: ToolbarProps) {
  const [text, setText] = useState(query.search ?? '')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const committed = useRef(query.search ?? '')

  // The box follows the query when it changes from outside (a cleared filter set), but must not
  // fight the person typing — so it only re-seeds when the committed value actually moved.
  useEffect(() => {
    const next = query.search ?? ''
    if (next === committed.current) return
    committed.current = next
    setText(next)
  }, [query.search])

  useEffect(() => {
    if (text === (query.search ?? '')) return
    const timer = setTimeout(() => {
      committed.current = text
      onQueryChange({ ...query, ...text === '' ? { search: undefined } : { search: text } })
    }, SEARCH_DEBOUNCE_MS)
    return () => { clearTimeout(timer) }
  }, [text, query, onQueryChange])

  const filters = activeFilterCount(query)

  /**
   * Toggle one value inside a multi-select filter.
   * @param key - which filter list to change.
   * @param value - the value clicked.
   */
  function toggle(key: 'status' | 'priority' | 'labels', value: string): void {
    const current = (query[key] ?? []) as readonly string[]
    const next = current.includes(value) ? current.filter(entry => entry !== value) : [...current, value]
    onQueryChange({ ...query, [key]: next.length === 0 ? undefined : next } as typeof query)
  }

  const filterItems: MenuEntry[] = [
    { type: 'label', id: 'l-status', text: t('list.status') },
    ...TASK_STATUSES.map(status => ({ id: `status:${status}`, label: t(`status.${status}`) })),
    { type: 'separator', id: 's1' },
    { type: 'label', id: 'l-priority', text: t('list.priority') },
    ...TASK_PRIORITIES.map(priority => ({ id: `priority:${priority}`, label: t(`priority.${priority}`) })),
    ...knownLabels.length === 0 ? [] : [
      { type: 'separator', id: 's2' } as MenuEntry,
      { type: 'label', id: 'l-labels', text: t('list.labels') } as MenuEntry,
      ...knownLabels.map(label => ({ id: `labels:${label}`, label })),
    ],
  ]

  const selectedFilterIds = [
    ...(query.status ?? []).map(value => `status:${value}`),
    ...(query.priority ?? []).map(value => `priority:${value}`),
    ...(query.labels ?? []).map(value => `labels:${value}`),
  ]

  return (
    <header className={css.bar}>
      <div className={css.left}>
        <span className={css.searchSeat}>
          <IconSearchOutline16 size={14} className={css.searchIcon} />
          <input
            className={css.search}
            type="search"
            value={text}
            placeholder={t('board.search')}
            aria-label={t('board.search')}
            onChange={(event) => { setText(event.currentTarget.value) }}
          />
          {text !== '' && (
            <button
              type="button"
              className={css.clearSearch}
              aria-label={t('board.searchClear')}
              onClick={() => { setText('') }}
            >
              <IconCloseFill14 size={12} />
            </button>
          )}
        </span>

        <Menu
          open={filtersOpen}
          portal
          items={filterItems}
          selectedIds={selectedFilterIds}
          onSelect={(id) => {
            const at = id.indexOf(':')
            if (at < 0) return
            toggle(id.slice(0, at) as 'status' | 'priority' | 'labels', id.slice(at + 1))
          }}
          onClose={() => { setFiltersOpen(false) }}
          anchor={
            <Pill
              active={filters > 0}
              aria-haspopup="menu"
              aria-expanded={filtersOpen}
              onClick={() => { setFiltersOpen(open => !open) }}
            >
              {filters === 0 ? t('board.filters') : t('board.filtersActive', { count: filters })}
            </Pill>
          }
        />

        {filters > 0 && (
          <button type="button" className={css.clear} onClick={() => { onQueryChange({}) }}>
            {t('board.clearFilters')}
          </button>
        )}

        <span className={css.segmented} role="group" aria-label={t('board.archived.active')}>
          {ARCHIVE_MODES.map(value => (
            <button
              key={value}
              type="button"
              className={clsx(css.segment, (query.archived ?? 'active') === value && css.segmentActive)}
              aria-pressed={(query.archived ?? 'active') === value}
              onClick={() => {
                onQueryChange({ ...query, archived: value === 'active' ? undefined : value })
              }}
            >
              {t(`board.archived.${value}`)}
              {value === 'archived' && archivedCount > 0 && <span className={css.segmentCount}>{archivedCount}</span>}
            </button>
          ))}
        </span>
      </div>

      <div className={css.right}>
        <span className={css.showing}>
          {t('board.showing', { count: shown, total })}
        </span>

        <span className={css.segmented} role="group" aria-label={t('view.tasks')}>
          {(['kanban', 'list', 'background'] as const).map((value: BoardMode) => (
            <button
              key={value}
              type="button"
              className={clsx(css.segment, mode === value && css.segmentActive)}
              aria-pressed={mode === value}
              onClick={() => { onModeChange(value) }}
            >
              {value === 'background' && runningJobs > 0
                ? t('board.backgroundCount', { count: runningJobs })
                : t(`board.${value}`)}
            </button>
          ))}
        </span>

        <button
          type="button"
          className={css.icon}
          aria-label={t('board.refresh')}
          data-busy={busy || undefined}
          onClick={onRefresh}
        >
          <IconRefreshOutline16 size={14} />
        </button>

        <Button variant="primary" size="sm" icon={<IconPlusOutline16 size={14} />} onClick={onNewTask}>
          {t('board.newTask')}
        </Button>
      </div>

      {/* The counts change under the reader when the agent writes to the board, so they are
          announced rather than only drawn. */}
      <span className={css.srOnly} aria-live="polite">
        {TASK_STATUSES.map(status => `${t(`status.${status}`)} ${counts[status]}`).join(', ')}
      </span>
    </header>
  )
}
