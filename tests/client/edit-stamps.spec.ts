/**
 * Which `updatedAt` an edit or a move carries as its precondition.
 *
 * The stamp is the one the person was looking at when they began, carried forward only through this
 * view's own writes — so their second edit does not conflict with their first, and a change anyone
 * else made while they were typing is refused instead of overwritten.
 */

import { describe, expect, it } from 'vitest'
import { expectedStamp, recordOwnWrite } from '../../src/client/edit-stamps.ts'

describe('expectedStamp', () => {
  it('sends the stamp the edit began at when nothing has been written since', () => {
    expect(expectedStamp(100, undefined)).toBe(100)
    expect(expectedStamp(100, new Map())).toBe(100)
  })

  it('carries the stamp forward through this view\'s own writes, in order', () => {
    const own = new Map<number, number>()
    recordOwnWrite(own, 100, 200)
    recordOwnWrite(own, 200, 300)
    expect(expectedStamp(100, own)).toBe(300)
    expect(expectedStamp(200, own)).toBe(300)
  })

  it('keeps the start stamp when a poll brought someone else\'s change, so the host refuses it', () => {
    const own = new Map<number, number>()
    recordOwnWrite(own, 100, 200)
    // The edit began at a stamp a poll brought in — someone else's write, not one this view made —
    // so nothing carries it forward, and a card changed again since is refused by the host.
    expect(expectedStamp(150, own)).toBe(150)
  })

  it('does not record a write that changed nothing, which would loop on its own stamp', () => {
    const own = new Map<number, number>()
    recordOwnWrite(own, 100, 100)
    expect(own.size).toBe(0)
    expect(expectedStamp(100, own)).toBe(100)
  })

  it('stops rather than spinning on a chain that returns to a stamp it already passed', () => {
    const own = new Map<number, number>([[100, 200], [200, 100]])
    expect([100, 200]).toContain(expectedStamp(100, own))
  })
})
