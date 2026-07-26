import { useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import { useVisualViewportHeight } from '../hooks/useVisualViewportHeight'
import { useIsMobile } from '../hooks/useIsMobile'
import { useAppStore } from '../store/useAppStore'
import { useAgentStore } from '../store/useAgentStore'
import { api } from '../lib/api'

/**
 * 移动端顶层布局 — 没有 Sider / 顶栏 / 任何桌面 chrome。
 * 高度跟随 window.visualViewport.height,键盘弹出/收起时容器自动收缩。
 * paddingBottom 用 env(safe-area-inset-bottom) 适配 iPhone X+ 底部 home indicator。
 *
 * 这里仍负责 1) 拉 /system 写 cwdName 到 useAppStore.instanceContext 与
 * document.title;2) hydrate outputStyle / maxVisibleMessages — 与 Layout.tsx
 * 同样的 boot 步骤,确保移动端 store 一致。
 */
export default function MobileLayout() {
  const vvHeight = useVisualViewportHeight()
  // 同步全局 isMobile. Layout 也会调, 这里再调一次是为了 MobileLayout 直接挂载
  // (没有 Layout 父级) 时也立即生效, 比如用户从桌面拉窄到 <768px 跳路由后.
  useIsMobile()
  const setInstanceContext = useAppStore((s) => s.setInstanceContext)
  const setOutputStyle = useAppStore((s) => s.setOutputStyle)
  const setMaxVisibleMessages = useAppStore((s) => s.setMaxVisibleMessages)
  const setTranscriptCollapsed = useAgentStore((s) => s.setTranscriptCollapsed)

  useEffect(() => {
    api
      .get<{ ok: boolean; cwd: string; cwdName: string; branch?: string | null }>('/system')
      .then((data) => {
        setInstanceContext({
          cwd: data.cwd,
          cwdName: data.cwdName,
          branch: data.branch ?? null,
          host: '',
          port: 0,
          ips: [],
        })
        document.title = `${data.cwdName}-Z.AI`
      })
      .catch(() => {
        document.title = 'opencc-web-Z.AI'
      })
  }, [setInstanceContext])

  useEffect(() => {
    let cancelled = false
    api
      .get<{ outputStyle?: 'default' | 'compact' | 'verbose'; maxVisibleMessages?: number }>(
        '/agent/settings',
      )
      .then((data) => {
        if (cancelled) return
        if (
          data.outputStyle === 'default' ||
          data.outputStyle === 'compact' ||
          data.outputStyle === 'verbose'
        ) {
          setOutputStyle(data.outputStyle)
          setTranscriptCollapsed(data.outputStyle === 'compact')
        }
        if (typeof data.maxVisibleMessages === 'number') {
          setMaxVisibleMessages(Math.max(1, Math.min(1000, Math.floor(data.maxVisibleMessages))))
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [setOutputStyle, setMaxVisibleMessages, setTranscriptCollapsed])

  return (
    <div
      style={{
        height: vvHeight || '100vh',
        paddingBottom: 'env(safe-area-inset-bottom)',
        display: 'flex',
        flexDirection: 'column',
        background: '#0a0a0f',
        color: '#f1f5f9',
        overflow: 'hidden',
      }}
    >
      <Outlet />
    </div>
  )
}