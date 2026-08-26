/**
 * The task plugin's browser half: the Tasks view in the conversation ring, and the settings card in
 * the Plugins section.
 *
 * Both seats are registered through `ctx.slots.inject`, because apply order between packages is
 * unconstrained and a bare `register` into a slot another package declares is an error when this
 * plugin happens to load first.
 *
 * @module @achasoft/dsh-tasks-manager/client
 */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls ui-conversation's SlotMap merge, which declares 'conversation.view'.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls ui-settings-plugins' SlotMap merge, which declares 'settings.plugin.item'.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// Type-only: pulls ui-settings' ctx.settingsScope merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls tool-todo's `todos` projection key, read by the session checklist panel.
import type {} from '@deepseek-ai/dsh-tool-todo/client'
import type { Config } from '../host/index.ts'
import { createTasksApi } from './rpc.ts'
import { TasksView, type TasksViewInjected } from './TasksView.tsx'
import { TasksSettingsCard, type TasksSettingsInjected } from './TasksSettingsCard.tsx'
import { en, NS, zh, type TasksKey } from './locales.ts'

export type { TasksViewProps } from './TasksView.tsx'
export type { TasksSettingsCardProps } from './TasksSettingsCard.tsx'
export type { TasksKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Task board copy: the view, the card detail, the background panel, and the settings card. */
    tasks: TasksKey
  }
}

/** Services this half needs before it can serve either seat. */
export const inject = ['slots', 'locale', 'connection', 'settingsScope']

/**
 * Register the Tasks view and the settings card.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-tasks: dictionaries')
  const t = ctx.locale.bind(NS)
  const api = createTasksApi(ctx)
  const settings = ctx.settingsScope.bind<Config>({ namespace: NS })

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'tasks',
    // After the shipped chat (0) and trajectory (10) tabs: the board is a place you go to, not the
    // one you land in.
    order: 20,
    locale: NS,
    // A thunk, so the tab label follows a locale change without re-registering the entry.
    label: () => t('view.tasks'),
    inject: (_sessionId: SessionId): TasksViewInjected => ({
      api,
      hooks: { taskSettings: settings },
    }),
  }, TasksView))

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    // The key IS the host settings namespace: the plugins tab renders the intersection of
    // registered cards and the namespaces the host reports, so the two halves join on this string.
    key: NS,
    locale: NS,
    inject: (): TasksSettingsInjected => ({
      hooks: { taskSettings: settings },
      setField: (field, value) => settings.set(field, value),
    }),
  }, TasksSettingsCard))
}
