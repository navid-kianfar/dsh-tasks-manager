/**
 * The board's presentational layer, as one import surface.
 * @module @achasoft/dsh-tasks-manager/client/board
 */

export { BoardScreen, BoardEmpty } from './BoardScreen.tsx'
export { Background } from './Background.tsx'
export { Kanban } from './Kanban.tsx'
export { ListView } from './ListView.tsx'
export { TaskCard } from './TaskCard.tsx'
export { TaskDetail } from './TaskDetail.tsx'
export { Toolbar } from './Toolbar.tsx'
export type * from './contract.ts'
export {
  activeFilterCount, collectLabels, describeActivity, describeDue, duration,
  fromDateText, relativeTime, sortTasks, toDateText,
} from './format.ts'
export type { DueDisplay, DueTone } from './format.ts'
