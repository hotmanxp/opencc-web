// @ts-nocheck — 依赖 vendor 模块,主 tsconfig 排除了 src/opencc-src,
// 只能用 `as any` 桥接(与 compat/ 下其他 bridge 一致)。

/**
 * 手动 `/compact` 接入 vendor `compactConversation` 的桥。
 *
 * 背景:zai 手动 `/compact` 原是自建实现(342 行,只借用
 * `queryModelWithStreaming` 生成摘要),绕开了 vendor 整条压缩链路,缺
 * PreCompact/PostCompact hooks、PTL(prompt-too-long)自愈重试、microcompact
 * 前置、压缩后缓存清理。自动压缩一直走 vendor `autoCompact.ts`,所以
 * 手动路径是唯一缺口。本 bridge 把那条链路接过来。
 *
 * 为什么导出 wrapper 而不是 `compactConversation` 本体:`compactConversation`
 * 有 6 个位置参数,其中 `cacheSafeParams` 需要 `getSystemPrompt` /
 * `getUserContext` / `getSystemContext` 三个异步依赖。裸导出等于把这个易错
 * 细节推给每个调用方。调用序列照搬 vendor 参考实现
 * (`opencc-src/commands/compact/compact.ts` 的 `call`)。
 *
 * **落盘不在本模块职责内**:`compactConversation` 自己不写盘(它内部两处
 * `writeSessionTranscriptSegment` 都在 `if (false)` 里),vendor 靠上层
 * `query()` 接管 yield。zai 走 `/api/command`,不经过那条路径,所以落盘仍由
 * zai 侧 `builtin/compact.ts` 用 `store.replace()` 完成。本模块只负责
 * 「把 vendor 的压缩能力接进来」+「补上 vendor 命令层的后置清理」。
 *
 * 规划见 docs/superpowers/plans/2026-10-08-wire-manual-compact-to-vendor.md。
 */

import { compactConversation } from '../../opencc-src/services/compact/compact.js'
import { microcompactMessages } from '../../opencc-src/services/compact/microCompact.js'
import { runPostCompactCleanup } from '../../opencc-src/services/compact/postCompactCleanup.js'
import { suppressCompactWarning } from '../../opencc-src/services/compact/compactWarningState.js'
import { getSystemPrompt } from '../../opencc-src/constants/prompts.js'
import { getSystemContext, getUserContext } from '../../opencc-src/context.js'
import { buildEffectiveSystemPrompt } from '../../opencc-src/utils/systemPrompt.js'
import { setLastSummarizedMessageId } from '../../opencc-src/services/SessionMemory/sessionMemoryUtils.js'
import { extractSummaryText } from './compactResult.js'

/**
 * 调用方提供的 vendor `Message[]`。zai 的 transcript 条目是 compat 形状
 * (`{type, message:{content}}`),与 vendor `Message` 结构兼容(见
 * compat/transcript/types.ts 与 vendor types/message.ts),但仍需调用方保证
 * 已按 vendor 期望裁剪。
 */
export type CompactViaVendorOptions = {
  messages: any[]
  /** 由 `buildReplToolUseContext` 构造(见 compat/repl/)。 */
  toolUseContext: any
  /** 传给 vendor `getSystemPrompt` 的模型名。 */
  model: string
  cwd: string
  /**
   * 附加指令。zai 借此保持中文摘要 —— vendor 默认英文 prompt,直接用会让
   * 中文用户的会话摘要变英文(见规划 §4.4)。
   */
  customInstructions?: string
  /** 默认 true,对齐 vendor 参考实现:先 microcompact 再摘要。 */
  microcompact?: boolean
}

/**
 * vendor `CompactionResult` 的摘要视图。只暴露 zai 侧实际需要的字段,
 * 避免 zai 依赖 vendor 内部 `Message[]` 形状(那个形状跨边界翻译风险高,
 * 详见规划 §3.1)。
 */
export type CompactViaVendorResult = {
  /** 摘要正文。 */
  summary: string
  /** 压缩前 token 数(用于日志/遥测)。 */
  preCompactTokenCount: number
  /** 压缩后 token 数;真实值可能因 provider 差异为估算。 */
  postCompactTokenCount: number
  /** 保留段 —— vendor 建议原样保留的消息(含原 parentUuid)。 */
  messagesToKeep: any[]
  /** hooks 产出的用户可见消息;无则 undefined。 */
  userDisplayMessage?: string
}

/**
 * 构造 `compactConversation` 需要的 `cacheSafeParams`。
 *
 * 照搬 vendor `commands/compact/compact.ts:263-300` 的 `getCacheSharingParams`:
 * system prompt 必须与主循环一致,否则 prompt cache 命中率崩塌。
 */
async function buildCacheSafeParams(
  toolUseContext: any,
  forkContextMessages: any[],
): Promise<any> {
  const appState = toolUseContext.getAppState()
  const defaultSysPrompt = await getSystemPrompt(
    toolUseContext.options.tools,
    toolUseContext.options.mainLoopModel,
    Array.from(
      appState.toolPermissionContext?.additionalWorkingDirectories?.keys() ??
        [],
    ),
    toolUseContext.options.mcpClients,
  )
  const systemPrompt = buildEffectiveSystemPrompt({
    mainThreadAgentDefinition: undefined,
    toolUseContext,
    customSystemPrompt: toolUseContext.options.customSystemPrompt,
    defaultSystemPrompt: defaultSysPrompt,
    appendSystemPrompt: toolUseContext.options.appendSystemPrompt,
  })
  const [userContext, systemContext] = await Promise.all([
    getUserContext(),
    getSystemContext(),
  ])
  return {
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext,
    forkContextMessages,
  }
}

/**
 * 走 vendor 压缩链路生成摘要。
 *
 * 调用序列与 vendor `commands/compact/compact.ts` 的 `call` 一致:
 *   microcompact → compactConversation → 后置清理
 *
 * 错误**不吞**:vendor 的错误常量(`ERROR_MESSAGE_NOT_ENOUGH_MESSAGES` 等)
 * 原样抛出,由 zai 侧 `builtin/compact.ts` 翻译成中文文案(规划 §4.5),
 * 避免在 core 层固化 UI 文案。
 */
export async function compactViaVendor(
  opts: CompactViaVendorOptions,
): Promise<CompactViaVendorResult> {
  const {
    messages,
    toolUseContext,
    customInstructions,
    microcompact = true,
  } = opts

  // 1. microcompact 前置 —— 先用工具结果清空把 token 压下去,减少摘要负担。
  //    vendor 参考实现无条件执行;调用方可关掉。
  const messagesForCompact = microcompact
    ? (await microcompactMessages(messages, toolUseContext)).messages
    : messages

  // 2. cacheSafeParams 与 pre-compact hooks 在 vendor 内部串行执行,
  //    这里只负责把依赖备齐。
  const cacheSafeParams = await buildCacheSafeParams(
    toolUseContext,
    messagesForCompact,
  )

  // 3. 压缩本体。参数顺序照 vendor 签名:
  //    (messages, context, cacheSafeParams, suppressFollowUpQuestions,
  //     customInstructions, isAutoCompact, recompactionInfo)
  const result = await compactConversation(
    messagesForCompact,
    toolUseContext,
    cacheSafeParams,
    false,
    customInstructions,
    false, // isAutoCompact:手动压缩
  )

  // 4. 后置清理 —— 这些是 vendor **命令层**的职责,`compactConversation` 自己
  //    不做(自动压缩由 autoCompact.ts 内部完成)。漏了就留下 microcompact
  //    追踪状态、getUserContext/getMemoryFiles memo、systemPromptSections、
  //    分类器审批、Bash 权限推测、beta tracing、sessionMessages cache。
  //    legacy 压缩替换全部消息后旧 UUID 失效,同样要重置。
  setLastSummarizedMessageId(undefined)
  suppressCompactWarning()
  runPostCompactCleanup()

  return {
    summary: extractSummaryText(result),
    preCompactTokenCount: result.preCompactTokenCount,
    postCompactTokenCount: result.postCompactTokenCount,
    messagesToKeep: result.messagesToKeep ?? [],
    userDisplayMessage: result.userDisplayMessage,
  }
}
