// packages/zai/src/web/src/hooks/autoScroll.ts
//
// 把"messages 更新是否要 scrollIntoView 底部"这条决策抽成纯函数, 让
// Agent.tsx 的 effect 只问一个问题就能决定是否 scrollIntoView。
//
// 设计动机 (root-cause 修): 旧逻辑 useEffect(..., [messages, pendingAsk,
// scrollFollowLocked]) 在 streaming delta 时会无差别 fire effect — 即使
// upsertStreamBlock 是 in-place 合并 (messages.length 不变), 新数组引用
// 仍让 React 重跑 effect, scrollIntoView 把用户正在阅读历史的位置拉回
// 底部。这个函数把"无 length 增长"和"用户已上滚"两件事显式建模。

/** 当用户当前停留在距离底部 ≤ 80px 处, 视为"已在底部", 自动跟 AI 滚动。 */
export const NEAR_BOTTOM_PX = 80

export interface DecideAutoScrollInput {
  /**
   * 上一次 messages.length。首次调用传 `-1`, 强制滚动到首屏底部。
   * 用 ref 在调用方内部追踪, 不需要把 prevLength 写进 store。
   */
  prevLength: number
  /**
   * 当前 messages.length。`> prevLength` 才算"有新消息追加"。
   * `===` 不滚, 这是 root-cause 修复。
   * `<` 也不滚 (clearMessages / 切 session), 顶部哨兵不强行拉回。
   */
  nextLength: number
  /** 用 useScrollFollow 拿到的"用户最近 5s 内主动滚过"锁。 */
  scrollFollowLocked: boolean
  /**
   * 距离视口底部的像素。`> NEAR_BOTTOM_PX` 时视为"用户在读历史, 别打扰"。
   * `Infinity` 用于初始化时强制跟随 (容器尚未挂载, 量不到距离)。
   */
  distanceToBottomPx: number
}

export type AutoScrollDecision = 'follow' | 'stay'

export function decideAutoScroll(
  input: DecideAutoScrollInput,
): AutoScrollDecision {
  const { prevLength, nextLength, scrollFollowLocked, distanceToBottomPx } = input

  // 1) 用户主动滚 → 5s 锁内一律不滚 (用户主动翻历史期间, 不打扰)
  if (scrollFollowLocked) return 'stay'

  // 2) 初始化 (首次 effect) → 强制落到底部, 让首屏对齐。
  //    之后 prevLength 才是真实历史值, 进入下面的 length 检查。
  if (prevLength < 0) return 'follow'

  // 3) length 不增长 (delta in-place append / 已经引用相等) → 不滚
  //    这是 root-cause 修复: streaming 期间 messages 引用每条 delta 都换,
  //    但 length 不变, 让用户视线停留在原本位置。
  if (nextLength <= prevLength) return 'stay'

  // 4) 用户已经上滚离开底部 (> 80px), 即便有新消息也不拉回, 让他继续读。
  //    视觉上的"新消息 N"标记是另一个组件的事, 这里只做"不拉回"决策。
  if (distanceToBottomPx > NEAR_BOTTOM_PX) return 'stay'

  // 5) 默认: 有新消息, 用户在底部, 自动跟 AI 滚到底。
  return 'follow'
}
