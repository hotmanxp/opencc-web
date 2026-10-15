/**
 * 三路合并 —— 让「编辑器里的陈旧缓冲」既不吞掉别人写的字段,又能表达删除。
 *
 * 背景(docs/bugs/fix-plan-10-05.md H1):配置页 `PUT /config/zai` 发的是
 * **打开编辑器时读到的整份 JSON**。到点保存时,设置抽屉 / 另一个 zai 进程
 * 可能已经改过同一个文件。单纯的两路浅合并 `{...disk, ...content}` 会把
 * 「缓冲里带着、但磁盘上已经变了」的字段**静默回滚** —— 这正是原 bug。
 * 但反过来,只发用户改过的键又会丢表达能力:用户在编辑器里**删掉**一个键时,
 * `{...disk, ...patch}` 根本没法把它从 disk 上摘掉。
 *
 * 有了 base(打开编辑器时的磁盘快照),每个键的归属就能判定:
 *
 * | base 有 | content 有 | 值相同 | 判定 |
 * |--------|-----------|--------|------|
 * |   ✓    |     ✗     |   —    | 用户删了 → 从结果删除 |
 * |   ✗    |     ✓     |   —    | 用户新增 → 写入 |
 * |   ✓    |     ✓     |   ✗    | 用户改了 → 写入 |
 * |   ✓    |     ✓     |   ✓    | 用户没动 → **保留 disk 现值**(不回滚) |
 * |   ✗    |     ✗     |   —    | 别人在打开之后新增 → 保留(不回滚) |
 *
 * 最后两行是这个合并存在的全部理由:用户没碰过的字段,谁改都算数的应该是
 * 磁盘上的那个,而不是用户浏览器里几小时前的那份快照。
 */

/** 稳定序列化:键排序后 JSON.stringify,让「值相同」不受键序影响。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把「打开编辑器时的 base」与「用户编辑后的 content」合并到 disk 现值上。
 *
 * 纯函数,不碰文件系统 —— 调用方负责在正确的锁 / 队列内读 disk 并写回。
 * 返回一个新对象;`disk` 与 `base` / `content` 都不会被修改。
 */
export function threeWayMerge<T extends Record<string, unknown>>(
  disk: T,
  base: Record<string, unknown> | undefined,
  content: Record<string, unknown>,
): T {
  const next: Record<string, unknown> = { ...disk }
  if (!isPlainObject(base)) {
    // 没有基线(旧客户端 / 调用方直接给了完整对象)→ 退回两路浅合并。
    // 这是**有意保留**的向后兼容路径:调用方要么刚读过 disk,要么自己负责
    // 全量覆盖语义。
    return { ...next, ...content } as T
  }

  // 用户在编辑器里删掉的键
  for (const key of Object.keys(base)) {
    if (!(key in content)) delete next[key]
  }
  // 用户新增或真正改动过的键
  for (const [key, value] of Object.entries(content)) {
    if (!(key in base) || stableStringify(base[key]) !== stableStringify(value)) {
      next[key] = value
    }
    // 两边都有且值相同 → 用户没动 → 保留 `next` 里来自 disk 的现值
  }
  return next as T
}
