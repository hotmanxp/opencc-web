import { useRef } from 'react'

/**
 * Drawer 顶部拖把手势条(2026-09-04,/m-super-tasks 抽屉式 Modal)。
 *
 * 视觉:24px 高的横向条,中央 36×4 圆角灰条 —— iOS bottom sheet 风。
 * 手势:touchstart 记录起点 y;touchend 计算 deltaY,≥ threshold 触发 onClose。
 *
 * 单元测试断言组件存在(R5:`data-testid`);ego-browser 真实手势模拟
 * 由 verifier 接管(executor 不自验)。
 */
export default function DrawerPullHandle({
  testId,
  onClose,
  threshold = 60,
}: {
  testId: string
  onClose: () => void
  threshold?: number
}): JSX.Element {
  const startY = useRef<number | null>(null)
  return (
    <div
      data-testid={testId}
      aria-label="下拉关闭"
      onTouchStart={(e) => {
        startY.current = e.touches[0]?.clientY ?? null
      }}
      onTouchEnd={(e) => {
        const start = startY.current
        startY.current = null
        if (start == null) return
        const end = e.changedTouches[0]?.clientY
        if (end == null) return
        if (end - start >= threshold) onClose()
      }}
      style={{
        height: 24,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'grab',
        touchAction: 'none',
        userSelect: 'none',
      }}
    >
      <div
        style={{
          width: 36,
          height: 4,
          borderRadius: 2,
          background: 'rgba(0,0,0,.18)',
        }}
      />
    </div>
  )
}