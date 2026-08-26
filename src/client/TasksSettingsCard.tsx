/**
 * The task board's settings card, in the Plugins section.
 *
 * The collapsible card chrome is reproduced here from the same design tokens rather than imported:
 * the section's own `PluginCard` is in-tree only, and a value import across the plugin boundary
 * fails the client bundle-purity gate. A card that looked different would read as a different KIND
 * of thing, not a different plugin.
 *
 * Each control writes one field the moment it changes: the scope serialises writes on a settled
 * tail and fences them on the revision, so there is nothing for a Save button to batch and one
 * would only add a state where the screen and the store disagree.
 *
 * @module @achasoft/dsh-tasks-manager/client/TasksSettingsCard
 */

import { useState } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsHooks } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { TASK_STATUSES } from '../domain/types.ts'
import type { Config } from '../host/index.ts'
import type { BoardTranslate } from './board/contract.ts'
import css from './TasksSettingsCard.module.css'

/**
 * The card's injected face.
 *
 * The scope reaches the component in two pieces because the framework's hook seat only projects
 * READS: `hooks.taskSettings` becomes the `useTaskSettings` selector, and writes need a plain
 * callback beside it.
 */
export interface TasksSettingsInjected {
  /** Hook sources the framework turns into `useTaskSettings`. */
  hooks: { taskSettings: SettingsScope<Config> }
  /**
   * Write one field of this plugin's settings section.
   * @param field - the config field name.
   * @param value - its new value.
   * @returns a promise settling when the write is acknowledged.
   */
  setField: (field: string, value: unknown) => Promise<void>
}

/** Everything the card needs, as the framework composes it. */
export type TasksSettingsCardProps = PropsHooks<TasksSettingsInjected['hooks']> & {
  /** Write one field of this plugin's settings section. */
  setField: (field: string, value: unknown) => Promise<void>
  /** Translate, bound to this plugin's namespace. */
  t: BoardTranslate
}

/** A number field that only writes once the entry parses. */
function NumberField({ label, hint, value, min, writable, onCommit }: {
  label: string
  hint: string
  value: number
  min: number
  writable: boolean
  onCommit: (next: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  const parsed = Number.parseInt(draft, 10)
  const invalid = !Number.isSafeInteger(parsed) || parsed < min
  return (
    <label className={css.field}>
      <span className={css.label}>{label}</span>
      <input
        className={css.input}
        inputMode="numeric"
        value={draft}
        disabled={!writable}
        aria-invalid={invalid}
        onChange={(event) => { setDraft(event.currentTarget.value) }}
        onBlur={() => {
          if (invalid) { setDraft(String(value)); return }
          if (parsed !== value) onCommit(parsed)
        }}
      />
      <span className={css.hint}>{hint}</span>
    </label>
  )
}

/** Render the task settings card. */
export function TasksSettingsCard({ useTaskSettings, setField, t }: TasksSettingsCardProps) {
  const [open, setOpen] = useState(false)
  const snapshot = useTaskSettings(value => value)
  const config = snapshot.value
  const writable = snapshot.writable

  const head = (
    <button
      type="button"
      className={css.header}
      aria-expanded={open}
      onClick={() => { setOpen(current => !current) }}
    >
      <span className={css.headText}>
        <span className={css.name}>{t('settings.title')}</span>
        <span className={css.description}>{t('settings.description')}</span>
      </span>
      <IconChevronDownOutline14 className={clsx(css.chevron, open && css.chevronOpen)} />
    </button>
  )

  if (config === undefined) return <li className={css.card}>{head}</li>

  return (
    <li className={clsx(css.card, open && css.cardOpen)}>
      {head}
      {!open ? null : (
        <div className={css.bodyArea}>
          {!writable && <p className={css.warn}>{t('settings.unavailable')}</p>}
          <div className={css.grid}>
        <label className={css.field}>
          <span className={css.label}>{t('settings.path')}</span>
          <input
            className={css.input}
            defaultValue={config.databasePath}
            key={config.databasePath}
            disabled={!writable}
            onBlur={(event) => {
              const next = event.currentTarget.value.trim()
              if (next !== '' && next !== config.databasePath) void scopeSet('databasePath', next)
            }}
          />
          <span className={css.hint}>{t('settings.path.hint')}</span>
        </label>

        <label className={css.field}>
          <span className={css.label}>{t('settings.defaultStatus')}</span>
          <select
            className={css.input}
            value={config.defaultStatus}
            disabled={!writable}
            onChange={(event) => { void scopeSet('defaultStatus', event.currentTarget.value) }}
          >
            {TASK_STATUSES.map(status => (
              <option key={status} value={status}>{t(`status.${status}`)}</option>
            ))}
          </select>
          <span className={css.hint}>{t('settings.defaultStatus.hint')}</span>
        </label>

        <label className={css.field}>
          <span className={css.label}>{t('settings.placement')}</span>
          <select
            className={css.input}
            value={config.newTaskPlacement}
            disabled={!writable}
            onChange={(event) => { void scopeSet('newTaskPlacement', event.currentTarget.value) }}
          >
            <option value="top">{t('settings.placement.top')}</option>
            <option value="bottom">{t('settings.placement.bottom')}</option>
          </select>
          <span className={css.hint}>{t('settings.placement.hint')}</span>
        </label>

        <NumberField
          label={t('settings.poll')}
          hint={t('settings.poll.hint')}
          value={config.pollIntervalMs}
          min={250}
          writable={writable}
          onCommit={(next) => { void scopeSet('pollIntervalMs', next) }}
        />

        <label className={css.field}>
          <span className={css.label}>{t('settings.subagent')}</span>
          <input
            className={css.input}
            defaultValue={config.subagentProvider}
            key={`provider:${config.subagentProvider}`}
            disabled={!writable}
            onBlur={(event) => {
              const next = event.currentTarget.value.trim()
              if (next !== config.subagentProvider) void scopeSet('subagentProvider', next)
            }}
          />
          <span className={css.hint}>
            {config.subagentProvider === '' ? t('settings.subagent.none') : t('settings.subagent.hint')}
          </span>
        </label>

        <label className={css.field}>
          <span className={css.label}>{t('settings.dispatchStatus')}</span>
          <select
            className={css.input}
            value={config.dispatchStatus}
            disabled={!writable}
            onChange={(event) => { void scopeSet('dispatchStatus', event.currentTarget.value) }}
          >
            <option value="none">{t('settings.status.none')}</option>
            {TASK_STATUSES.map(status => (
              <option key={status} value={status}>{t(`status.${status}`)}</option>
            ))}
          </select>
        </label>

        <label className={css.field}>
          <span className={css.label}>{t('settings.dispatchCompleted')}</span>
          <select
            className={css.input}
            value={config.dispatchCompletedStatus}
            disabled={!writable}
            onChange={(event) => { void scopeSet('dispatchCompletedStatus', event.currentTarget.value) }}
          >
            <option value="none">{t('settings.status.none')}</option>
            {TASK_STATUSES.map(status => (
              <option key={status} value={status}>{t(`status.${status}`)}</option>
            ))}
          </select>
        </label>

        <NumberField
          label={t('settings.digest')}
          hint={t('settings.digest.hint')}
          value={config.digestSize}
          min={1}
          writable={writable}
          onCommit={(next) => { void scopeSet('digestSize', next) }}
        />
          </div>
        </div>
      )}
    </li>
  )

  /**
   * Write one field, swallowing a rejection the scope already recovers from.
   * @param field - the config field.
   * @param value - its new value.
   */
  async function scopeSet(field: string, value: unknown): Promise<void> {
    try {
      await setField(field, value)
    } catch {
      // A failed write reloads the mirror on its own, and the control re-renders from it — there is
      // nothing for this card to add, and a toast per keystroke would be worse than the recovery.
    }
  }
}
