// packages/zai/src/web/src/hooks/autoScroll.ts
//
// 把"messages 更新是否要 scrollIntoView 底部"这条决策抽成纯函数, 让
// Agent.tsx 的 effect 只问一个问题就能决定是否 scrollIntoView。
//
// 设计动机 (root-cause 修): 旧逻辑 useEffect(..., [messages, pendingAsk,
// scrollFollowLocked]) 在 streaming delta 时会无差别 fire effect — 即使
// upsertStreamBlock 是 in-place 合并 (messages.length 不变), 新数组引用
// 仍让 React 重跑 effect, scrollIntoView 把用户正在阅读历史的位置拉回
// 底部。最初 fix 把"length 不增长"一律 stay, 但漏掉了 streaming 期间
// messages.length 不变、容器内容却长高 (同一 bubble 持续 append) 的场景 —
// 那时用户根本看不到新内容, 必须继续 follow。
//
// 现在的判定用三个独立信号:
//   - prevLength / nextLength   : 消息条目是否新增
//   - prevScrollHeight / scrollHeight : 容器内容是否真的长高
//   - distanceToBottomPx        : 用户是否还在底部附近
// 三者组合出 6 种决策, 由 contentGrew + distanceToBottomPx 共同承担
// "streaming 时是否要 follow" 的职责。

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
   * `===` 时通常意味着 streaming delta 复用同一 bubble, 不再仅凭此信号
   * 拒绝 follow — 还要看 contentGrew。
   * `<` 也不滚 (clearMessages / 切 session), 顶部哨兵不强行拉回。
   */
  nextLength: number
  /**
   * 容器 scrollHeight 是否相比上一次调用时增长。`true` 表示真的有新内容
   * 进入容器 (新增 bubble、代码块/图片渲染、streaming append 等),
   * 与 nextLength 独立 — streaming append 时 length 不变但 scrollHeight 增长。
   */
  contentGrew: boolean
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
  const { prevLength, nextLength, contentGrew, scrollFollowLocked, distanceToBottomPx } = input

  // 1) 用户主动滚 → 5s 锁内一律不滚 (用户主动翻历史期间, 不打扰)。
  //    注意: 即便 contentGrew, 用户手势期间也不要拉回 — 让 "N 条新消息" 提示
  //    (另一组件) 处理视觉反馈。
  if (scrollFollowLocked) return 'stay'

  // 2) 初始化 (首次 effect) → 强制落到底部, 让首屏对齐。
  //    之后 prevLength 才是真实历史值, 进入下面的 length 检查。
  if (prevLength < 0) return 'follow'

  // 3) 内容真的长高 (scrollHeight 增长) + 用户在底部 → 跟随。
  //    这是 streaming delta 期间的正确行为: 同一 bubble 持续 append, length
  //    没变但容器长高, 用户在底部 → 跟到底, 让新字符出现在视口里。
  //    用户不在底部 (> 80px) 时不打扰, 留给 5) 的距离判断。
  if (contentGrew && distanceToBottomPx <= NEAR_BOTTOM_PX) return 'follow'

  // 4) 长度和内容都没变 → effect 重跑但无新增 (例如 React strict-mode 二次挂载、
  //    store 引用刷新但数据未变)。保持当前位置。
  if (nextLength <= prevLength && !contentGrew) return 'stay'

  // 5) 用户已经上滚离开底部 (> 80px), 即便有新消息也不拉回, 让他继续读。
  //    视觉上的"新消息 N"标记是另一个组件的事, 这里只做"不拉回"决策。
  if (distanceToBottomPx > NEAR_BOTTOM_PX) return 'stay'

  // 6) 默认: 有新消息 / 有新内容, 用户在底部, 自动跟 AI 滚到底。
  return 'follow'
}