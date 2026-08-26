/**
 * The model's view of the project board: five single-purpose tools over `ctx.tasks`.
 *
 * Single-purpose rather than one tool with an `action` discriminant, because a discriminant makes
 * every other parameter conditionally required — a shape JSON Schema cannot express and models
 * routinely get wrong. Five small tools cost a little prompt and remove that whole failure class.
 *
 * Cards are addressed the way a person would quote them: `#12`, `12`, or the full `t_…` id all
 * resolve, so the model can act on a number it read in a comment without a lookup round trip.
 *
 * @module @achasoft/dsh-tasks-manager/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '../host/index.ts'
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type Task,
  type TaskCreate,
  type TaskPatch,
  type TaskPriority,
  type TaskStatus,
} from '../domain/types.ts'
import { TaskValidationError } from '../domain/validate.ts'
import type { TaskAuthor, TaskStore } from '../host/store.ts'

/** Cordis plugin name. */
export const name = 'dsh-tasks-tools'

/** The board seam and the tool registry both have to be present for these tools to mean anything. */
export const inject = ['tools', 'tasks']

/** Deployment configuration for the model-facing task tools. */
export interface Config {
  /**
   * Whether the model may permanently delete a card. Off by default: archiving is recoverable and
   * deleting is not, and a model reaching for the destructive one because it read the word "remove"
   * costs the user work they cannot get back.
   */
  allowDelete: boolean
  /** How many cards `task_list` returns when the model names no limit. */
  defaultListLimit: number
}

/** Schemastery configuration for the task tools. */
export const Config: z<Config> = z.object({
  allowDelete: z.boolean().default(false),
  defaultListLimit: z.number().step(1).min(1).max(200).default(50),
})

/**
 * How a card is written back to the model.
 *
 * `status` and `priority` are the domain unions rather than `string`: the output schema declares
 * them as enums, so a widened field here would let a value the schema rejects reach the registry.
 */
interface TaskLine {
  ref: number
  id: string
  title: string
  status: TaskStatus
  priority: TaskPriority
  labels: string[]
  assignee?: string
  dueDate?: string
  comments: number
  running: boolean
}

/**
 * Render one card for a tool result.
 *
 * Dates go back as `YYYY-MM-DD` rather than epoch milliseconds: the model reads and writes them in
 * that form, and handing it a number it would have to convert invites arithmetic instead of a date.
 * @param task - the card.
 * @param comments - how many comments it carries.
 * @returns the model-facing line.
 */
function toLine(task: Task, comments: number): TaskLine {
  return {
    ref: task.ref,
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    labels: [...task.labels],
    ...task.assignee === undefined ? {} : { assignee: task.assignee },
    ...task.dueAt === undefined ? {} : { dueDate: toDateText(task.dueAt) },
    comments,
    running: task.runningJobId !== undefined,
  }
}

/**
 * Render an epoch-ms timestamp as a calendar date.
 * @param at - epoch ms.
 * @returns the `YYYY-MM-DD` date in UTC.
 */
function toDateText(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

/**
 * Parse a model-supplied calendar date.
 * @param text - a `YYYY-MM-DD` date, or the empty string to clear one.
 * @returns epoch ms at UTC midnight, or `null` to clear.
 * @throws TaskValidationError when the text is not a real calendar date.
 */
function parseDateText(text: string): number | null {
  if (text.trim() === '') return null
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) {
    throw new TaskValidationError(`dueDate must be a YYYY-MM-DD date (got ${JSON.stringify(text)})`)
  }
  const at = Date.parse(`${text}T00:00:00.000Z`)
  if (Number.isNaN(at)) throw new TaskValidationError(`${JSON.stringify(text)} is not a real date`)
  return at
}

/**
 * The board and author for one tool call.
 * @param ctx - the plugin context carrying `ctx.tasks`.
 * @param exec - the tool's execution context.
 * @returns the calling session's board and the author to attribute writes to.
 * @throws TaskValidationError when the call has no owning session.
 */
function boardOf(ctx: Context, exec: ToolExecution): { board: TaskStore; author: TaskAuthor } {
  const session = exec.agent?.session
  if (session === undefined) {
    throw new TaskValidationError('the task board is per-project, and this call has no owning session')
  }
  return {
    board: ctx.tasks.boardForCwd(session.header.cwd, session.id),
    author: { actor: 'agent', sessionId: session.id },
  }
}

/**
 * Resolve the card a model addressed.
 * @param board - the project's board.
 * @param reference - `#12`, `12`, or a full `t_…` id.
 * @returns the card.
 * @throws TaskValidationError when the reference resolves to no card on this board.
 */
function resolveTask(board: TaskStore, reference: string): Task {
  const text = reference.trim()
  const numeric = /^#?(\d+)$/u.exec(text)
  if (numeric !== null) {
    const found = board.byRef(Number.parseInt(numeric[1] as string, 10))
    if (found === undefined) throw new TaskValidationError(`no task #${numeric[1]} on this board`)
    return found
  }
  const detail = board.detail(text)
  return detail.task
}

/**
 * How many comments each of a set of cards carries.
 * @param board - the project's board.
 * @param tasks - the cards to count for.
 * @returns comment counts by card id.
 */
function commentCounts(board: TaskStore, tasks: readonly Task[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const task of tasks) counts.set(task.id, board.detail(task.id).comments.length)
  return counts
}

/** Schema fragment for the status enum, shared by the tools that accept one. */
const STATUS_ENUM = [...TASK_STATUSES] as const
/** Schema fragment for the priority enum. */
const PRIORITY_ENUM = [...TASK_PRIORITIES] as const

/** The card fields a tool result reports back, as an output schema. */
const TASK_LINE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ref: { type: 'integer', required: true, description: 'The card number, quoted as #N.' },
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: STATUS_ENUM },
    priority: { type: 'string', required: true, enum: PRIORITY_ENUM },
    labels: { type: 'array', required: true, items: { type: 'string' } },
    assignee: { type: 'string' },
    dueDate: { type: 'string' },
    comments: { type: 'integer', required: true },
    running: { type: 'boolean', required: true, description: 'Whether a background run is working this card now.' },
  },
} as const

/**
 * Register the model-facing task tools.
 * @param ctx - registrant context carrying the tool registry and the board seam.
 * @param config - the deployment's tool policy.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'task_add',
    description:
      'Add one or more tasks to the PROJECT task board — the durable, cross-session backlog stored '
      + 'in the project itself. Use this whenever the user asks to note, capture, track, or remember '
      + 'work for later ("add a task to…", "put that on the board", "we should also…"). This is NOT '
      + 'the per-session checklist: use todo_write for the steps of the job you are doing right now, '
      + 'and task_add for work the project should still remember tomorrow. Each task needs a short '
      + 'imperative title; put the detail in `body` as Markdown.',
    parameters: {
      tasks: {
        type: 'array',
        required: true,
        description: 'The tasks to add, in the order they should appear.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', required: true, description: 'Short imperative summary, e.g. "Add rate limiting to the upload endpoint".' },
            body: { type: 'string', description: 'Optional Markdown detail: context, acceptance criteria, links.' },
            status: { type: 'string', enum: STATUS_ENUM, description: 'Starting column. Defaults to the board\'s configured column for new work.' },
            priority: { type: 'string', enum: PRIORITY_ENUM, description: 'Defaults to normal. Reserve urgent for work that blocks someone now.' },
            labels: { type: 'array', items: { type: 'string' }, description: 'Short free-form tags, lowercased automatically.' },
            assignee: { type: 'string', description: 'Who owns it, if the user said.' },
            dueDate: { type: 'string', description: 'Due date as YYYY-MM-DD. Omit unless the user gave one.' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          added: { type: 'array', required: true, items: TASK_LINE_SCHEMA },
          boardPath: { type: 'string', required: true, description: 'Absolute path of the SQLite board the tasks were written to.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.added.length === 1
          ? `Added #${value.added[0]?.ref} ${JSON.stringify(value.added[0]?.title)} to the project board.`
          : `Added ${value.added.length} tasks to the project board: ${value.added.map(task => `#${task.ref}`).join(', ')}.`,
      }],
    },
    execute(args, exec) {
      const { board, author } = boardOf(ctx, exec)
      const now = Date.now()
      const added = args.tasks.map((input) => {
        const create: TaskCreate = {
          title: input.title,
          ...input.body === undefined ? {} : { body: input.body },
          ...input.status === undefined ? {} : { status: input.status as TaskStatus },
          ...input.priority === undefined ? {} : { priority: input.priority as Task['priority'] },
          ...input.labels === undefined ? {} : { labels: input.labels },
          ...input.assignee === undefined ? {} : { assignee: input.assignee },
          ...input.dueDate === undefined || parseDateText(input.dueDate) === null
            ? {}
            : { dueAt: parseDateText(input.dueDate) as number },
        }
        return toLine(board.create(create, author, now), 0)
      })
      return Promise.resolve({ added, boardPath: board.databasePath })
    },
    presentCall: args => ({
      card: 'generic',
      title: args.tasks.length === 1 ? 'Add task to board' : `Add ${args.tasks.length} tasks to board`,
      kind: 'other',
      rawInput: args.tasks,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'task_list',
    description:
      'Read the PROJECT task board: the durable backlog stored with the project. Call it before '
      + 'planning work, when the user asks what is outstanding or what is in progress, or to find a '
      + 'task number before updating one. With no filters it returns the whole active board.',
    parameters: {
      status: { type: 'array', items: { type: 'string', enum: STATUS_ENUM }, description: 'Only these columns.' },
      priority: { type: 'array', items: { type: 'string', enum: PRIORITY_ENUM }, description: 'Only these priorities.' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Only tasks carrying EVERY one of these labels.' },
      assignee: { type: 'string', description: 'Only tasks assigned to this person.' },
      search: { type: 'string', description: 'Case-insensitive text match over title and body.' },
      archived: {
        type: 'string',
        enum: ['active', 'archived', 'all'] as const,
        description: 'Which archive state to include. Defaults to active.',
      },
      limit: { type: 'integer', description: 'Cap on returned tasks.' },
      sort: {
        type: 'string',
        enum: ['board', 'urgency'] as const,
        description:
          'board (default) returns tasks in the order they sit on the board. urgency returns only '
          + 'unfinished work, most pressing first — use it to answer "what should I work on".',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tasks: { type: 'array', required: true, items: TASK_LINE_SCHEMA },
          counts: {
            type: 'object',
            required: true,
            additionalProperties: false,
            description: 'Active card count per column, for the whole board rather than the filtered set.',
            properties: Object.fromEntries(
              STATUS_ENUM.map(status => [status, { type: 'integer', required: true }]),
            ) as Record<TaskStatus, { type: 'integer'; required: true }>,
          },
          archivedCount: { type: 'integer', required: true },
          boardPath: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.tasks.length === 0
          ? 'No tasks on the project board match that.'
          : [
              `${value.tasks.length} task(s) on the project board:`,
              ...value.tasks.map(task =>
                `#${task.ref} [${task.status}${task.priority === 'normal' ? '' : `/${task.priority}`}]`
                + ` ${task.title}${task.labels.length === 0 ? '' : ` (${task.labels.join(', ')})`}`
                + `${task.running ? ' — running now' : ''}`),
            ].join('\n'),
      }],
    },
    execute(args, exec) {
      const { board } = boardOf(ctx, exec)
      if (args.sort === 'urgency') {
        const urgent = board.outstanding(args.limit ?? ctx.tasks.settings.digestSize)
        const urgentCounts = commentCounts(board, urgent)
        const { counts, archivedCount } = board.counts()
        return Promise.resolve({
          tasks: urgent.map(task => toLine(task, urgentCounts.get(task.id) ?? 0)),
          counts,
          archivedCount,
          boardPath: board.databasePath,
        })
      }
      const view = board.read({
        ...args.status === undefined ? {} : { status: args.status as TaskStatus[] },
        ...args.priority === undefined ? {} : { priority: args.priority as Task['priority'][] },
        ...args.labels === undefined ? {} : { labels: args.labels },
        ...args.assignee === undefined ? {} : { assignee: args.assignee },
        ...args.search === undefined ? {} : { search: args.search },
        ...args.archived === undefined ? {} : { archived: args.archived as 'active' | 'archived' | 'all' },
        limit: args.limit ?? config.defaultListLimit,
      })
      const counts = commentCounts(board, view.tasks)
      return Promise.resolve({
        tasks: view.tasks.map(task => toLine(task, counts.get(task.id) ?? 0)),
        counts: view.counts,
        archivedCount: view.archivedCount,
        boardPath: view.databasePath,
      })
    },
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: 'Read project board', kind: 'other', rawInput: {} }),
  }))

  ctx.tools.register(defineTool({
    name: 'task_update',
    description:
      'Change one task on the PROJECT board: move it between columns, rename it, edit its detail, '
      + 'change priority, labels, assignee or due date, or archive and restore it. Address the task '
      + 'as "#12", "12", or its full id. Only the fields you send change; send an empty string to '
      + 'clear assignee, dueDate, or body, and an empty array to clear labels. Archiving hides a '
      + 'task from the board while keeping it recoverable — prefer it to deleting.',
    parameters: {
      task: { type: 'string', required: true, description: 'The task to change: "#12", "12", or a t_… id.' },
      title: { type: 'string', description: 'New title.' },
      body: { type: 'string', description: 'New Markdown detail; empty string clears it.' },
      status: { type: 'string', enum: STATUS_ENUM, description: 'Move it to this column.' },
      priority: { type: 'string', enum: PRIORITY_ENUM },
      labels: { type: 'array', items: { type: 'string' }, description: 'REPLACES the label set; empty array clears it.' },
      assignee: { type: 'string', description: 'New owner; empty string clears it.' },
      dueDate: { type: 'string', description: 'New due date as YYYY-MM-DD; empty string clears it.' },
      archived: { type: 'boolean', description: 'True archives the task, false restores it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task: { ...TASK_LINE_SCHEMA, required: true },
          archived: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `#${value.task.ref} ${value.task.title} — ${value.archived ? 'archived' : `now ${value.task.status}`}`
          + `${value.task.priority === 'normal' ? '' : `, priority ${value.task.priority}`}.`,
      }],
    },
    execute(args, exec) {
      const { board, author } = boardOf(ctx, exec)
      const now = Date.now()
      const target = resolveTask(board, args.task)

      const patch: TaskPatch = {
        ...args.title === undefined ? {} : { title: args.title },
        ...args.body === undefined ? {} : { body: args.body.trim() === '' ? null : args.body },
        ...args.status === undefined ? {} : { status: args.status as TaskStatus },
        ...args.priority === undefined ? {} : { priority: args.priority as Task['priority'] },
        ...args.labels === undefined ? {} : { labels: args.labels.length === 0 ? null : args.labels },
        ...args.assignee === undefined ? {} : { assignee: args.assignee.trim() === '' ? null : args.assignee },
        ...args.dueDate === undefined ? {} : { dueAt: parseDateText(args.dueDate) },
      }
      let updated = Object.keys(patch).length === 0 ? target : board.update(target.id, patch, author, now)
      if (args.archived !== undefined) {
        updated = board.setArchived(target.id, args.archived, author, now)
      }
      return Promise.resolve({
        task: toLine(updated, board.detail(updated.id).comments.length),
        archived: updated.archived,
      })
    },
    presentCall: args => ({ card: 'generic', title: `Update task ${args.task}`, kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'task_comment',
    description:
      'Add a comment to one task on the PROJECT board. Use it to record findings, decisions, '
      + 'blockers, or a summary of what you did — anything the next person (or the next session) '
      + 'would need in order to pick the task up. Comments are permanent and shown in the task\'s '
      + 'detail panel.',
    parameters: {
      task: { type: 'string', required: true, description: 'The task to comment on: "#12", "12", or a t_… id.' },
      body: { type: 'string', required: true, description: 'The comment, as Markdown.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ref: { type: 'integer', required: true },
          commentId: { type: 'string', required: true },
          comments: { type: 'integer', required: true, description: 'How many comments the task now carries.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Commented on #${value.ref} (${value.comments} comment(s) now).`,
      }],
    },
    execute(args, exec) {
      const { board, author } = boardOf(ctx, exec)
      const target = resolveTask(board, args.task)
      const comment = board.addComment(target.id, args.body, author, Date.now())
      return Promise.resolve({
        ref: target.ref,
        commentId: comment.id,
        comments: board.detail(target.id).comments.length,
      })
    },
    presentCall: args => ({ card: 'generic', title: `Comment on task ${args.task}`, kind: 'other', rawInput: args }),
  }))

  if (!config.allowDelete) return
  ctx.tools.register(defineTool({
    name: 'task_delete',
    description:
      'PERMANENTLY delete one task from the PROJECT board, with its comments and its whole history. '
      + 'This cannot be undone. Prefer `task_update` with `archived: true`, which hides the task but '
      + 'keeps it recoverable; only delete when the user has clearly asked for the task to be gone.',
    parameters: {
      task: { type: 'string', required: true, description: 'The task to delete: "#12", "12", or a t_… id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ref: { type: 'integer', required: true },
          title: { type: 'string', required: true },
          deleted: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Deleted #${value.ref} ${JSON.stringify(value.title)} and everything attached to it.`,
      }],
    },
    execute(args, exec) {
      const { board } = boardOf(ctx, exec)
      const target = resolveTask(board, args.task)
      board.remove(target.id)
      return Promise.resolve({ ref: target.ref, title: target.title, deleted: true })
    },
    presentCall: args => ({ card: 'generic', title: `Delete task ${args.task}`, kind: 'other', rawInput: args }),
  }))
}
