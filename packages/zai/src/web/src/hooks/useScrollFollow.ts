// packages/zai/src/web/src/hooks/useScrollFollow.ts
//
// 检测用户是否在主动翻看历史消息, 返回一个布尔:
//
//   - false: 跟 AI 滚动 (默认 / 用户已停止操作 IDLE_RESUME_MS)
//   - true:  挂起自动滚 (用户最近 IDLE_RESUME_MS 内触发过滚动手势)
//
// 关键: 不监听 scroll 事件 — 它无法区分"用户滚动"和"AI scrollIntoView"。
// scrollIntoView / scrollTo / 设 scrollTop 都会触发 scroll, 拿来做
// "用户在动"的信号会让 AI 滚到底的瞬间立刻自锁 5s, 期间所有新消息
// effect 全部早退, 用户看到的画面就停在 5s 前的位置。
//
// 改用"输入手势"做信号源:
//
//   - wheel       鼠标滚轮 / 触控板
//   - touchstart  触屏拖动起点 (touchmove 会持续触发, 我们只锁一次)
//   - keydown     PageUp / PageDown / ArrowUp / ArrowDown / Home / End
//
// 其他手势 (mousedown / pointerdown) 范围太广, 用户点消息卡片也会触发,
// 不加。wheel + touchstart + 滚动键已经覆盖了桌面与移动端的主要输入。
//
// 用法 (Agent.tsx):
//   const scrollRef = useRef<HTMLDivElement>(null)
//   const locked = useScrollFollow(scrollRef)
//   useEffect(() => {
//     if (locked) return           // 用户在读历史, 别打断
//     target.scrollIntoView(...)   // 否则把新内容拉到视口
//   }, [messages, pendingAsk, locked])
import { useEffect, useState, type RefObject } from 'react'

/** 用户停止滚动后, 多久恢复自动跟随。 */
const IDLE_RESUME_MS = 5000

const SCROLL_KEYS = new Set([
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
])

export function useScrollFollow(
  ref: RefObject<HTMLElement | null>,
): boolean {
  const [locked, setLocked] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    let resumeTimer: ReturnType<typeof setTimeout> | null = null
    const clearResumeTimer = () => {
      if (resumeTimer !== null) {
        clearTimeout(resumeTimer)
        resumeTimer = null
      }
    }

    const lock = () => {
      setLocked(true)
      clearResumeTimer()
      resumeTimer = setTimeout(() => {
        resumeTimer = null
        setLocked(false)
      }, IDLE_RESUME_MS)
    }

    // wheel / touchstart 挂在容器上 — 滚轮和触屏拖动只在容器内
    // 触发, 不会因为用户在别的区域滚动而误锁。
    const onWheel = () => lock()
    const onTouchStart = () => lock()

    // 键盘挂在 window 上 — 滚动键的 focus 可能不在容器内 (例如
    // 用户刚在 textarea 里输入完, focus 在 textarea), 但仍想滚动
    // 消息列表。挂在容器上会漏掉这种情况。
    const onKeyDown = (e: KeyboardEvent) => {
      if (SCROLL_KEYS.has(e.key)) lock()
    }

    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    window.addEventListener('keydown', onKeyDown)

    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      window.removeEventListener('keydown', onKeyDown)
      clearResumeTimer()
    }
  }, [ref])

  return locked
}