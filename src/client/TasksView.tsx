/**
 * The Tasks view: the container that owns board state and every call to the host.
 *
 * It sits in the `conversation.view` ring beside Chat and Trajectory, so it occupies the whole
 * centre column and the shipped tab strip switches to it with no navigation of our own.
 *
 * Freshness comes from polling one integer. The board is not derived from the session log — an
 * out-of-tree plugin cannot append its own session events without making the log unreloadable — and
 * polling is the only mechanism that also covers the changes a log could never carry: another
 * session's writes, and a person editing `.dsh/tasks.db` with `sqlite3`. Only `board.revision` is
 * polled; the cards are re-read solely when it moves.
 *
 * @module @achasoft/dsh-tasks-manager/client/TasksView
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { BoardView, TaskDetail as TaskDetailData, TaskPatch, TaskPlacement, TaskPriority, TaskQuery, TaskStatus } from '../domain/types.ts'
import { TASK_STATUSES } from '../domain/types.ts'
import type { GitAuthor, JobView } from '../host/protocol.ts'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls tool-todo's `todos` SessionProjectionMap merge so `useProjection('todos')` types.
import type {} from '@deepseek-ai/dsh-tool-todo/client'
import type { UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
import type { Config } from '../host/index.ts'
import type { TasksApi } from './rpc.ts'
import { TasksApiError } from './rpc.ts'
import { BoardScreen } from './board/BoardScreen.tsx'
import { ConfirmDialog, type ConfirmRequest } from './board/ConfirmDialog.tsx'
import type { BoardTranslate } from './board/contract.ts'

/** What the slot registration injects into this view. */
export interface TasksViewInjected {
  /** The typed caller for this plugin's RPC channel. */
  api: TasksApi
  /**
   * The board's own settings, as a hook source.
   *
   * Read reactively rather than snapshotted at registration, so changing the poll interval or
   * naming a subagent provider in Settings reaches an already-open board without a reload.
   */
  hooks: { taskSettings: SettingsScope<Config> }
}

/** Everything this view needs, as the framework composes it. */
export type TasksViewProps = {
  /** The typed caller for this plugin's RPC channel. */
  api: TasksApi
  /** Selector hook over this plugin's settings section. */
  useTaskSettings: <S>(select: (snapshot: SettingsScopeSnapshot<Config>) => S) => S
  /** The framework-resolved session id. */
  sessionId: string
  /**
   * The framework's key-addressed projection reader.
   *
   * Used for the `todos` key, which `@deepseek-ai/dsh-tool-todo` owns: the session checklist is the
   * harness's, and this view reads it rather than keeping one of its own.
   */
  useProjection: UseProjection
  /** Translate, bound to this plugin's namespace. */
  t: BoardTranslate
}

/** Poll interval used until the settings section has been read. */
const FALLBACK_POLL_MS = 2000

/**
 * Sort cards the way the board renders them: by column, then by rank inside it.
 *
 * Applied after an optimistic single-card update so a dragged card lands in its new place
 * immediately instead of waiting out the next full read.
 * @param tasks - the cards to order.
 * @returns a new ordered array.
 */
function inBoardOrder(tasks: BoardView['tasks']): BoardView['tasks'] {
  return [...tasks].sort((a, b) => {
    const lane = TASK_STATUSES.indexOf(a.status) - TASK_STATUSES.indexOf(b.status)
    if (lane !== 0) return lane
    return a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.createdAt - b.createdAt
  })
}

/** Render the Tasks view. */
export function TasksView({ api, useTaskSettings, useProjection, sessionId, t }: TasksViewProps) {
  // Three states, and collapsing any two of them tells the reader something false. `undefined` is
  // the framework's uniform "capability absent" — no todo plugin composed, so there is no checklist
  // to speak of. `null` is the unit's own pre-first-write state: the checklist exists and is empty.
  // An array is the list. `?? []` would claim an unavailable capability was merely empty.
  const projectedTodos = useProjection('todos')
  const todos = projectedTodos === undefined ? undefined : projectedTodos ?? []
  const [promoted, setPromoted] = useState<string[]>([])
  const pollIntervalMs = useTaskSettings(snapshot => snapshot.value?.pollIntervalMs ?? FALLBACK_POLL_MS)
  const canDispatch = useTaskSettings(snapshot => (snapshot.value?.subagentProvider ?? '') !== '')
  // Deleting is always offered to the PERSON whose board this is; `allowDelete` gates the model's
  // tool, not this UI, and hiding the control here would leave no way to remove a card by hand.
  const canDelete = true
  const [view, setView] = useState<BoardView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState<TaskQuery>({})
  const [openId, setOpenId] = useState<string | undefined>(undefined)
  const [detail, setDetail] = useState<TaskDetailData | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [jobs, setJobs] = useState<readonly JobView[]>([])
  const [jobOutput, setJobOutput] = useState<Record<string, string>>({})
  const [assignees, setAssignees] = useState<{ authors: readonly GitAuthor[]; available: boolean }>(
    { authors: [], available: false },
  )
  const [confirming, setConfirming] = useState<ConfirmRequest | null>(null)

  const revision = useRef(-1)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  /**
   * Turn a rejected call into a message for the person who caused it.
   * @param cause - the thrown value.
   * @returns the message to show.
   */
  const explain = useCallback((cause: unknown): string => {
    if (cause instanceof TasksApiError) return cause.message
    return cause instanceof Error ? cause.message : String(cause)
  }, [])

  const loadBoard = useCallback(async (next: TaskQuery): Promise<void> => {
    try {
      const result = await api.call('board.read', { sessionId, query: next })
      if (!alive.current) return
      setView(result)
      setError(null)
    } catch (cause) {
      if (!alive.current) return
      setError(explain(cause))
    }
  }, [api, sessionId, explain])

  const loadJobs = useCallback(async (): Promise<void> => {
    try {
      const result = await api.call('jobs.list', { sessionId })
      if (alive.current) setJobs(result.jobs)
    } catch {
      // The job registry is optional: a deployment without it simply has no background tasks, and
      // an empty panel says that better than an error the user cannot act on.
      if (alive.current) setJobs([])
    }
  }, [api, sessionId])

  // Read once per mount and again on an explicit refresh, not on the poll: a project's committers
  // change at the speed of `git commit`, and the host caches the answer for a minute anyway.
  const loadAssignees = useCallback(async (): Promise<void> => {
    try {
      const result = await api.call('git.authors', { sessionId })
      if (alive.current) setAssignees({ authors: result.authors, available: result.available })
    } catch {
      // No git, no repository, or a host too old to answer: the picker says so, and the board is
      // perfectly usable without an assignee.
      if (alive.current) setAssignees({ authors: [], available: false })
    }
  }, [api, sessionId])

  const loadDetail = useCallback(async (taskId: string): Promise<void> => {
    setDetailLoading(true)
    try {
      const result = await api.call('task.detail', { sessionId, taskId })
      if (alive.current) setDetail(result)
    } catch (cause) {
      if (!alive.current) return
      // The card is gone (another session deleted it); close rather than stranding an empty panel.
      setDetail(null)
      setOpenId(undefined)
      setError(explain(cause))
    } finally {
      if (alive.current) setDetailLoading(false)
    }
  }, [api, sessionId, explain])

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      await Promise.all([
        loadBoard(query),
        loadJobs(),
        loadAssignees(),
        ...openId === undefined ? [] : [loadDetail(openId)],
      ])
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [loadBoard, loadJobs, loadAssignees, loadDetail, query, openId])

  // The filters are a host-side query, so changing them is a read, not a client-side filter.
  useEffect(() => { void loadBoard(query) }, [loadBoard, query])
  useEffect(() => { void loadJobs() }, [loadJobs])
  useEffect(() => { void loadAssignees() }, [loadAssignees])
  useEffect(() => {
    if (openId === undefined) { setDetail(null); return }
    void loadDetail(openId)
  }, [openId, loadDetail])

  // One integer per tick. The board is re-read only when the counter actually moved, so an idle
  // board costs a single small request at the configured interval and nothing else.
  useEffect(() => {
    let cancelled = false
    const timer = setInterval(() => {
      void (async () => {
        try {
          const result = await api.call('board.revision', { sessionId })
          if (cancelled || !alive.current) return
          const running = jobs.some(job => job.status === 'running' || job.status === 'stopping')
          if (running) void loadJobs()
          if (result.revision === revision.current) return
          revision.current = result.revision
          await loadBoard(query)
          if (openId !== undefined) await loadDetail(openId)
        } catch {
          // A poll that fails is not worth a banner: the next tick either recovers or the user's
          // own next action surfaces the real error with context.
        }
      })()
    }, pollIntervalMs)
    return () => { cancelled = true; clearInterval(timer) }
  }, [api, sessionId, pollIntervalMs, query, openId, jobs, loadBoard, loadDetail, loadJobs])

  /**
   * Run one mutation, fold its returned card into the board, and keep the detail in step.
   * @param work - the call to run.
   */
  const mutate = useCallback(async (work: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (cause) {
      if (alive.current) setError(explain(cause))
      // The local view may now disagree with the store, so re-read rather than leaving it wrong.
      await loadBoard(query)
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [explain, loadBoard, query])

  /**
   * Fold one server-returned card into the local board without a full re-read.
   *
   * The card comes back from the mutation that changed it, so this is the store's own value rather
   * than a guess — the board updates at once and the next poll confirms it.
   * @param task - the updated card.
   */
  const applyTask = useCallback((task: BoardView['tasks'][number]): void => {
    setView((current) => {
      if (current === null) return current
      const archivedFilter = query.archived ?? 'active'
      const visible = archivedFilter === 'all' || (archivedFilter === 'archived') === task.archived
      const without = current.tasks.filter(entry => entry.id !== task.id)
      return { ...current, tasks: inBoardOrder(visible ? [...without, task] : without) }
    })
    setDetail(current => (current === null || current.task.id !== task.id ? current : { ...current, task }))
  }, [query.archived])

  const patch = useCallback((taskId: string, value: TaskPatch) => {
    void mutate(async () => {
      applyTask(await api.call('task.update', { sessionId, taskId, patch: value }))
      if (openId === taskId) await loadDetail(taskId)
    })
  }, [mutate, applyTask, api, sessionId, openId, loadDetail])

  const promote = useCallback((content: string) => {
    void mutate(async () => {
      await api.call('task.create', { sessionId, task: { title: content } })
      if (alive.current) setPromoted(current => [...current, content])
      await loadBoard(query)
    })
  }, [mutate, api, sessionId, loadBoard, query])

  const create = useCallback((title: string, status: TaskStatus) => {
    void mutate(async () => {
      await api.call('task.create', { sessionId, task: { title, status } })
      await loadBoard(query)
    })
  }, [mutate, api, sessionId, loadBoard, query])

  const move = useCallback((taskId: string, status: TaskStatus, place: TaskPlacement) => {
    void mutate(async () => {
      applyTask(await api.call('task.move', { sessionId, taskId, status, place }))
    })
  }, [mutate, applyTask, api, sessionId])

  const archive = useCallback((taskId: string, archived: boolean) => {
    void mutate(async () => {
      await api.call(archived ? 'task.archive' : 'task.restore', { sessionId, taskId })
      await loadBoard(query)
      if (openId === taskId) await loadDetail(taskId)
    })
  }, [mutate, api, sessionId, loadBoard, query, openId, loadDetail])

  const remove = useCallback((taskId: string) => {
    const target = view?.tasks.find(entry => entry.id === taskId)
    setConfirming({
      title: t('confirm.deleteTitle', { ref: target?.ref ?? '' }),
      description: t('confirm.delete'),
      confirmLabel: t('confirm.deleteAction'),
      onConfirm: () => {
        void mutate(async () => {
          await api.call('task.delete', { sessionId, taskId })
          if (openId === taskId) setOpenId(undefined)
          await loadBoard(query)
        })
      },
    })
  }, [view, t, mutate, api, sessionId, openId, loadBoard, query])

  const dispatch = useCallback((taskId: string) => {
    void mutate(async () => {
      const result = await api.call('task.dispatch', { sessionId, taskId })
      applyTask(result.task)
      await loadJobs()
    })
  }, [mutate, api, sessionId, applyTask, loadJobs])

  const comment = useCallback((taskId: string, body: string) => {
    void mutate(async () => {
      await api.call('comment.add', { sessionId, taskId, body })
      await loadDetail(taskId)
    })
  }, [mutate, api, sessionId, loadDetail])

  const jobRead = useCallback((jobId: string) => {
    void mutate(async () => {
      const result = await api.call('jobs.read', { sessionId, jobId })
      if (!alive.current) return
      // Deltas accumulate: the registry's read consumes, so discarding the previous text would lose
      // output no second read can return.
      setJobOutput(current => ({ ...current, [jobId]: (current[jobId] ?? '') + result.text }))
      await loadJobs()
    })
  }, [mutate, api, sessionId, loadJobs])

  const jobKill = useCallback((jobId: string) => {
    void mutate(async () => {
      await api.call('jobs.kill', { sessionId, jobId })
      await loadJobs()
    })
  }, [mutate, api, sessionId, loadJobs])

  return (
    <>
      <BoardScreen
        view={view}
        error={error}
        busy={busy}
        query={query}
        onQueryChange={setQuery}
        detail={detail}
        detailLoading={detailLoading}
        jobs={jobs}
        jobOutput={jobOutput}
        todos={todos}
        promoted={promoted}
        onPromote={promote}
        canDispatch={canDispatch}
        canDelete={canDelete}
        assignees={assignees.authors}
        assigneesAvailable={assignees.available}
        onRefresh={() => { void refresh() }}
        onCreate={create}
        onJobRead={jobRead}
        onJobKill={jobKill}
        taskActions={{
          onOpen: setOpenId,
          onMove: move,
          onArchive: archive,
          onDelete: remove,
          onDispatch: dispatch,
          onStopRun: jobKill,
        }}
        detailActions={{
          onClose: () => { setOpenId(undefined) },
          onTitleChange: (taskId, title) => { patch(taskId, { title }) },
          onBodyChange: (taskId, body) => { patch(taskId, { body: body.trim() === '' ? null : body }) },
          onStatusChange: (taskId, status) => { patch(taskId, { status }) },
          onPriorityChange: (taskId, priority: TaskPriority) => { patch(taskId, { priority }) },
          onLabelsChange: (taskId, labels) => { patch(taskId, { labels: labels.length === 0 ? null : labels }) },
          onAssigneeChange: (taskId, assignee) => { patch(taskId, { assignee: assignee === '' ? null : assignee }) },
          onDueChange: (taskId, date) => {
            const at = date === '' ? null : Date.parse(`${date}T00:00:00.000Z`)
            patch(taskId, { dueAt: at === null || Number.isNaN(at) ? null : at })
          },
          onArchive: archive,
          onDelete: remove,
          onDispatch: dispatch,
          onStopRun: jobKill,
          onComment: comment,
          onCommentEdit: (commentId, body) => {
            void mutate(async () => {
              await api.call('comment.edit', { sessionId, commentId, body })
              if (openId !== undefined) await loadDetail(openId)
            })
          },
          onCommentDelete: (commentId) => {
            setConfirming({
              title: t('confirm.deleteCommentTitle'),
              description: t('confirm.deleteComment'),
              confirmLabel: t('confirm.deleteCommentAction'),
              onConfirm: () => {
                void mutate(async () => {
                  await api.call('comment.remove', { sessionId, commentId })
                  if (openId !== undefined) await loadDetail(openId)
                })
              },
            })
          },
        }}
        t={t}
      />
      <ConfirmDialog
        request={confirming}
        onClose={() => { setConfirming(null) }}
        cancelLabel={t('confirm.cancel')}
        closeLabel={t('confirm.close')}
      />
    </>
  )
}
