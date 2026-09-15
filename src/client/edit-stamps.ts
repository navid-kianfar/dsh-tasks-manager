/**
 * The precondition stamp an edit or a move carries.
 *
 * The host refuses a change whose `expectedUpdatedAt` is not the card's current `updatedAt`. The
 * question is which stamp to send. The newest one the view has read is wrong: a poll that lands while
 * a person is typing refreshes it, and the edit then claims to have been made against a change the
 * person never saw — overwriting it silently. The stamp the person was looking at when they BEGAN is
 * right, with one correction: their own earlier writes to the card, which they did see through, move
 * it forward. Otherwise a second edit queued behind the first would conflict with the first.
 *
 * @module @achasoft/dsh-tasks-manager/client/edit-stamps
 */

/**
 * One card's own-write chain: the stamp a conditional write was sent against, mapped to the stamp the
 * host returned for it.
 */
export type OwnWrites = ReadonlyMap<number, number>

/**
 * The stamp to send for an edit that began at `seen`.
 * @param seen - the card's `updatedAt` when the person began the edit.
 * @param own - this view's own conditional writes to the card, or undefined when it has made none.
 * @returns `seen`, carried forward through every own write that started from it.
 */
export function expectedStamp(seen: number, own: OwnWrites | undefined): number {
  if (own === undefined) return seen
  // The set only guards against a chain that loops back; stamps grow, so a real chain never does.
  const passed = new Set<number>([seen])
  let current = seen
  let next = own.get(current)
  while (next !== undefined && !passed.has(next)) {
    passed.add(next)
    current = next
    next = own.get(current)
  }
  return current
}

/**
 * Remember that one of this view's conditional writes moved a card from `sent` to `returned`.
 * @param own - the card's own-write chain, extended in place.
 * @param sent - the stamp the write was sent against, which the host accepted.
 * @param returned - the card's `updatedAt` in the host's answer.
 */
export function recordOwnWrite(own: Map<number, number>, sent: number, returned: number): void {
  // An unchanged write returns the stamp it was sent against; recording it would only add a loop.
  if (returned === sent) return
  own.set(sent, returned)
}
