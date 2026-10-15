/**
 * In-memory registry of open AA interaction notices.
 *
 * The AA server treats `notice.upsert` as fire-and-forget, so the only
 * way a connector can answer an interaction is to be asked again. Two
 * RPCs close that loop, and both used to be stubs:
 *
 *   - `session.notices` — the server calls it in
 *     `api/sessions.py::best_effort_runtime_notice_context` to read the
 *     notice's `context`, then merges that into the response payload.
 *     Returning `[]` meant the original question never came back.
 *   - `interaction.respond` — the server then calls the connector with
 *     `{sessionId, noticeId, actionId, inputData}`, NOT `toolUseId` /
 *     `decision` / `input`. Resolving a zai-side pending ask therefore
 *     requires keeping the noticeId → toolUseId mapping here, which is
 *     exactly the context the server asked us to preserve.
 *
 * Keyed by noticeId, which the server echoes back verbatim.
 */

export interface StoredNotice {
  /** The NoticeIn body we pushed, minus the fields the server owns. */
  notice: Record<string, unknown>;
  /** zai-side ids needed to forward the response to the right child. */
  childPort: number;
  zaiSessionId: string;
  toolUseId?: string;
  createdAt: number;
}

const byId = new Map<string, StoredNotice>();

/** Remember a notice so `session.notices` can serve it back. */
export function registerNotice(entry: Omit<StoredNotice, 'createdAt'>): void {
  byId.set(String(entry.notice.noticeId), { ...entry, createdAt: Date.now() });
}

export function getNotice(noticeId: string): StoredNotice | null {
  return byId.get(noticeId) ?? null;
}

/** Drop a notice once it has been answered (or cancelled). */
export function resolveNotice(noticeId: string): void {
  byId.delete(noticeId);
}

/** All open notices for a session — backs the `session.notices` RPC. */
export function listNoticesForSession(aaSessionId: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const entry of byId.values()) {
    if (entry.notice.sessionId === aaSessionId) out.push(entry.notice);
  }
  return out;
}

/** Test seam. */
export function resetNoticesForTests(): void {
  byId.clear();
}
