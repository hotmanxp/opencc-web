// packages/zai/src/web/src/components/transcript/useExpandUserBubble.ts
//
// 共享 hook: 决定 user 消息气泡是否撑满对话区 (与 AI 气泡一致).
// 触发条件:
//   - 移动端 (useAppStore.isMobile, 由 Layout useIsMobile() 同步)
//   - 分屏开启 (STORAGE_KEYS.open 写入 true)
//
// 桌面端无分屏时仍保留 70% maxWidth, 让短消息右对齐保持视觉呼吸.
// 该逻辑同时被 MessageBubble (expanded 视图) 与 CollapsedMessageBubble
// (collapsed 视图) 引用, 共享同一份判断源, 行为完全一致.
//
// splitPaneOpen 走 localStorage 监听而不是 store, 是因为它在 SplitPane 与
// Agent.tsx 之间通过 useLocalStorageState 维护, 这里只读不写, 用 storage +
// zai-localstorage-sync 两个事件做跨组件同步, 不引入 React Context.

import { useEffect, useState } from 'react'
import { useAppStore } from '../../store/useAppStore.js'
import { STORAGE_KEYS } from '../splitPane/shared.js'

export function useExpandUserBubble(): boolean {
  const isMobile = useAppStore((s) => s.isMobile)
  const [splitPaneOpen, setSplitPaneOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    try {
      const raw = window.localStorage.getItem(STORAGE_KEYS.open)
      return raw === null ? false : JSON.parse(raw) === true
    } catch {
      return false
    }
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEYS.open) return
      if (e.newValue === null) {
        setSplitPaneOpen(false)
        return
      }
      try {
        setSplitPaneOpen(JSON.parse(e.newValue) === true)
      } catch {
        /* ignore */
      }
    }
    const onSync = (e: Event) => {
      const detail = (e as CustomEvent<{ key: string; value: string | null }>)
        .detail
      if (!detail || detail.key !== STORAGE_KEYS.open) return
      if (detail.value === null) {
        setSplitPaneOpen(false)
        return
      }
      try {
        setSplitPaneOpen(JSON.parse(detail.value) === true)
      } catch {
        /* ignore */
      }
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener('zai-localstorage-sync', onSync)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('zai-localstorage-sync', onSync)
    }
  }, [])
  return isMobile || splitPaneOpen
}