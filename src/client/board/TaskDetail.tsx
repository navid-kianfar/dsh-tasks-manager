/**
 * The card detail: everything about one task, and every way to change it.
 *
 * Editing follows one rule throughout — a field shows its value until you click it, then becomes an
 * editor that commits on `⌘/Ctrl+Enter` or blur and abandons on `Escape`. Nothing auto-saves while
 * you type: a board is edited in front of other people, and a half-typed title reaching the store
 * (and the agent's next read) is worse than an extra keystroke.
 *
 * @module @achasoft/dsh-tasks-manager/client/board/TaskDetail
 */

import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Button,
  IconCloseOutline16,
  IconLoadingOutline16,
  IconPlayOutline16,
  IconStopFill16,
  IconTrashOutline16,
  MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { TASK_PRIORITIES, TASK_STATUSES, type TaskPriority, type TaskStatus } from '../../domain/types.ts'
import type { TaskDetailProps } from './contract.ts'
import { describeActivity, describeDue, relativeTime, toDateText } from './format.ts'
import css from './TaskDetail.module.css'

/**
 * Whether a keyboard event is the platform's "commit this editor" chord.
 * @param event - the keydown.
 * @returns true for ⌘/Ctrl + Enter.
 */
function isCommit(event: React.KeyboardEvent): boolean {
  return event.key === 'Enter' && (event.metaKey || event.ctrlKey)
}

/** Render the card detail panel. */
export function TaskDetail({
  detail, loading, canDispatch, canDelete, onClose, onTitleChange, onBodyChange, onStatusChange,
  onPriorityChange, onLabelsChange, onAssigneeChange, onDueChange, onArchive, onDelete, onDispatch,
  onStopRun, onComment, onCommentEdit, onCommentDelete, t,
}: TaskDetailProps) {
  const [editingBody, setEditingBody] = useState(false)
  const [bodyDraft, setBodyDraft] = useState('')
  const [editingComment, setEditingComment] = useState<string | undefined>(undefined)
  const [showActivity, setShowActivity] = useState(false)
  const [comment, setComment] = useState('')
  const panel = useRef<HTMLElement | null>(null)
  const task = detail?.task

  // Each card opens with its own editing state: leaving one mid-edit and opening another must not
  // carry the first card's draft into the second.
  useEffect(() => {
    setEditingBody(false)
    setEditingComment(undefined)
    setShowActivity(false)
    setComment('')
  }, [task?.id])

  useEffect(() => {
    /**
     * Close the panel on Escape unless an editor is holding the key.
     * @param event - the keydown.
     */
    function onKey(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      const inside = panel.current?.contains(document.activeElement)
      const editing = inside === true && document.activeElement instanceof HTMLElement
        && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)
      if (editing) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [onClose])

  if (task === undefined) {
    return (
      <aside className={css.panel} aria-busy={loading}>
        <div className={css.loading}>{loading ? t('board.loading') : ''}</div>
      </aside>
    )
  }

  const due = describeDue(task.dueAt, Date.now(), t)
  const running = task.runningJobId !== undefined

  return (
    <aside className={css.panel} ref={panel} aria-label={`#${task.ref} ${task.title}`}>
      <header className={css.head}>
        <span className={css.ref}>#{task.ref}</span>
        {task.archived && <span className={css.badge}>{t('card.archivedBadge')}</span>}
        <span className={css.spacer} />
        <button type="button" className={css.iconButton} aria-label={t('detail.close')} onClick={onClose}>
          <IconCloseOutline16 size={16} />
        </button>
      </header>

      <div className={css.scroll}>
        <input
          className={css.title}
          defaultValue={task.title}
          key={`${task.id}:${task.title}`}
          placeholder={t('detail.titlePlaceholder')}
          aria-label={t('detail.titlePlaceholder')}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.currentTarget.value = task.title
              event.currentTarget.blur()
              return
            }
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
          onBlur={(event) => {
            const next = event.currentTarget.value.trim()
            if (next !== '' && next !== task.title) onTitleChange(task.id, next)
            else event.currentTarget.value = task.title
          }}
        />

        <dl className={css.fields}>
          <div className={css.field}>
            <dt className={css.label}>{t('detail.status')}</dt>
            <dd className={css.value}>
              <select
                className={css.select}
                value={task.status}
                aria-label={t('detail.status')}
                onChange={(event) => { onStatusChange(task.id, event.currentTarget.value as TaskStatus) }}
              >
                {TASK_STATUSES.map(status => (
                  <option key={status} value={status}>{t(`status.${status}`)}</option>
                ))}
              </select>
            </dd>
          </div>
          <div className={css.field}>
            <dt className={css.label}>{t('detail.priority')}</dt>
            <dd className={css.value}>
              <select
                className={css.select}
                value={task.priority}
                aria-label={t('detail.priority')}
                onChange={(event) => { onPriorityChange(task.id, event.currentTarget.value as TaskPriority) }}
              >
                {TASK_PRIORITIES.map(priority => (
                  <option key={priority} value={priority}>{t(`priority.${priority}`)}</option>
                ))}
              </select>
            </dd>
          </div>
          <div className={css.field}>
            <dt className={css.label}>{t('detail.assignee')}</dt>
            <dd className={css.value}>
              <input
                className={css.input}
                key={`${task.id}:assignee:${task.assignee ?? ''}`}
                defaultValue={task.assignee ?? ''}
                placeholder={t('detail.assigneePlaceholder')}
                aria-label={t('detail.assignee')}
                onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
                onBlur={(event) => {
                  const next = event.currentTarget.value.trim()
                  if (next !== (task.assignee ?? '')) onAssigneeChange(task.id, next)
                }}
              />
            </dd>
          </div>
          <div className={css.field}>
            <dt className={css.label}>{t('detail.due')}</dt>
            <dd className={css.value}>
              <input
                className={clsx(css.input, css.date)}
                type="date"
                key={`${task.id}:due:${task.dueAt ?? ''}`}
                defaultValue={task.dueAt === undefined ? '' : toDateText(task.dueAt)}
                aria-label={t('detail.due')}
                onChange={(event) => { onDueChange(task.id, event.currentTarget.value) }}
              />
              {due !== undefined && due.tone !== 'none' && (
                <span className={css.dueTone} data-tone={due.tone}>{due.text}</span>
              )}
            </dd>
          </div>
          <div className={clsx(css.field, css.wide)}>
            <dt className={css.label}>{t('detail.labels')}</dt>
            <dd className={css.value}>
              <input
                className={css.input}
                key={`${task.id}:labels:${task.labels.join(',')}`}
                defaultValue={task.labels.join(', ')}
                placeholder={t('detail.labelsPlaceholder')}
                aria-label={t('detail.labels')}
                onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
                onBlur={(event) => {
                  const next = event.currentTarget.value
                    .split(',')
                    .map(entry => entry.trim())
                    .filter(entry => entry !== '')
                  if (next.join(',') !== task.labels.join(',')) onLabelsChange(task.id, next)
                }}
              />
            </dd>
          </div>
        </dl>

        <section className={css.section}>
          <header className={css.sectionHead}>
            <h4 className={css.sectionTitle}>{t('detail.description')}</h4>
            {!editingBody && (
              <button
                type="button"
                className={css.link}
                onClick={() => { setBodyDraft(task.body); setEditingBody(true) }}
              >
                {t('detail.edit')}
              </button>
            )}
          </header>
          {editingBody
            ? (
                <div className={css.editor}>
                  <textarea
                    className={css.textarea}
                    value={bodyDraft}
                    autoFocus
                    aria-label={t('detail.description')}
                    onChange={(event) => { setBodyDraft(event.currentTarget.value) }}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') { event.preventDefault(); setEditingBody(false); return }
                      if (!isCommit(event)) return
                      event.preventDefault()
                      onBodyChange(task.id, bodyDraft)
                      setEditingBody(false)
                    }}
                  />
                  <div className={css.editorFoot}>
                    <span className={css.hint}>{t('detail.saveHint')}</span>
                    <Button size="sm" onClick={() => { setEditingBody(false) }}>{t('detail.cancel')}</Button>
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => { onBodyChange(task.id, bodyDraft); setEditingBody(false) }}
                    >
                      {t('detail.save')}
                    </Button>
                  </div>
                </div>
              )
            : task.body === ''
              ? <p className={css.muted}>{t('detail.noDescription')}</p>
              : <div className={css.markdown}><MarkdownText text={task.body} /></div>}
        </section>

        {canDispatch && !task.archived && (
          <section className={css.section}>
            <div className={css.dispatch}>
              {running
                ? (
                    <>
                      <span className={css.runningPill}>
                        <IconLoadingOutline16 size={14} className={css.spin} />
                        {t('detail.dispatchRunning')}
                      </span>
                      <Button
                        size="sm"
                        icon={<IconStopFill16 size={14} />}
                        onClick={() => { onStopRun(task.runningJobId as string) }}
                      >
                        {t('detail.dispatchStop')}
                      </Button>
                    </>
                  )
                : (
                    <Button
                      size="sm"
                      variant="outline"
                      icon={<IconPlayOutline16 size={14} />}
                      onClick={() => { onDispatch(task.id) }}
                    >
                      {t('detail.dispatch')}
                    </Button>
                  )}
              <span className={css.hint}>{t('detail.dispatchHint')}</span>
            </div>
            {task.lastRun !== undefined && !running && (
              <p className={css.muted}>
                {t('detail.lastRun', { status: t(`jobs.status.${task.lastRun.status}`) })}
                {task.lastRun.detail === undefined ? '' : ` — ${task.lastRun.detail}`}
              </p>
            )}
          </section>
        )}

        <section className={css.section}>
          <header className={css.sectionHead}>
            <h4 className={css.sectionTitle}>{t('detail.comments')}</h4>
            <span className={css.count}>{detail?.comments.length ?? 0}</span>
          </header>

          {(detail?.comments.length ?? 0) === 0 && <p className={css.muted}>{t('detail.noComments')}</p>}

          <ol className={css.comments}>
            {detail?.comments.map(entry => (
              <li key={entry.id} className={css.comment}>
                <div className={css.commentHead}>
                  <span className={css.author} data-author={entry.author}>{t(`author.${entry.author}`)}</span>
                  <span className={css.time}>{relativeTime(entry.createdAt, Date.now(), t)}</span>
                  <span className={css.spacer} />
                  <button
                    type="button"
                    className={css.link}
                    onClick={() => { setEditingComment(current => (current === entry.id ? undefined : entry.id)) }}
                  >
                    {t('detail.commentEdit')}
                  </button>
                  <button
                    type="button"
                    className={clsx(css.link, css.danger)}
                    onClick={() => { onCommentDelete(entry.id) }}
                  >
                    {t('detail.commentDelete')}
                  </button>
                </div>
                {editingComment === entry.id
                  ? (
                      <textarea
                        className={css.textarea}
                        defaultValue={entry.body}
                        autoFocus
                        aria-label={t('detail.commentEdit')}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') { event.preventDefault(); setEditingComment(undefined); return }
                          if (!isCommit(event)) return
                          event.preventDefault()
                          const next = event.currentTarget.value.trim()
                          if (next !== '' && next !== entry.body) onCommentEdit(entry.id, next)
                          setEditingComment(undefined)
                        }}
                      />
                    )
                  : <div className={css.markdown}><MarkdownText text={entry.body} /></div>}
              </li>
            ))}
          </ol>

          <div className={css.composer}>
            <textarea
              className={css.textarea}
              value={comment}
              placeholder={t('detail.commentPlaceholder')}
              aria-label={t('detail.commentPlaceholder')}
              onChange={(event) => { setComment(event.currentTarget.value) }}
              onKeyDown={(event) => {
                if (!isCommit(event)) return
                event.preventDefault()
                if (comment.trim() === '') return
                onComment(task.id, comment.trim())
                setComment('')
              }}
            />
            <div className={css.editorFoot}>
              <span className={css.hint}>{t('detail.saveHint')}</span>
              <Button
                size="sm"
                variant="primary"
                disabled={comment.trim() === ''}
                onClick={() => { onComment(task.id, comment.trim()); setComment('') }}
              >
                {t('detail.commentSubmit')}
              </Button>
            </div>
          </div>
        </section>

        <section className={css.section}>
          <button
            type="button"
            className={css.link}
            aria-expanded={showActivity}
            onClick={() => { setShowActivity(open => !open) }}
          >
            {showActivity
              ? t('detail.activityHide')
              : t('detail.activityShow', { count: detail?.activity.length ?? 0 })}
          </button>
          {showActivity && (
            <ol className={css.activity}>
              {detail?.activity.map(entry => (
                <li key={entry.seq} className={css.activityRow}>
                  <span className={css.author} data-author={entry.actor}>{t(`author.${entry.actor}`)}</span>
                  <span className={css.activityText}>{describeActivity(entry, t)}</span>
                  <span className={css.time}>{relativeTime(entry.at, Date.now(), t)}</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <footer className={css.foot}>
          <span className={css.time}>{t('detail.created', { date: toDateText(task.createdAt) })}</span>
          <span className={css.spacer} />
          <Button size="sm" onClick={() => { onArchive(task.id, !task.archived) }}>
            {task.archived ? t('card.restore') : t('card.archive')}
          </Button>
          {canDelete && (
            <Button
              size="sm"
              className={css.dangerButton}
              icon={<IconTrashOutline16 size={14} />}
              onClick={() => { onDelete(task.id) }}
            >
              {t('card.delete')}
            </Button>
          )}
        </footer>
      </div>
    </aside>
  )
}
