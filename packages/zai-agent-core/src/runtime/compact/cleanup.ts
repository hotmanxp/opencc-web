/**
 * Compact 后清理:通知 cache break detector / 重置 session memory 标记。
 *
 * 阶段 1 简化版:process-local flag 占位。
 * 阶段 2 可对接 cache break detection。
 */

let postCompactMarker = false

export function markPostCompaction(): void {
  postCompactMarker = true
}

export function consumePostCompactMarker(): boolean {
  if (postCompactMarker) {
    postCompactMarker = false
    return true
  }
  return false
}

export function runPostCompactCleanup(querySource: string): void {
  // 当前只 mark,后续可扩展:
  // - cache break detector 重置 baseline
  // - session memory 清理 lastSummarizedMessageId
  // - mcp auth cache 失效
  void querySource
  markPostCompaction()
}