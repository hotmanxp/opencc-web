/**
 * 压缩过程信号的统一出口 (2026-10-12)。
 *
 * **为什么是共用工厂**:手动 `/compact` 与自动压缩都从 vendor
 * `compactConversation` 的过程信号出发, 但此前两条路径的信号出口不同源
 * —— 自动走 REPL 事件流, 手动只能借用 command 层的通用埋点
 * (command.run/done, 不反映 vendor 压缩语义)。去重逻辑若各写一份必然
 * 漂移: 一侧忘了 keep-alive 早退, UI 就会被 30s 一次的重发反复唤醒。
 *
 * **为什么走 stateChangeBus**:core 是 runtime 库, 不该依赖 zai server 的
 * eventBus; stateChangeBus 是既有的跨层通道 (zn-agent-core → zai
 * stateBridge → SSE), zai 侧只需照现有 4 类事件的方式加一个订阅。
 * 注意手动路径**不 import 任何 zai 的东西** —— builtin/compact.ts 只
 * import 本模块。
 *
 * 时序保证 (vendor services/compact/compact.ts):
 *   - compact_end 在 finally 块里 (800) → 异常路径也发,结束信号不会丢;
 *   - 但 compact_start 在 PreCompact hook 之后 (452 vs 436) → hook 抛错
 *     会产生**孤立的 end**, 故 end 必须无条件置回 false;
 *   - keep-alive 每 30s 重发 'compacting' (1237-1246) → 必须早退。
 */

import { stateChangeBus } from '../../stateChangeBus.js'

/** 传入 buildReplToolUseContext 的 vendor 事件形状 (Tool.ts:182-183)。 */
export type VendorCompactProgressEvent = {
  type: 'compact_start' | 'compact_end' | 'hooks_start' | 'compact_progress'
  hookType?: string
  ratio?: number
}

export type CompactProgressEmitter = {
  /** 透给 buildReplToolUseContext 的回调。 */
  onCompactProgress: (event: VendorCompactProgressEvent) => void
  /**
   * 会话/命令结束时清理。**若此刻仍在压缩中会补发一次 compacting:false** ——
   * 否则异常提前退出(未走到 vendor finally 的 compact_end)时 UI 会卡在
   * 「正在压缩…」。不在压缩中则静默, 不产生多余帧。
   */
  dispose: () => void
}

/**
 * 造一个「vendor 压缩信号 → stateChangeBus」的转换器。
 *
 * 去重语义严格照搬 vendor 的 `isCompactingRef`
 * (opencc-src/hooks/useRemoteSession.ts:228-232):已在压缩中又收到 start
 * 就早退。
 */
export function createCompactProgressEmitter(
  sessionId: string,
): CompactProgressEmitter {
  // 闭包持有状态 —— 跨 turn 存活 (自动压缩的 end 可能落在 turnEnd 之后的
  // 清理阶段, 放调用方局部会让下一次 start 看不到"已在压缩中")。
  let isCompacting = false

  const onCompactProgress = (ev: VendorCompactProgressEvent): void => {
    // 两侧都要早退 —— vendor 的 setSDKStatus 与 onCompactProgress 都映射成
    // start/end (见 buildReplToolUseContext), 一次压缩必然收到 start×2 /
    // end×2, keep-alive 每 30s 还会再补一发 start。只挡 start 的话, 多余
    // 的 end 仍会重复 emit false。
    //
    // 目标状态 == 当前状态 时一律早退; 对 start/end 这类"翻转"事件, 状态
    // 本身已经充分表达了全部语义, 重复 emit 是纯噪音。
    if (ev.type === 'compact_start') {
      if (isCompacting) return
      isCompacting = true
    } else if (ev.type === 'compact_end') {
      // 无条件置回 false, 容忍孤立 end (PreCompact hook 抛错);
      // 但已经在 false 时早退, 避免重复 emit。
      if (!isCompacting) return
      isCompacting = false
    } else {
      // hooks_start / compact_progress 都不表达"压缩中"翻转。
      //
      // compact_progress 是流式摘要的 0..1 进度, 每个 token chunk 触发一次
      // —— 若将来要转发做进度条, 必须先节流, 否则刷爆事件流。
      return
    }
    stateChangeBus.emit('compact.changed', { sessionId, compacting: isCompacting })
  }

  const dispose = (): void => {
    // zai fix (2026-10-12): 离开压缩态时**必须补发 false**。
    //
    // 原来只是把闭包复位、不 emit —— 于是两条路径会留下卡死的 true:
    //   - 自动: createReplSession 的 teardown 在会话销毁时调 dispose, 若此刻
    //     仍在压缩中(vendor 侧异常提前抛出、未走到 finally 的 compact_end),
    //     UI 侧没有任何东西把它关掉;
    //   - 手动: builtin/compact.ts 的 finally 调 dispose, 中途退出同理。
    //
    // 只有真的处于压缩中才发(避免会话正常销毁时凭空多一帧 false)。
    if (isCompacting) {
      isCompacting = false
      stateChangeBus.emit('compact.changed', { sessionId, compacting: false })
    }
  }

  return { onCompactProgress, dispose }
}