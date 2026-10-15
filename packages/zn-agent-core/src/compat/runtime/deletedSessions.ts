/**
 * 已删除会话的 stale 守卫。
 *
 * 问题:`DELETE /api/agent/sessions/:id` 删掉 transcript 之后,一个**仍在运行**
 * 的 turn 会在自己的 `finally` 里继续 append。而 append 路径
 * (本文件 `appendEntry` / vendor 的 `sessionStorage.appendDirectlyToFile`)
 * 都是 `mkdir(dirname) + appendFile` —— 目录和文件会被**重新创建**,
 * 被删的会话就这样自己复活。
 *
 * 路由侧已经把 `abortSessionController` 放在 `store.remove` 之前(顺序是主修法),
 * 但 abort 是异步生效的:turn 可能在收到 signal 之前已经排队了一次写。
 * 这个集合是第二道闸 —— 写之前先问「这个 sid 删过没有」,删过就丢弃。
 *
 * 只增不删:条目本身很小(一串 sid),而且同 sid 被重新创建后仍应保持
 * 「已删除」语义 —— 新会话用的是新 sid。
 */
const deleted = new Set<string>()

export function markSessionDeleted(sessionId: string): void {
  deleted.add(sessionId)
}

export function isSessionDeleted(sessionId: string): boolean {
  return deleted.has(sessionId)
}

/** 测试 seam。 */
export function __resetDeletedSessionsForTests(): void {
  deleted.clear()
}
