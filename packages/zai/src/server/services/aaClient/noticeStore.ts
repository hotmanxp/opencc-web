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

/**
 * oc-003(2026-10-16):一张 notice 卡片只有在用户真的回答时才会被回收
 * (`resolveNotice` ← `interaction.respond`)。用户**中断**会话、ask 因超时
 * 或子进程重启而消失、连接断过 —— 这些路径都不经过 respond,卡片就永远
 * 停在那里,AA 会一直向一个已经没有 pending ask 的 toolUseId 要回答。
 *
 * TTL 取 2h,与 `routes/agent.ts:161` 的 `HARD_TIMEOUT_MS` 对齐:一个 turn
 * 的绝对上限就是 2h,超过它的 notice 不可能还有对应的 pending ask。
 */
export const NOTICE_TTL_MS = 2 * 60 * 60 * 1000;

/** 惰性过期:读取时顺手清掉超龄条目(不引入定时器,保持模块无副作用)。 */
function isExpired(entry: StoredNotice, now: number): boolean {
  return now - entry.createdAt > NOTICE_TTL_MS;
}

function sweepExpired(now: number): void {
  for (const [id, entry] of byId) {
    if (isExpired(entry, now)) byId.delete(id);
  }
}

/** Remember a notice so `session.notices` can serve it back. */
export function registerNotice(entry: Omit<StoredNotice, 'createdAt'>): void {
  const now = Date.now();
  sweepExpired(now);
  byId.set(String(entry.notice.noticeId), { ...entry, createdAt: now });
}

export function getNotice(noticeId: string): StoredNotice | null {
  const entry = byId.get(noticeId);
  if (!entry) return null;
  if (isExpired(entry, Date.now())) {
    byId.delete(noticeId);
    return null;
  }
  return entry;
}

/** Drop a notice once it has been answered (or cancelled). */
export function resolveNotice(noticeId: string): void {
  byId.delete(noticeId);
}

/**
 * Drop every open notice belonging to a zai session — the `session.interrupt`
 * path. Without this, an interrupted ask's card stays up until the user
 * mis-clicks it, and that mis-click forwards a toolUseId the child no longer
 * has a pending ask for.
 */
export function resolveNoticesForZaiSession(zaiSessionId: string): number {
  let dropped = 0;
  for (const [id, entry] of byId) {
    if (entry.zaiSessionId === zaiSessionId) {
      byId.delete(id);
      dropped += 1;
    }
  }
  return dropped;
}

/** All open notices for a session — backs the `session.notices` RPC. */
export function listNoticesForSession(aaSessionId: string): Record<string, unknown>[] {
  const now = Date.now();
  sweepExpired(now);
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
