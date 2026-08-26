/**
 * This session's checklist, beside the project board.
 *
 * The list itself belongs to the harness: `todo_write` owns it, and it reaches the browser as the
 * `todos` session projection. This panel neither writes it nor duplicates it — it shows the
 * checklist next to the durable board so the two are visible together, and offers the one move that
 * connects them: promoting a step the session did not finish onto the board, where it survives.
 *
 * That distinction is the whole point of showing them side by side. The checklist is scratch: it is
 * cleared at the next turn and is gone when the session ends. The board is the project's.
 *
 * @module @achasoft/dsh-tasks-manager/client/board/SessionTodos
 */

import clsx from 'clsx'
import { Button, IconCheckOutline14, IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionTodosProps } from './contract.ts'
import css from './SessionTodos.module.css'

/** Render the session checklist panel. */
export function SessionTodos({ todos, onPromote, promoted, t }: SessionTodosProps) {
  if (todos === undefined) {
    return <p className={css.absent}>{t('session.unavailable')}</p>
  }

  if (todos.length === 0) {
    return (
      <div className={css.wrap}>
        <p className={css.hint}>{t('session.hint')}</p>
        <p className={css.empty}>{t('session.empty')}</p>
      </div>
    )
  }

  const done = todos.filter(todo => todo.status === 'completed').length

  return (
    <div className={css.wrap}>
      <p className={css.hint}>{t('session.hint')}</p>
      <p className={css.progress} aria-live="polite">
        {t('session.progress', { done, total: todos.length })}
      </p>
      <ol className={css.list}>
        {todos.map(todo => (
          <li key={todo.content} className={clsx(css.row, css[todo.status])}>
            <span className={css.mark} data-status={todo.status} aria-hidden="true">
              {todo.status === 'completed' ? <IconCheckOutline14 size={12} /> : null}
            </span>
            <span className={css.content}>{todo.content}</span>
            <span className={css.state}>{t(`session.status.${todo.status}`)}</span>
            {promoted.includes(todo.content)
              ? <span className={css.promoted}>{t('session.promoted')}</span>
              : (
                  <Button
                    size="sm"
                    icon={<IconPlusOutline16 size={12} />}
                    onClick={() => { onPromote(todo.content) }}
                  >
                    {t('session.promote')}
                  </Button>
                )}
          </li>
        ))}
      </ol>
    </div>
  )
}
