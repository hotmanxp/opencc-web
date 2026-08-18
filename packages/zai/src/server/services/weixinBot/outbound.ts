/**
 * 出站文本分块 + 重试链 + 限流熔断。
 *
 * 关键设计:
 *   - 串行化:全 adapter 共享一个 Mutex,任何同时 send 互锁,避免 iLink
 *     限流重击。
 *   - 重试:默认 4 次,指数 backoff。session expired (-14) 时尝试剥掉
 *     context_token 重试 1 次 — tokenless 也能发,只是 iLink 视为新会话。
 *   - 限流熔断:连续 -2 触发打开,默认 30s 冷却,期间 send 立即抛 RuntimeError,
 *     不堆积消息队列(防止后续消息堆死)。
 *   - 文本分块:4000 字符上限,单 chunk 间隔 1.5s 默认,尊重 ``` 代码块。
 */

// 文本分块 helper:尊重 ```fence```,避免切断代码块
export function splitText(text: string, maxLen: number): string[] {
  if (!text.trim()) return []
  if (text.length <= maxLen) return [text]
  const chunks: string[] = []
  const lines = text.split('\n')
  let current = ''
  let inFence = false
  let fenceMarker = ''

  const flush = () => {
    if (current.trim()) chunks.push(current)
    current = ''
  }

  for (const line of lines) {
    const fenceMatch = line.match(/^(\s*```+)([^\n`]*)$/) || line.match(/^(\s*`{3,})/)
    if (fenceMatch) {
      if (!inFence) {
        inFence = true
        fenceMarker = fenceMatch[1]
      } else if (line.startsWith(fenceMarker)) {
        inFence = false
        fenceMarker = ''
      }
    }
    const candidate = current ? `${current}\n${line}` : line
    if (!inFence && candidate.length > maxLen) {
      flush()
      // 单行超出 maxLen — 硬切
      if (line.length > maxLen) {
        for (let i = 0; i < line.length; i += maxLen) {
          chunks.push(line.slice(i, i + maxLen))
        }
      } else {
        current = line
      }
    } else {
      current = candidate
    }
  }
  flush()
  return chunks
}
