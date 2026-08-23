/**
 * vendorSeam 公共出口 —— zai 端从 `@zn-ai/dsh-bridge` 导入本目录符号。
 *
 * 关键说明:
 *   - 本目录是 dsh 模式的厂商中立 seam —— zai 端 import `@zn-ai/dsh-bridge`
 *     时,**不**直接 import `@deepseek-ai/dsh-*` 包,通过本目录屏蔽。
 *   - 来源路径:`packages/dsh-bridge/src/vendorSeam/`
 *   - 公共类型(被 zai 直接消费)在 `types.ts`,只是 vendor 类型的别名
 *   - Adapter 实现(DshSubagentControlAdapter / DshJobsControlAdapter)暴露
 *     为工厂 `createDshSubagentControlBridge` / `createDshJobsControlBridge`
 *
 * Stage 范围(规划见 `optimized-twirling-pine.md`):
 *   - Stage 0:本文件存在 —— vendorSeam 抽象完成
 *   - Stage 1:zai factory 收口(本目录被 zai-side 消费)
 *   - Stage 4:Fork provider 装载 + input.context='fork' 实装
 *   - Stage 5:capability 五件套(outputSchema/toolFilter/persona/maxDepth/continuable)
 *   - Stage 6:bash spill / grace / maxOutputBytes
 *   - Stage 7:wakeup/quiet + 清理
 *
 * **不在范围(明确)**:opencc 兼容层 seam (compat-impl seam 留给未来独立的
 * 'opencc-track bridge')。本目录只针对 dsh 轨道。
 */

export type {
  // 类型别名
  SeamSubagentStopReason,
  SeamJobStatus,
  SeamJobKindMap,
  SeamSessionId,
  SeamJobSnapshot,
  SeamJobRead,
  SeamContentBlock,
  SeamSubagentRun,
  SeamSubagentResult,
  // 适配器输入/输出
  SeamSubagentDispatchInput,
  SeamSubagentHandle,
  SeamSubagentTerminalState,
  SeamSubagentChangeListener,
  SeamSubagentSummary,
  SeamJobKind,
  SeamJobStartInput,
  SeamBashJobInput,
  SeamJobStartResult,
  SeamJobSummary,
  SeamJobChangeListener,
  // 错误
  SeamInvalidArgumentError,
  SeamConcurrentJobsExceededError,
  SeamRuntimeError,
  // 接口契约
  SubagentControlSeam,
  JobsControlSeam,
} from './types.js'

export {
  DshSubagentControlAdapter,
  createDshSubagentControlBridge,
  type DshSubagentAdapterOptions,
} from './subagent.js'

export {
  DshJobsControlAdapter,
  createDshJobsControlBridge,
  type DshJobsAdapterOptions,
} from './jobs.js'
