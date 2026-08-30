/**
 * The board's presentational layer, as one import surface.
 * @module @achasoft/dsh-tasks-manager/client/board
 */

export { BoardScreen, BoardEmpty } from './BoardScreen.tsx'
export { Background } from './Background.tsx'
export { SessionTodos } from './SessionTodos.tsx'
export { Kanban } from './Kanban.tsx'
export { ListView } from './ListView.tsx'
export { TaskCard } from './TaskCard.tsx'
export { TaskDetail } from './TaskDetail.tsx'
export { Toolbar } from './Toolbar.tsx'
export { AssigneePicker, assigneeRows, initialsOf } from './AssigneePicker.tsx'
export { ConfirmDialog } from './ConfirmDialog.tsx'
export type { ConfirmRequest } from './ConfirmDialog.tsx'
export { DatePicker } from './DatePicker.tsx'
export { Popover, placeSurface } from './Popover.tsx'
export { Select } from './Select.tsx'
export type { SelectOption } from './Select.tsx'
export { TagInput, canonicalLabel } from './TagInput.tsx'
export type * from './contract.ts'
export type { SessionTodo } from './session-todo.ts'
export {
  activeFilterCount, collectLabels, describeActivity, describeDue, duration,
  fromDateText, relativeTime, sortTasks, toDateText,
} from './format.ts'
export type { DueDisplay, DueTone } from './format.ts'
export {
  CALENDAR_COLUMNS, CALENDAR_ROWS, addDays, addMonths, dayText, dayValue, documentLocale,
  monthGrid, monthLabel, monthOf, shiftMonth, weekStartFor, weekdayLabels,
} from './calendar.ts'
export type { CalendarDay, CalendarMonth } from './calendar.ts'
