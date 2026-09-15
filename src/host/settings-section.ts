/**
 * Attaching this plugin's settings section to the harness settings provider.
 *
 * Harness 0.1.1-rc.2 and earlier exported two free helpers from `@deepseek-ai/dsh-settings` for
 * this, `installSettingsSection` and `settingsNamespace`. Current harnesses removed both: the same
 * wiring is the provider's own `settings.installSection(owner, ns, schema, entry, hooks)`, reached
 * through `ctx.inject(['settings'], …)`. Importing the old helpers by name fails to link on a
 * current install, so the plugin carries these two small equivalents instead of depending on a
 * compatibility shim that only exists on a development machine.
 *
 * Injecting `settings` rather than requiring it keeps the plugin loadable in a deployment that
 * mounts no settings provider: the section simply never attaches, and the composition entry the
 * plugin was configured with stays the source.
 * @module @achasoft/dsh-tasks-manager/host/settings-section
 */

import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'

/** The provider's namespace grammar: a lowercase, hyphenated identifier. */
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/u

/** What a consumer hands the provider, as the installed harness defines it. */
export interface SettingsSectionHooks<T> {
  /**
   * Receive the active configuration source: the resolved settings scope while one is attached,
   * the composition entry otherwise.
   * @param current - thunk returning the currently authoritative value.
   */
  setSource: (current: () => T) => void
  /** Re-judge anything derived from the source after an attach, a detach, or a committed change. */
  onChange: () => void
  /**
   * Reject a resolved section the plugin could not act on, for constraints its schema cannot express.
   * @param value - the resolved section.
   */
  validate?: (value: T) => void
}

/** The part of the harness settings provider this module calls. */
interface SettingsProviderFace {
  installSection: <T>(owner: Context, ns: string, schema: z<T>, entry: T, hooks: SettingsSectionHooks<T>) => void
}

/**
 * Check a settings namespace against the provider's grammar, failing at load rather than at attach.
 * @param value - the namespace.
 * @returns the same namespace.
 * @throws TypeError when it is not a lowercase hyphenated identifier.
 */
export function settingsNamespace<const N extends string>(value: N): N {
  if (!NAMESPACE_PATTERN.test(value)) {
    throw new TypeError(`settings namespace "${value}" must match ${String(NAMESPACE_PATTERN)}`)
  }
  return value
}

/**
 * Attach one settings section whenever a settings provider is present.
 * @param ctx - the owning plugin context; its unload detaches the section.
 * @param ns - the plugin's settings namespace.
 * @param schema - schema resolving the section.
 * @param entry - the composition entry, used as the base layer and as the fallback without a provider.
 * @param hooks - source sink, change notification, and optional validation.
 */
export function installSettingsSection<T>(
  ctx: Context,
  ns: string,
  schema: z<T>,
  entry: T,
  hooks: SettingsSectionHooks<T>,
): void {
  ctx.inject(['settings'], (settingsCtx) => {
    const provider = (settingsCtx as unknown as { settings: SettingsProviderFace }).settings
    provider.installSection(ctx, ns, schema, entry, hooks)
  })
}
