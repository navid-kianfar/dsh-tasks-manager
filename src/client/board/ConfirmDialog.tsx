/**
 * The board's "are you sure": a dialog, not `window.confirm`.
 *
 * `confirm()` blocks the page, is drawn by the browser in the browser's colours, and cannot mark
 * the destructive answer as destructive. The board's two irreversible actions — deleting a card and
 * deleting a comment — are exactly the ones that deserve better than a system alert.
 *
 * Follows the shell's own `RiskConfirmation` layout (warning row, outline Cancel, primary Confirm)
 * without its acknowledgement checkbox: these two actions want a deliberate second click, not a
 * checkbox. Mask, Escape, and the portal are the design system's `Modal`.
 *
 * @module @achasoft/dsh-tasks-manager/client/board/ConfirmDialog
 */

import clsx from 'clsx'
import { Button, IconWarningOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import fields from './fields.module.css'
import css from './ConfirmDialog.module.css'

/** What one pending confirmation is about. */
export interface ConfirmRequest {
  /** The dialog's heading. */
  title: string
  /** The sentence explaining what happens, and what cannot be undone. */
  description: string
  /** The confirming button's label, phrased as the action it performs. */
  confirmLabel: string
  /** What to do when it is pressed. */
  onConfirm: () => void
}

/** Render the confirmation dialog. */
export function ConfirmDialog({ request, onClose, cancelLabel, closeLabel }: {
  /** The pending confirmation, or `null` when nothing is being asked. */
  request: ConfirmRequest | null
  /** Dismiss without acting — Escape, the mask, or Cancel. */
  onClose: () => void
  /** The dismissing button's label. */
  cancelLabel: string
  /** Accessible label for the header's close control. */
  closeLabel: string
}) {
  return (
    <Modal
      open={request !== null}
      onClose={onClose}
      title={request?.title ?? ''}
      closeLabel={closeLabel}
      className={clsx(fields.fields, css.dialog)}
      footer={
        <>
          {/* Focus lands on Cancel, never on Confirm: a dialog that appears under a finger already
              pressing Enter must not delete anything. */}
          <Button variant="outline" size="sm" autoFocus onClick={onClose}>{cancelLabel}</Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => { request?.onConfirm(); onClose() }}
          >
            {request?.confirmLabel ?? ''}
          </Button>
        </>
      }
    >
      <div className={css.warning}>
        <IconWarningOutline16 size={18} className={css.warningIcon} />
        <p className={css.body}>{request?.description ?? ''}</p>
      </div>
    </Modal>
  )
}
