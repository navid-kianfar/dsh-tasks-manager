/**
 * The Tasks view's confirmation copy, rendered through the real dictionaries.
 *
 * A dictionary is free to name a value in any line, and a placeholder the call site does not fill
 * reaches the person as literal `{ref}` — which is what the Chinese delete confirmation showed.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  clearRunConfirmation,
  deleteConfirmation,
  deleteUnknownRunConfirmation,
  dispatchUnknownConfirmation,
} from '../../src/client/TasksView.tsx'
import { en, zh } from '../../src/client/locales.ts'
import type { BoardTranslate } from '../../src/client/board/contract.ts'

/**
 * A translate over one dictionary, filling `{name}` placeholders the way the locale service does.
 * @param dictionary - the language's entries.
 * @returns the translate function.
 */
function translator(dictionary: Record<string, string>): BoardTranslate {
  return (key, params = {}) => (dictionary[key] ?? key)
    .replace(/\{(\w+)\}/gu, (whole, name: string) => (name in params ? String(params[name]) : whole))
}

describe('deleteConfirmation', () => {
  it.each([['zh', zh], ['en', en]] as const)('fills every placeholder in %s', (_language, dictionary) => {
    const request = deleteConfirmation(translator(dictionary), 12, vi.fn())

    for (const line of [request.title, request.description, request.confirmLabel]) {
      expect(line).not.toMatch(/\{\w+\}/u)
    }
    expect(request.title).toContain('#12')
  })

  it('names the card in the Chinese description, which asks about it by number', () => {
    expect(deleteConfirmation(translator(zh), 7, vi.fn()).description).toContain('#7')
  })
})

describe('the owner-unknown run confirmations', () => {
  const builders = [
    ['clearing the marker', clearRunConfirmation],
    ['dispatching again', dispatchUnknownConfirmation],
    ['deleting the card', deleteUnknownRunConfirmation],
  ] as const

  for (const [action, build] of builders) {
    it.each([['zh', zh], ['en', en]] as const)(`fills every placeholder in %s when ${action}`, (_language, dictionary) => {
      const request = build(translator(dictionary), 12, 'task-4', vi.fn())

      for (const line of [request.title, request.description, request.confirmLabel]) {
        expect(line).not.toMatch(/\{\w+\}/u)
      }
      expect(request.title).toContain('#12')
      // The person is told which run the marker names, since that is the run they are giving up on.
      expect(request.description).toContain('task-4')
    })
  }
})
