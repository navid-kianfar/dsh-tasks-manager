/**
 * The background-task panel: every job this session can see, whatever started it.
 *
 * Deliberately not limited to cards dispatched from the board. A panel called "Background tasks"
 * that hid the shell command running in the same session would be lying about what is running, so
 * it lists `bash` and `subagent` jobs beside this plugin's own and labels each with its kind.
 *
 * Output is read on demand rather than streamed: the registry's read is a consuming cursor, so
 * polling it in the background would silently eat the deltas the agent itself is waiting to read.
 *
 * @module @achasoft/dsh-tasks-manager/client/board/Background
 */

import clsx from 'clsx'
import {
  Button,
  IconLoadingOutline16,
  IconRightUpOutline16,
  IconStopFill16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { BackgroundProps } from './contract.ts'
import { duration } from './format.ts'
import css from './Background.module.css'

/** Render the background-task panel. */
export function Background({ jobs, output, onRead, onKill, onOpenTask, t }: BackgroundProps) {
  const now = Date.now()

  return (
    <div className={css.wrap}>
      <p className={css.hint}>{t('jobs.hint')}</p>

      {jobs.length === 0 && <p className={css.empty}>{t('jobs.empty')}</p>}

      <ol className={css.list}>
        {jobs.map((job) => {
          const live = job.status === 'running' || job.status === 'stopping'
          const text = output[job.id]
          return (
            <li key={job.id} className={clsx(css.job, live && css.live)}>
              <div className={css.head}>
                <span className={css.kind}>{job.kind}</span>
                <span className={css.label}>{job.label}</span>
                <span className={clsx(css.status, css[job.status])}>
                  {live && <IconLoadingOutline16 size={12} className={css.spin} />}
                  {t(`jobs.status.${job.status}`)}
                </span>
              </div>

              <div className={css.meta}>
                <span className={css.time}>
                  {job.finishedAt === undefined
                    ? t('jobs.elapsed', { duration: duration(now - job.startedAt) })
                    : t('jobs.finished', { duration: duration(job.finishedAt - job.startedAt) })}
                </span>
                {job.detail !== undefined && <span className={css.detail}>{job.detail}</span>}
                <span className={css.spacer} />
                {job.taskId !== undefined && (
                  <button
                    type="button"
                    className={css.link}
                    onClick={() => { onOpenTask(job.taskId as string) }}
                  >
                    {t('card.open')}
                    <IconRightUpOutline16 size={12} />
                  </button>
                )}
                <Button size="sm" onClick={() => { onRead(job.id) }}>{t('jobs.read')}</Button>
                {live && (
                  <Button size="sm" icon={<IconStopFill16 size={12} />} onClick={() => { onKill(job.id) }}>
                    {t('jobs.kill')}
                  </Button>
                )}
              </div>

              {text !== undefined && (
                <pre className={css.output}>{text === '' ? t('jobs.noOutput') : text}</pre>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
