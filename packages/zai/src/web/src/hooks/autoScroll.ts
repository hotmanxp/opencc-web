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
  /**
   * 折叠视图态 (transcriptCollapsed === true)。折叠态下 AssistantTextBody
   * 的 maxHeight:140 + overflow:hidden clamp 让 outer scrollHeight 在文字
   * 越过 ~6 行后停涨, `contentGrew` 信号失真. 折叠态下用 messages 数组
   * 引用变化作为 fallback 信号, 而非依赖 scrollHeight delta.
   */
  folded?: boolean
  /**
   * messages 数组引用是否变化 (`messages !== prevMessages`). 折叠态下
   * streaming delta 与 tool_result 都是 in-place 更新, 引用换但 length 不
   * 变, 这正是折叠视图不滚的根因 — 但 store 真的写过新数据, UI 必须跟.
   */
  messagesRefChanged?: boolean
  /**
   * 上一帧调用结束时, 用户 scrollTop 是否与本帧相同 (容差 5px). hook
   * 层在 `scrollTo` 之后把 `el.scrollTop` 写进 `prevScrollTopRef`, 下
   * 次事件拿 `el.scrollTop` 与之比较, 几乎不动视作 "user 仍在底部".
   *
   * 触发场景: 滚动容器内容在两次 effect 之间涨 > 80px (典型 streaming
   * delta), hook 调 `scrollTo({top: scrollHeight})` 被浏览器 clamp 到
   * `scrollHeight - clientHeight`, 但 React 后续 render 让 scrollHeight
   * 再涨, 下一次 effect 时 `scrollTop` 仍停在旧 max 处, `distanceToBottomPx`
   * 显示 > 80px 误判 userScrolledAway. 此时若 `wasAtBottom=true` (user
   * 上一帧就在底部没动), 实际是 scrollTop 落后于新内容, 应 follow.
   */
  wasAtBottom?: boolean
}

export type AutoScrollDecision = 'follow' | 'stay'

/**
 * 决策原因 — 决策函数每个 return 分支都打一个稳定 id, 调用方打印日志时
 * 直接带出来. 这样可以一眼看出 "为什么不滚" 是 rule #1 (用户锁) 还是
 * rule #4 (无变化) 还是 rule #5 (用户上滚). 测试也用同一 id 做断言.
 *
 * 命名规则: <rule 名> + (适用条件). 不重复规则序号, 留出新增规则的余地.
 */
export type AutoScrollReason =
  | 'scrollFollowLocked'  // rule #1: 用户 5s 内主动滚, 锁中
  | 'init'                // rule #2: 首次 effect, 强制落到底
  | 'contentGrewInBottom' // rule #3: scrollHeight 涨 + 用户在底部
  | 'foldedFallback'      // rule #3.5: 折叠视图 + 引用换了 + !contentGrew + 在底部
  | 'noChange'            // rule #4: length 没增 + 内容没长高
  | 'userScrolledAway'    // rule #5: distanceToBottomPx > NEAR_BOTTOM_PX, user 真走开
  | 'wasAtBottomContentGrew' // rule #5a: 上一帧在底部 + contentGrew, clamp 落后补滚
  | 'default'             // rule #6: 兜底 follow

export interface AutoScrollDecisionResult {
  decision: AutoScrollDecision
  reason: AutoScrollReason
}

export function decideAutoScroll(
  input: DecideAutoScrollInput,
): AutoScrollDecisionResult {
  const {
    prevLength,
    nextLength,
    contentGrew,
    scrollFollowLocked,
    distanceToBottomPx,
    folded = false,
    messagesRefChanged = false,
    wasAtBottom = false,
  } = input

  // 1) 用户主动滚 → 5s 锁内一律不滚 (用户主动翻历史期间, 不打扰)。
  //    注意: 即便 contentGrew, 用户手势期间也不要拉回 — 让 "N 条新消息" 提示
  //    (另一组件) 处理视觉反馈。
  if (scrollFollowLocked) return { decision: 'stay', reason: 'scrollFollowLocked' }

  // 2) 初始化 (首次 effect) → 强制落到底部, 让首屏对齐。
  //    之后 prevLength 才是真实历史值, 进入下面的 length 检查。
  if (prevLength < 0) return { decision: 'follow', reason: 'init' }

  // 3) 内容真的长高 (scrollHeight 增长) + 用户在底部 → 跟随。
  //    这是 streaming delta 期间的正确行为: 同一 bubble 持续 append, length
  //    没变但容器长高, 用户在底部 → 跟到底, 让新字符出现在视口里。
  //    用户不在底部 (> 80px) 时不打扰, 留给 5) 的距离判断。
  if (contentGrew && distanceToBottomPx <= NEAR_BOTTOM_PX) {
    return { decision: 'follow', reason: 'contentGrewInBottom' }
  }

  // 3.5) 折叠视图 fallback: CollapsedMessageBubble 的 maxHeight:140 +
  //    overflow:hidden clamp 让 outer scrollHeight 在文字越过 ~6 行后
  //    停涨, contentGrew 失真. 但 store 里 messages 真的写过 (引用换了),
  //    UI 必须跟 — 不然用户看不到 tool_result 已完成 / 后续 streaming
  //    delta. 仅在用户已在底部时触发, 用户上滚 (>80px) 仍 stay.
  //    nextLength > prevLength 已由外层 caller 兜底覆盖 "新增消息"
  //    路径, 此处专门救 length 不变 + contentGrew=false 的折叠态
  //    streaming delta / tool_result.
  if (
    folded &&
    messagesRefChanged &&
    !contentGrew &&
    nextLength === prevLength &&
    distanceToBottomPx <= NEAR_BOTTOM_PX
  ) {
    return { decision: 'follow', reason: 'foldedFallback' }
  }

  // 4) 长度和内容都没变 → effect 重跑但无新增 (例如 React strict-mode 二次挂载、
  //    store 引用刷新但数据未变)。保持当前位置。
  if (nextLength <= prevLength && !contentGrew) {
    return { decision: 'stay', reason: 'noChange' }
  }

  // 5) 用户已经上滚离开底部 (> 80px). 但是 ——
  //    若 user 上一帧就停在底部 (wasAtBottom=true) 且 contentGrew, 实际是
  //    scrollTop 被 clamp 落后于新 scrollHeight (浏览器把 scrollTo({top:
  //    scrollHeight}) 限到 scrollHeight - clientHeight, 但 React 后续 render
  //    让 scrollHeight 又涨). 这种情况不能让 user 被永久甩在旧内容上方.
  //    反之 (wasAtBottom=false), user 真的在看历史, 留给 "新消息 N" 处理.
  if (distanceToBottomPx > NEAR_BOTTOM_PX) {
    if (wasAtBottom && contentGrew) {
      return { decision: 'follow', reason: 'wasAtBottomContentGrew' }
    }
    return { decision: 'stay', reason: 'userScrolledAway' }
  }

  // 6) 默认: 有新消息 / 有新内容, 用户在底部, 自动跟 AI 滚到底。
  return { decision: 'follow', reason: 'default' }
}