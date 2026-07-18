/**
 * 检测阻塞的 `sleep N` 模式 (对标 opencc `tools/BashTool/BashTool.tsx:428-443`)。
 *
 * 抓 `sleep 5` / `sleep 5 && check` / `sleep 5; check` — 引导模型改用
 * `run_in_background: true`(你会收到完成通知) 或 Monitor (流式)。
 */
const SLEEP_RE = /^sleep\s+(\d+(?:\.\d+)?)\s*$/

/**
 * 返回描述模式的字符串 (给 validateInput 用), 不匹配返回 null。
 * Float duration (sleep 0.5) 允许; sub-2s sleep 也允许。
 */
export function detectBlockedSleepPattern(command: string): string | null {
  const firstSegment = command.split(/[;&|]/)[0]?.trim() ?? ''
  const m = SLEEP_RE.exec(firstSegment)
  if (!m) return null
  const secs = parseFloat(m[1]!)
  if (secs < 2 || Number.isNaN(secs)) return null
  const rest = command.split(/[;&|]/).slice(1).join(';').trim()
  return rest
    ? `sleep ${secs} followed by: ${rest}`
    : `standalone sleep ${secs}`
}