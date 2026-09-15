/** The settings card's numeric fields refuse what the settings schema would refuse. */

import { describe, expect, it } from 'vitest'
import { Config } from '../../src/host/index.ts'
import { boundedInteger } from '../../src/client/TasksSettingsCard.tsx'

describe('boundedInteger', () => {
  it('accepts the digest size range the schema accepts, and refuses either side of it', () => {
    expect(boundedInteger('1', 1, 200)).toBe(1)
    expect(boundedInteger('200', 1, 200)).toBe(200)
    expect(boundedInteger('0', 1, 200)).toBeUndefined()
    expect(boundedInteger('201', 1, 200)).toBeUndefined()
    // The same edges, judged by the schema itself, so the two cannot drift apart unnoticed.
    expect(() => new Config({ digestSize: 200 } as never)).not.toThrow()
    expect(() => new Config({ digestSize: 201 } as never)).toThrow()
  })

  it('leaves a field with no schema ceiling unbounded above', () => {
    expect(boundedInteger('600000', 250)).toBe(600000)
  })

  it('refuses text that is not an integer', () => {
    expect(boundedInteger('', 1, 200)).toBeUndefined()
    expect(boundedInteger('many', 1, 200)).toBeUndefined()
  })
})
