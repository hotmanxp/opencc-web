// copyToClipboard: navigator.clipboard.writeText 优先, 失败 fallback 到 textarea + execCommand.
// 返回 boolean 而非抛错, 让调用方根据成败决定 UI 反馈(✓ / warning toast).
// 不抛是设计选择: 复制是 best-effort UX 增强, 不应阻塞对话流.

export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // fall through to legacy path
    }
  }
  if (typeof document === 'undefined') return false
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
