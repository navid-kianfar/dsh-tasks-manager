/** Fractional-index ordering: the property the whole drag-and-drop path rests on. */

import { describe, expect, it } from 'vitest'
import { firstRank, isValidRank, rankBetween, rankSequence } from '../../src/domain/rank.ts'

describe('rankBetween', () => {
  it('mints a key inside an unbounded range', () => {
    const key = firstRank()
    expect(isValidRank(key)).toBe(true)
    expect(key > '').toBe(true)
  })

  it('orders a key strictly between two neighbours', () => {
    const a = firstRank()
    const b = rankBetween(a, null)
    const middle = rankBetween(a, b)
    expect(a < middle).toBe(true)
    expect(middle < b).toBe(true)
  })

  it('keeps prepending below every existing key', () => {
    let head = firstRank()
    for (let step = 0; step < 200; step++) {
      const next = rankBetween(null, head)
      expect(next < head).toBe(true)
      expect(isValidRank(next)).toBe(true)
      head = next
    }
  })

  it('keeps appending above every existing key', () => {
    let tail = firstRank()
    for (let step = 0; step < 200; step++) {
      const next = rankBetween(tail, null)
      expect(next > tail).toBe(true)
      expect(isValidRank(next)).toBe(true)
      tail = next
    }
  })

  it('survives repeated insertion into the same gap', () => {
    let low = firstRank()
    const high = rankBetween(low, null)
    for (let step = 0; step < 200; step++) {
      const next = rankBetween(low, high)
      expect(low < next).toBe(true)
      expect(next < high).toBe(true)
      expect(isValidRank(next)).toBe(true)
      low = next
    }
  })

  it('holds total order across a long randomised shuffle', () => {
    // A deterministic pseudo-random walk: every step inserts at a random position and the whole
    // list must still be sorted. This is the invariant a real board exercises over months of drags.
    let seed = 0x2f6e2b1
    const random = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % bound
    }
    const keys = [firstRank()]
    for (let step = 0; step < 400; step++) {
      const at = random(keys.length + 1)
      const lower = at === 0 ? null : keys[at - 1] as string
      const upper = at === keys.length ? null : keys[at] as string
      const next = rankBetween(lower, upper)
      keys.splice(at, 0, next)
    }
    const sorted = [...keys].sort()
    expect(keys).toEqual(sorted)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('refuses reversed or equal neighbours rather than inventing a position', () => {
    const a = firstRank()
    const b = rankBetween(a, null)
    expect(() => rankBetween(b, a)).toThrow(RangeError)
    expect(() => rankBetween(a, a)).toThrow(RangeError)
  })

  it('refuses a malformed neighbour', () => {
    expect(() => rankBetween('not a rank!', null)).toThrow(RangeError)
    expect(() => rankBetween(null, 'V0')).toThrow(RangeError)
    expect(() => rankBetween('', null)).toThrow(RangeError)
  })
})

describe('isValidRank', () => {
  it('rejects the spellings that would break comparison', () => {
    expect(isValidRank('')).toBe(false)
    expect(isValidRank('V0')).toBe(false)
    expect(isValidRank('V-')).toBe(false)
    expect(isValidRank('V')).toBe(true)
    expect(isValidRank('0V')).toBe(true)
  })
})

describe('rankSequence', () => {
  it('mints ascending keys inside the requested gap', () => {
    const lower = firstRank()
    const upper = rankBetween(lower, null)
    const keys = rankSequence(lower, upper, 8)
    expect(keys).toHaveLength(8)
    expect([...keys].sort()).toEqual(keys)
    expect(lower < (keys[0] as string)).toBe(true)
    expect((keys.at(-1) as string) < upper).toBe(true)
  })

  it('yields nothing for a non-positive count', () => {
    expect(rankSequence(null, null, 0)).toEqual([])
    expect(rankSequence(null, null, -3)).toEqual([])
  })
})
