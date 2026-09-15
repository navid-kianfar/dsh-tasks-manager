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
import { expectedStamp, recordOwnWrite } from './edit-stamps.ts'
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
 * The confirmation shown before a card is deleted.
 *
 * Both lines are given the card's number: a dictionary may name it in either (the Chinese
 * description does), and a placeholder left unfilled renders as a literal `{ref}`.
 * @param t - translate, bound to this plugin's namespace.
 * @param ref - the card's display number, or `undefined` when the card is not in the loaded view.
 * @param onConfirm - what confirming does.
 * @returns the dialog request.
 */
export function deleteConfirmation(t: BoardTranslate, ref: number | undefined, onConfirm: () => void): ConfirmRequest {
  const params = { ref: ref ?? '' }
  return {
    title: t('confirm.deleteTitle', params),
    description: t('confirm.delete', params),
    confirmLabel: t('confirm.deleteAction'),
    onConfirm,
  }
}

/**
 * The confirmation shown before a card whose run has no recorded owner is deleted.
 *
 * Its own copy, because the ordinary one would hide the part that matters: the run may still be going
 * in another dsh process, and deleting the card does not stop it there.
 * @param t - translate, bound to this plugin's namespace.
 * @param ref - the card's display number.
 * @param jobId - the job id the marker names.
 * @param onConfirm - what confirming does.
 * @returns the dialog request.
 */
export function deleteUnknownRunConfirmation(t: BoardTranslate, ref: number, jobId: string, onConfirm: () => void): ConfirmRequest {
  const params = { ref, job: jobId }
  return {
    title: t('confirm.deleteTitle', params),
    description: t('confirm.deleteUnknownRun', params),
    confirmLabel: t('confirm.deleteAction'),
    onConfirm,
  }
}

/**
 * The confirmation shown before an owner-unknown running marker is cleared.
 * @param t - translate, bound to this plugin's namespace.
 * @param ref - the card's display number.
 * @param jobId - the job id the marker names.
 * @param onConfirm - what confirming does.
 * @returns the dialog request.
 */
export function clearRunConfirmation(t: BoardTranslate, ref: number, jobId: string, onConfirm: () => void): ConfirmRequest {
  const params = { ref, job: jobId }
  return {
    title: t('confirm.clearRunTitle', params),
    description: t('confirm.clearRun', params),
    confirmLabel: t('confirm.clearRunAction'),
    onConfirm,
  }
}

/**
 * The confirmation shown before a card holding an owner-unknown running marker is dispatched again.
 * @param t - translate, bound to this plugin's namespace.
 * @param ref - the card's display number.
 * @param jobId - the job id the marker names.
 * @param onConfirm - what confirming does.
 * @returns the dialog request.
 */
export function dispatchUnknownConfirmation(t: BoardTranslate, ref: number, jobId: string, onConfirm: () => void): ConfirmRequest {
  const params = { ref, job: jobId }
  return {
    title: t('confirm.dispatchUnknownTitle', params),
    description: t('confirm.dispatchUnknown', params),
    confirmLabel: t('confirm.dispatchUnknownAction'),
    onConfirm,
  }
}

/**
 * The job id of a card's running marker when that marker records no owner.
 *
 * Such a marker is cleared only once the person confirms, and the confirmation carries this id so the
 * host clears exactly the marker the person was shown.
 * @param task - the card, when it is loaded.
 * @returns the job id, or `undefined` for an idle card or a run with a known owner.
 */
function unknownRunOf(task: BoardView['tasks'][number] | undefined): string | undefined {
  return task?.runOwnerUnknown === true ? task.runningJobId : undefined
}

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
  const defaultStatus = useTaskSettings(snapshot => snapshot.value?.defaultStatus)
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
  /**
   * Field edits and moves run one after another. Each carries the card's `updatedAt` as the person
   * saw it when they began, and two sent together from one stamp would make the second conflict with
   * the first — the person's own change. Chained, each is carried past its predecessors' own writes.
   */
  const edits = useRef<Promise<void>>(Promise.resolve())
  /**
   * The newest `updatedAt` this view has seen per card, from reads and from its own writes. Only the
   * start stamp of a control that commits the moment it is used (a select, a picker) comes from here;
   * a typed edit or a drag brings the stamp it began at.
   */
  const stamps = useRef(new Map<string, number>())
  /** Per card, the stamps this view's own conditional writes moved it through (see `edit-stamps`). */
  const ownWrites = useRef(new Map<string, Map<number, number>>())
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
      for (const task of result.tasks) stamps.current.set(task.id, task.updatedAt)
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
      if (!alive.current) return
      stamps.current.set(result.task.id, result.task.updatedAt)
      setDetail(result)
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
      // The local view may now disagree with the store — a refused edit most of all, whose card
      // someone else changed — so re-read the board and the open card rather than leaving either wrong.
      await loadBoard(query)
      if (openId !== undefined) await loadDetail(openId)
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [explain, loadBoard, loadDetail, query, openId])

  /**
   * Fold one server-returned card into the local board without a full re-read.
   *
   * The card comes back from the mutation that changed it, so this is the store's own value rather
   * than a guess — the board updates at once and the next poll confirms it.
   * @param task - the updated card.
   */
  const applyTask = useCallback((task: BoardView['tasks'][number]): void => {
    stamps.current.set(task.id, task.updatedAt)
    setView((current) => {
      if (current === null) return current
      const archivedFilter = query.archived ?? 'active'
      const visible = archivedFilter === 'all' || (archivedFilter === 'archived') === task.archived
      const without = current.tasks.filter(entry => entry.id !== task.id)
      return { ...current, tasks: inBoardOrder(visible ? [...without, task] : without) }
    })
    setDetail(current => (current === null || current.task.id !== task.id ? current : { ...current, task }))
  }, [query.archived])

  /**
   * Queue one conditional write behind the ones before it.
   *
   * The stamp is fixed when the change begins — `seen`, or the newest read for a control that commits
   * as it is used — and carried forward at send time only through this view's own writes. A stamp
   * read at send time would instead include whatever a poll brought in while the person was editing,
   * and the write would overwrite a change they never saw.
   * @param taskId - the card being changed.
   * @param seen - the card's `updatedAt` when the change began, when the control knows it.
   * @param send - performs the call with the precondition to send, and returns the updated card.
   */
  const conditional = useCallback((
    taskId: string,
    seen: number | undefined,
    send: (expectedUpdatedAt: number | undefined) => Promise<BoardView['tasks'][number]>,
  ): void => {
    const started = seen ?? stamps.current.get(taskId)
    const next = edits.current.then(() => mutate(async () => {
      const own = ownWrites.current.get(taskId) ?? new Map<number, number>()
      ownWrites.current.set(taskId, own)
      const expectedUpdatedAt = started === undefined ? undefined : expectedStamp(started, own)
      const task = await send(expectedUpdatedAt)
      if (expectedUpdatedAt !== undefined) recordOwnWrite(own, expectedUpdatedAt, task.updatedAt)
      applyTask(task)
      if (openId === taskId) await loadDetail(taskId)
    }))
    edits.current = next
    void next
  }, [mutate, applyTask, openId, loadDetail])

  const patch = useCallback((taskId: string, value: TaskPatch, seen?: number) => {
    conditional(taskId, seen, expectedUpdatedAt => api.call('task.update', expectedUpdatedAt === undefined
      ? { sessionId, taskId, patch: value }
      : { sessionId, taskId, patch: value, expectedUpdatedAt }))
  }, [conditional, api, sessionId])

  const promote = useCallback((content: string) => {
    void mutate(async () => {
      await api.call('task.create', { sessionId, task: { title: content } })
      if (alive.current) setPromoted(current => [...current, content])
      await loadBoard(query)
    })
  }, [mutate, api, sessionId, loadBoard, query])

  const create = useCallback((title: string, status: TaskStatus | undefined) => {
    void mutate(async () => {
      // No status is how the host is asked for its configured default column.
      await api.call('task.create', { sessionId, task: status === undefined ? { title } : { title, status } })
      await loadBoard(query)
    })
  }, [mutate, api, sessionId, loadBoard, query])

  // Through the same queue and precondition as an edit: a refused move re-reads the board and says
  // why, rather than dropping the card over a change someone else made.
  const move = useCallback((taskId: string, status: TaskStatus, place: TaskPlacement, seen: number) => {
    conditional(taskId, seen, expectedUpdatedAt => api.call('task.move', expectedUpdatedAt === undefined
      ? { sessionId, taskId, status, place }
      : { sessionId, taskId, status, place, expectedUpdatedAt }))
  }, [conditional, api, sessionId])

  const archive = useCallback((taskId: string, archived: boolean) => {
    void mutate(async () => {
      await api.call(archived ? 'task.archive' : 'task.restore', { sessionId, taskId })
      await loadBoard(query)
      if (openId === taskId) await loadDetail(taskId)
    })
  }, [mutate, api, sessionId, loadBoard, query, openId, loadDetail])

  /**
   * A card as this view last read it, from the board or the open detail.
   * @param taskId - the card.
   * @returns the card, or `undefined` when neither holds it.
   */
  const loadedCard = useCallback((taskId: string): BoardView['tasks'][number] | undefined => (
    view?.tasks.find(entry => entry.id === taskId) ?? (detail?.task.id === taskId ? detail.task : undefined)
  ), [view, detail])

  const remove = useCallback((taskId: string) => {
    const target = loadedCard(taskId)
    const unknownRun = unknownRunOf(target)
    const send = (): void => {
      void mutate(async () => {
        await api.call('task.delete', unknownRun === undefined ? { sessionId, taskId } : { sessionId, taskId, clearUnknownRun: unknownRun })
        if (openId === taskId) setOpenId(undefined)
        await loadBoard(query)
      })
    }
    setConfirming(target !== undefined && unknownRun !== undefined
      ? deleteUnknownRunConfirmation(t, target.ref, unknownRun, send)
      : deleteConfirmation(t, target?.ref, send))
  }, [loadedCard, t, mutate, api, sessionId, openId, loadBoard, query])

  const dispatch = useCallback((taskId: string) => {
    const target = loadedCard(taskId)
    const unknownRun = unknownRunOf(target)
    const send = (): void => {
      void mutate(async () => {
        const result = await api.call('task.dispatch', unknownRun === undefined
          ? { sessionId, taskId }
          : { sessionId, taskId, clearUnknownRun: unknownRun })
        applyTask(result.task)
        await loadJobs()
      })
    }
    if (target === undefined || unknownRun === undefined) {
      send()
      return
    }
    setConfirming(dispatchUnknownConfirmation(t, target.ref, unknownRun, send))
  }, [loadedCard, t, mutate, api, sessionId, applyTask, loadJobs])

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
      // Replaced, not appended: the host never consumes a job's output for the board (see `readJob`),
      // so each read is the whole answer — a card run's final output, or a note that the output is
      // the agent's to read.
      const text = result.outputWithheld === true ? t('jobs.outputWithheld') : result.text
      setJobOutput(current => ({ ...current, [jobId]: text }))
      await loadJobs()
    })
  }, [mutate, api, sessionId, loadJobs, t])

  const jobKill = useCallback((jobId: string) => {
    void mutate(async () => {
      await api.call('jobs.kill', { sessionId, jobId })
      await loadJobs()
    })
  }, [mutate, api, sessionId, loadJobs])

  // A card's Stop: a run with a known owner is stopped like any job; a marker with no recorded owner
  // names no run this board can stop, so the person is asked whether to clear the marker instead.
  const stopCardRun = useCallback((jobId: string, taskId: string) => {
    const target = loadedCard(taskId)
    if (target === undefined || unknownRunOf(target) !== jobId) {
      jobKill(jobId)
      return
    }
    setConfirming(clearRunConfirmation(t, target.ref, jobId, () => {
      void mutate(async () => {
        applyTask(await api.call('task.clearRun', { sessionId, taskId, jobId }))
      })
    }))
  }, [loadedCard, jobKill, t, mutate, api, sessionId, applyTask])

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
        defaultStatus={defaultStatus}
        onJobRead={jobRead}
        onJobKill={jobKill}
        taskActions={{
          onOpen: setOpenId,
          onMove: move,
          onArchive: archive,
          onDelete: remove,
          onDispatch: dispatch,
          onStopRun: stopCardRun,
        }}
        detailActions={{
          onClose: () => { setOpenId(undefined) },
          onTitleChange: (taskId, title, seen) => { patch(taskId, { title }, seen) },
          onBodyChange: (taskId, body, seen) => { patch(taskId, { body: body.trim() === '' ? null : body }, seen) },
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
          onStopRun: stopCardRun,
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
