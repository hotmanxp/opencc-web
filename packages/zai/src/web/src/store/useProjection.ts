// useProjection — 投影值订阅面。
//
// 投影 (session/projection 帧) 是 host 算完的派生值快照 (title /
// context.tokens / 后续 transcript nodes), client 只做 higher-seq-wins
// 合并 (useAgentStore.applyProjection), 组件通过本 hook 订阅单个 key。
//
// selector 允许从原始值投影出派生视图 (如 context.tokens 数字格式化),
// equal 控制重渲染粒度 (默认 Object.is — 值未变不重渲染, zustand 的
// equalityFn 语义)。

import { useAgentStore } from './useAgentStore.js'

export function useProjection<T>(
  sessionId: string | null,
  key: string,
  selector: (value: unknown) => T = (v) => v as T,
  equal: (a: T, b: T) => boolean = Object.is,
): T | undefined {
  return useAgentStore(
    (s) => {
      const cell = sessionId ? s.projectionsBySession[sessionId]?.[key] : undefined
      return cell ? selector(cell.value) : undefined
    },
    equal,
  )
}
