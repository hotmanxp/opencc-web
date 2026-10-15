/**
 * Shared per-session ordering for AA timeline items.
 *
 * AA's clients sort a session's items by `orderSeq` first (falling back
 * to `updatedSeq`, then id):
 *
 *   web-next  session-utils.ts::compareTimelineItems
 *     `a.orderSeq - b.orderSeq || a.updatedSeq - b.updatedSeq || …`
 *
 * so the counter has to be shared by EVERY producer or the interleaving
 * breaks: while the event adapter kept its own private counter, the
 * user-message pushes (reverseDispatch) landed with no `orderSeq` at
 * all and AA sorted every user turn to the bottom of the conversation.
 *
 * Monotonic per session, starting at 1. In-memory only: the server
 * reassigns its own `updatedSeq` on persist, and each process restart
 * starts a fresh session timeline anyway.
 */
const counters = new Map<string, number>();

/** Reserve the next `orderSeq` for a session. */
export function nextTimelineOrderSeq(aaSessionId: string): number {
  const next = (counters.get(aaSessionId) ?? 0) + 1;
  counters.set(aaSessionId, next);
  return next;
}

/** Current value without consuming one. */
export function peekTimelineOrderSeq(aaSessionId: string): number {
  return counters.get(aaSessionId) ?? 0;
}

/** Forget a session's counter (teardown / tests). */
export function resetTimelineOrderSeq(aaSessionId?: string): void {
  if (aaSessionId === undefined) counters.clear();
  else counters.delete(aaSessionId);
}
