/**
 * The whole board surface: toolbar, the active layout, and the detail panel over it.
 *
 * Owns only view state — which layout is showing, how the list is sorted, whether the new-task
 * composer is open. Everything durable arrives as props and every change leaves through a callback,
 * so this component can be rendered in a test with plain data and no host.
 *
 * @module @achasoft/dsh-tasks-manager/client/board/BoardScreen
 */

import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Button, IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BoardEmptyProps, BoardMode, BoardScreenProps, SortState } from './contract.ts'
import { Background } from './Background.tsx'
import { SessionTodos } from './SessionTodos.tsx'
import { Kanban } from './Kanban.tsx'
import { ListView } from './ListView.tsx'
import { TaskDetail } from './TaskDetail.tsx'
import { Toolbar } from './Toolbar.tsx'
import { activeFilterCount, collectLabels, composerStatus } from './format.ts'
import fields from './fields.module.css'
import css from './BoardScreen.module.css'

/** The zero state, in its two distinct forms. */
export function BoardEmpty({ filtered, onAction, t }: BoardEmptyProps) {
  return (
    <div className={css.empty}>
      <h3 className={css.emptyTitle}>{t(filtered ? 'empty.filtered.title' : 'empty.title')}</h3>
      <p className={css.emptyBody}>{t(filtered ? 'empty.filtered.body' : 'empty.body')}</p>
      <Button variant="primary" size="sm" onClick={onAction}>
        {t(filtered ? 'empty.filtered.action' : 'empty.action')}
      </Button>
    </div>
  )
}

/** Render the board screen. */
export function BoardScreen({
  view, error, busy, query, onQueryChange, detail, detailLoading, jobs, jobOutput,
  todos, promoted, onPromote, canDispatch, canDelete, assignees, assigneesAvailable,
  onRefresh, onCreate, defaultStatus, detailActions, taskActions, onJobRead, onJobKill, t,
}: BoardScreenProps) {
  const [mode, setMode] = useState<BoardMode>('kanban')
  const [sort, setSort] = useState<SortState>({ column: 'updatedAt', direction: 'desc' })
  const [composing, setComposing] = useState(false)
  const composer = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (composing) composer.current?.focus()
  }, [composing])

  if (error !== null) {
    return (
      <div className={clsx(css.screen, fields.fields)}>
        <div className={css.failure} role="alert">
          <h3 className={css.emptyTitle}>{t('board.unavailable')}</h3>
          <p className={css.emptyBody}>{error}</p>
          <Button variant="primary" size="sm" onClick={onRefresh}>{t('board.retry')}</Button>
        </div>
      </div>
    )
  }

  if (view === null) {
    return (
      <div className={clsx(css.screen, fields.fields)} aria-busy="true">
        <div className={css.skeletons}>
          {[0, 1, 2, 3, 4].map(index => <div key={index} className={css.skeletonColumn} />)}
        </div>
        <span className={css.srOnly} aria-live="polite">{t('board.loading')}</span>
      </div>
    )
  }

  const total = Object.values(view.counts).reduce((sum, count) => sum + count, 0)
  const filtered = activeFilterCount(query) > 0
  const running = jobs.filter(job => job.status === 'running' || job.status === 'stopping').length
  const knownLabels = collectLabels(view.tasks)

  return (
    <div className={clsx(css.screen, fields.fields)}>
      <Toolbar
        query={query}
        onQueryChange={onQueryChange}
        mode={mode}
        onModeChange={setMode}
        counts={view.counts}
        archivedCount={view.archivedCount}
        shown={view.tasks.length}
        total={total}
        runningJobs={running}
        knownLabels={knownLabels}
        onNewTask={() => { setComposing(true) }}
        onRefresh={onRefresh}
        busy={busy}
        t={t}
      />

      {composing && (
        <div className={css.composer}>
          <IconPlusOutline16 size={14} className={css.composerIcon} />
          <input
            ref={composer}
            className={css.composerInput}
            placeholder={t('compose.newTaskTitle')}
            aria-label={t('compose.newTaskTitle')}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.preventDefault(); setComposing(false); return }
              if (event.key !== 'Enter') return
              event.preventDefault()
              const title = event.currentTarget.value.trim()
              if (title === '') return
              // The composer is in no column, so the configured default decides where intake goes;
              // a column's own quick-add below passes that column instead.
              onCreate(title, composerStatus(query.status, defaultStatus))
              event.currentTarget.value = ''
            }}
            onBlur={() => { setComposing(false) }}
          />
          <span className={css.composerHint}>{t('compose.create')}</span>
        </div>
      )}

      <div className={css.body}>
        {mode === 'session'
          ? <SessionTodos todos={todos} promoted={promoted} onPromote={onPromote} t={t} />
          : mode === 'background'
            ? (
                <Background
                  jobs={jobs}
                  output={jobOutput}
                  onRead={onJobRead}
                  onKill={onJobKill}
                  onOpenTask={taskActions.onOpen}
                  t={t}
                />
              )
            : view.tasks.length === 0
            ? (
                <BoardEmpty
                  filtered={filtered}
                  onAction={() => { if (filtered) onQueryChange({}); else setComposing(true) }}
                  t={t}
                />
              )
            : mode === 'kanban'
              ? (
                  <Kanban
                    tasks={view.tasks}
                    counts={view.counts}
                    selectedId={detail?.task.id}
                    canDispatch={canDispatch}
                    canDelete={canDelete}
                    onQuickAdd={(status, title) => { onCreate(title, status) }}
                    {...taskActions}
                    t={t}
                  />
                )
              : (
                  <ListView
                    tasks={view.tasks}
                    selectedId={detail?.task.id}
                    sort={sort}
                    onSortChange={setSort}
                    canDispatch={canDispatch}
                    canDelete={canDelete}
                    {...taskActions}
                    t={t}
                  />
                )}

        {(detail !== null || detailLoading) && (
          <TaskDetail
            detail={detail}
            loading={detailLoading}
            canDispatch={canDispatch}
            canDelete={canDelete}
            assignees={assignees}
            assigneesAvailable={assigneesAvailable}
            knownLabels={knownLabels}
            {...detailActions}
            t={t}
          />
        )}
      </div>

      <footer className={css.foot}>
        <span className={css.path} title={view.databasePath}>{t('board.path', { path: view.databasePath })}</span>
      </footer>
    </div>
  )
}
