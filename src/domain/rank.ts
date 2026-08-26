/**
 * Fractional indexing for card order within a board column.
 *
 * A card's position is a string key, and dropping a card between two neighbours mints a key that
 * sorts strictly between theirs. That is what keeps a drag to one write: an integer `position`
 * column would renumber every card below the drop, and two clients dragging at once would then
 * interleave those renumbers into a scrambled column.
 *
 * Keys are base-62 fractions over `0-9A-Za-z`, read as the digits after an implied `0.`. The
 * alphabet is in ASCII order, so SQLite's default `BINARY` collation, JavaScript's `<`, and this
 * module all agree on what "between" means without a custom collation.
 *
 * The algorithm is the standard fractional-indexing midpoint (David Greenspan's formulation, as
 * used by `fractional-indexing`), minus that library's integer part: a board holds hundreds of
 * cards, not millions, and keys grow one character per ~62 insertions at the same spot.
 *
 * @module @achasoft/dsh-tasks-manager/domain/rank
 */

/** Base-62 digits in ASCII order, so lexicographic string order equals numeric fraction order. */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** The alphabet's zero, which no key may end with (see {@link isValidRank}). */
const ZERO = DIGITS.charAt(0)

/**
 * The midpoint of two base-62 fractions.
 *
 * Both arguments are the digits after an implied `0.`. `upper` of `null` means the open upper
 * bound `1.0`; `lower` of `''` means the open lower bound `0.0`.
 *
 * Neither may end in `0`: a trailing zero is a second spelling of the same fraction, and admitting
 * it would let two different keys compare equal numerically but not lexicographically. Every key
 * this module mints already satisfies that, so the guard only fires on a corrupted store.
 * @param lower - exclusive lower bound's digits, `''` for the bottom of the range.
 * @param upper - exclusive upper bound's digits, `null` for the top of the range.
 * @returns digits strictly between the two bounds.
 */
function midpoint(lower: string, upper: string | null): string {
  if (upper !== null && lower >= upper) {
    throw new RangeError(`tasks: rank bounds out of order (${JSON.stringify(lower)} >= ${JSON.stringify(upper)})`)
  }
  if (lower.endsWith(ZERO) || (upper !== null && upper.endsWith(ZERO))) {
    throw new RangeError('tasks: rank bounds carry a trailing zero')
  }

  if (upper !== null) {
    // Strip the common prefix, padding `lower` with zeros as it runs out. `upper` cannot run out
    // first: it is the larger of the two, so it has a digit wherever the prefix still matches.
    let shared = 0
    while ((lower[shared] ?? ZERO) === upper[shared]) shared++
    if (shared > 0) {
      return upper.slice(0, shared) + midpoint(lower.slice(shared), upper.slice(shared))
    }
  }

  // The leading digits now differ (or `lower` has none left).
  const low = lower === '' ? 0 : DIGITS.indexOf(lower[0] as string)
  const high = upper === null ? DIGITS.length : DIGITS.indexOf(upper[0] as string)
  if (high - low > 1) return DIGITS[Math.round(0.5 * (low + high))] as string

  // The leading digits are adjacent, so the midpoint has to borrow a place. When `upper` has more
  // digits, its own leading digit already sits above `lower`; otherwise descend into `lower`'s
  // tail against an open top — midpoint('49', '5') builds '4' + midpoint('9', null) = '495'.
  if (upper !== null && upper.length > 1) return upper.slice(0, 1)
  return (DIGITS[low] as string) + midpoint(lower.slice(1), null)
}

/**
 * Whether a string is a well-formed rank key: non-empty, base-62 only, and with no trailing zero.
 * @param value - the candidate key.
 * @returns true when the key is one this module could have minted.
 */
export function isValidRank(value: string): boolean {
  if (value.length === 0 || value.endsWith(ZERO)) return false
  for (const character of value) {
    if (!DIGITS.includes(character)) return false
  }
  return true
}

/**
 * Mint a key that sorts strictly between two neighbours.
 *
 * @param lower - the key of the card above the drop, or `null` when dropping at the top of the column.
 * @param upper - the key of the card below the drop, or `null` when dropping at the bottom.
 * @returns a fresh key strictly between the two.
 * @throws RangeError when either neighbour is not a valid key, or when they are equal or reversed —
 * both mean the caller's neighbours no longer describe a real gap, and inventing a key would
 * silently place the card somewhere the user did not drop it.
 */
export function rankBetween(lower: string | null, upper: string | null): string {
  if (lower !== null && !isValidRank(lower)) {
    throw new RangeError(`tasks: malformed lower rank ${JSON.stringify(lower)}`)
  }
  if (upper !== null && !isValidRank(upper)) {
    throw new RangeError(`tasks: malformed upper rank ${JSON.stringify(upper)}`)
  }
  return midpoint(lower ?? '', upper)
}

/**
 * The key for the first card in an empty column.
 * @returns the midpoint of the whole range, leaving room to insert above and below it.
 */
export function firstRank(): string {
  return rankBetween(null, null)
}

/**
 * Mint `count` keys in ascending order after an optional existing key.
 *
 * Used for bulk creation, where minting one at a time would need a store round trip per card.
 * @param lower - the key to start after, or `null` to start at the top of the range.
 * @param upper - the key to stop before, or `null` for the bottom of the range.
 * @param count - how many keys to mint; a non-positive count yields none.
 * @returns the keys, ascending.
 */
export function rankSequence(lower: string | null, upper: string | null, count: number): string[] {
  const keys: string[] = []
  let previous = lower
  for (let index = 0; index < count; index++) {
    const next = rankBetween(previous, upper)
    keys.push(next)
    previous = next
  }
  return keys
}
