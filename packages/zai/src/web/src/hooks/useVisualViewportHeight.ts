import { useEffect, useState } from 'react'

/**
 * 监听 window.visualViewport.resize,返回当前可视区域高度(px)。
 * 移动端虚拟键盘弹出/收起时,容器高度跟随 visualViewport.height 调整,
 * 避免 TextArea 被键盘遮挡。
 * SSR / 老浏览器(无 visualViewport)降级到 window.innerHeight。
 */
export function useVisualViewportHeight(): number {
  const [h, setH] = useState<number>(() => {
    if (typeof window === 'undefined') return 0
    return window.visualViewport?.height ?? window.innerHeight
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    const vv = window.visualViewport
    if (!vv) return
    const update = () => setH(vv.height)
    vv.addEventListener('resize', update)
    update()
    return () => vv.removeEventListener('resize', update)
  }, [])

  return h
}