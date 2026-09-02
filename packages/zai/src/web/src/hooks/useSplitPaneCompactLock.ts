// packages/zai/src/web/src/hooks/useSplitPaneCompactLock.ts
//
// 当右侧分屏开启时, 把 useAgentStore.transcriptCollapsed 锁在 true.
// 锁定期内任何 setTranscriptCollapsed(false) 都会被立刻回写为 true.
// 退出分屏后不干预 transcriptCollapsed, 让用户原态保留.
//
// 单向约束: 关闭分屏 → transcriptCollapsed 维持原值, 由 Layout.tsx
// 的 hydrate 行为或下次 settings.outputStyle 变更驱动.
//
// 用法:
//   const { isLocked } = useSplitPaneCompactLock()
//   {!isLocked && <TranscriptCollapseButton />}
//
// 不写 settings.json. transcriptCollapsed 仍是 store 单一真源;本 hook
// 只在 "splitPaneOpen=true ∧ transcriptCollapsed=false" 这种偏离态时
// 主动回写.
import { useEffect, useState } from 'react'
import { useAgentStoreOrCtx, useAgentStoreOrCtxApi } from '../store/useAgentStore.js'
import {
  STORAGE_KEYS,
  useLocalStorageState,
} from '../components/splitPane/shared.js'

export function useSplitPaneCompactLock(): { isLocked: boolean } {
  const [splitPaneOpen] = useLocalStorageState<boolean>(STORAGE_KEYS.open, false)
  const isLocked = splitPaneOpen
  const transcriptCollapsed = useAgentStoreOrCtx((s) => s.transcriptCollapsed)
  // 顶层取 store api(2026-09-02):useAgentStoreOrCtxApi() 内部 useContext,
  // 不能在 useEffect 内现取(Rules of Hooks)。Modal 内 Provider 注入的
  // intake store 通过 closure 拿到。
  const storeApi = useAgentStoreOrCtxApi()

  // Effect 1: splitPaneOpen 翻 true 时立刻 force transcriptCollapsed=true.
  // 不读 transcriptCollapsed 进依赖, 避免外部 setTranscriptCollapsed(false)
  // 触发的 effect 重跑再次覆盖;我们 effect 只听 splitPaneOpen.
  useEffect(() => {
    if (!splitPaneOpen) return
    if (!storeApi.getState().transcriptCollapsed) {
      storeApi.getState().setTranscriptCollapsed(true)
    }
  }, [splitPaneOpen, storeApi])

  // Effect 2: 锁定期内, 任何把 transcriptCollapsed 翻成 false 的写入立即回写.
  // 仅在 isLocked=true 时订阅, 关闭分屏后这个 effect 早退不再干预.
  useEffect(() => {
    if (!isLocked) return
    if (transcriptCollapsed) return
    storeApi.getState().setTranscriptCollapsed(true)
  }, [isLocked, transcriptCollapsed, storeApi])

  return { isLocked }
}