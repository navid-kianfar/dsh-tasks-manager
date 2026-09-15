/** The model-facing tools' own parsing of what a model sends. */

import { describe, expect, it } from 'vitest'
import { parseDateText } from '../../src/tools/index.ts'
import { TaskValidationError } from '../../src/domain/validate.ts'

describe('parseDateText', () => {
  it('reads a real calendar date as UTC midnight', () => {
    expect(parseDateText('2026-02-28')).toBe(Date.UTC(2026, 1, 28))
    expect(parseDateText('2028-02-29')).toBe(Date.UTC(2028, 1, 29))
  })

  it.each(['2026-02-31', '2026-02-29', '2026-13-01', '2026-04-31', '2026-00-10'])(
    'refuses %s instead of rolling it over into the next month',
    (text) => {
      expect(() => parseDateText(text)).toThrow(TaskValidationError)
    },
  )

  it('treats an empty string as clearing the date', () => {
    expect(parseDateText('  ')).toBeNull()
  })
})
