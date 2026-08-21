/**
 * KernelAdapter — zai 服务层与具体内核之间的抽象接口（B0 T0.2）。
 *
 * 设计动机（主计划 §3.1）：
 * - 当前 zai 直接调用 `createOpenccRuntime()` 拼装 vendor runtime；接口与
 *   vendor 符号紧耦合。
 * - 双轨改造后 zai 服务层只依赖 `KernelAdapter`，把 vendor/dsh 符号锁在
 *   `services/kernel/factories/` 目录内；迭代内核时上层零改动。
 * - 接口不能过薄：必须含 abort / patchTranscript / readTranscript / state 订阅
 *   / metrics / enqueue，否则 B1b/B3/B6 阶段需要回头扩接口（审查 R9）。
 *
 * 能力面来源（主计划 §3.1）：
 * - 生命周期：start / shutdown（shutdown 必须显式 drain 顺序，B-1 验证）
 * - 会话：createSession / resumeSession / listSessions / deleteSession
 * - 驱动：run / abort
 * - transcript：patchTranscript / readTranscript（替代 compat/transcript/persistence.ts）
 * - 回调：onAsk / onApprove
 * - 状态：subscribeState
 * - 队列 / metrics：enqueue / metrics
 * - 后台任务：startBackgroundTask / notifySubagentDone
 *
 * 通用 KernelEvent 是 zai 服务层消费的最小事件投影；由各轨道的 translator
 * 把 vendor/dsh 事件翻译成此 union；B1b 完成 11 组映射（主计划 §5 G2 修正）。
 */

import type { ServerEvent } from '../../../shared/events.js';
import type { KernelId } from './paths.js';

/**
 * 单 session 的运行时句柄（zai 侧已持有）。
 * Adapter 不暴露此对象的内部结构 — 只作为 opaque token 透传，让各轨道内部
 * 用 vendor/dsh 各自的 session 类型实现。
 */
export interface AgentSession {
  readonly kernel: KernelId;
  readonly sessionId: string;
  readonly cwd: string;
}

/**
 * 会话元信息 — 列表 API 的返回类型。title/createdAt 来自各轨道自己的格式。
 */
export interface SessionMeta {
  sessionId: string;
  title: string;
  cwd: string;
  createdAt: number;
  /** dsh 专用：事件溯源 log 起始 seq；opencc 侧恒为 0。 */
  firstSeq?: number;
}

/**
 * transcript 修补条目 — patchTranscript 的入参。
 * 与现有 compat/transcript/persistence.ts 的 TranscriptPatch 兼容。
 */
export interface TranscriptPatch {
  kind: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system';
  /** dsh 模式下使用：目标 seq；opencc 模式下忽略。 */
  seq?: number;
  payload: Record<string, unknown>;
}

/**
 * transcript 重建条目 — readTranscript 的 yield 类型。
 */
export interface TranscriptEntry {
  seq: number;
  kind: TranscriptPatch['kind'];
  ts: number;
  payload: Record<string, unknown>;
}

/**
 * 审批 / 提问请求 — 双向桥接：dsh 侧 Consumer 请求回调到 zai registry，
 * zai 前端交互结果回传 Adapter。
 */
export interface AskRequest {
  sessionId: string;
  toolUseId: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description?: string }>;
  }>;
}

export type AskResponse = { answers: Record<string, string> };

export interface ApproveRequest {
  sessionId: string;
  toolUseId: string;
  toolName: string;
  title: string;
  summary?: string;
  filePath?: string;
}

export type ApproveResponse = { behavior: 'allow' | 'deny' | 'allow_remember' };

/** state.* 状态变化 — 替代 stateBridge.ts 的现实现。 */
export type StateChangeEvent =
  | { type: 'cwd.changed'; sessionId: string; cwd: string; updatedAt: number }
  | { type: 'bash_task.changed'; sessionId: string; task: unknown }
  | { type: 'v2_task.changed'; sessionId: string; task: unknown; action: 'upsert' | 'delete' }
  | { type: 'agent_task.changed'; sessionId: string | null; task: unknown };

/** 队列 payload — 给单 session 的消息排队。 */
export interface QueuePayload {
  text: string;
  /** 触发来源：用户输入 / followup / sub-agent。 */
  source?: 'user' | 'followup' | 'subagent';
}

/** metrics — zai 内部监控系统需要的基础数据。 */
export interface KernelMetrics {
  /** 当前活跃 session 数。 */
  activeSessions: number;
  /** 累计 turn 数（自 process start）。 */
  totalTurns: number;
  /** 累计工具调用数。 */
  totalToolCalls: number;
  /** 累计 API 请求数。 */
  totalApiRequests: number;
  /** 启动时间戳 (ms)。 */
  startedAt: number;
}

/** 后台任务句柄 — B5 阶段对齐 BackgroundRuntime 语义。 */
export interface BackgroundTaskHandle {
  taskId: string;
  sessionId: string;
  cancel(): Promise<void>;
}

/**
 * KernelAdapter — zai 服务层依赖的最小内核抽象。
 *
 * 严格规则：
 * - 不 import vendor / dsh 符号；类型由 Adapter 实现方在内部 import。
 * - Adapter 之间不共享 state；同一进程同一时刻只激活一条轨道。
 * - shutdown() 必须显式 drain：拒绝新请求 → flush 当前 turn → dispose → 清 globalThis 桥。
 */
export interface KernelAdapter {
  readonly kernel: KernelId;

  // ─── 生命周期 ─────────────────────────────────────────────────────
  start(): Promise<void>;
  /**
   * 关闭 adapter。必须走显式 drain 顺序：
   *   1. 拒绝新请求（abort in-flight run / 入队 prompt 立即返回拒绝）
   *   2. flush 当前 turn（dsh 侧 sessions.flush(agent.session)）
   *   3. dispose 内部 ctx / runtime
   *   4. 清 globalThis 桥（__zaiEventBus / __zaiBridgeCtx / __zaiCurrentSessionId）
   * 失败语义：抛错时调用方记录错误但不重试 — 下次启动会重新初始化。
   */
  shutdown(): Promise<void>;

  // ─── 会话 ─────────────────────────────────────────────────────────
  createSession(opts: { cwd: string; sessionId?: string }): Promise<AgentSession>;
  resumeSession(opts: { cwd: string; sessionId: string }): Promise<AgentSession>;
  listSessions(opts: { cwd: string }): Promise<SessionMeta[]>;
  deleteSession(opts: { cwd: string; sessionId: string }): Promise<void>;

  // ─── 驱动 ─────────────────────────────────────────────────────────
  /**
   * 单轮流式驱动。返回 `AsyncIterable<KernelEvent>`，由调用方负责写入 SSE。
   * 实现要点（dsh 侧，B1a T1.2）：
   *   - 首次 `await agent.whenIdle()`（loader 装载挂起）
   *   - 记 firstSeq
   *   - `agent.followup(createUserMessage(...))`
   *   - `await agent.whenIdle()`
   *   - `sessions.flush(agent.session)`
   *   - 从 firstSeq 起 yield agent.session.events
   */
  run(opts: { session: AgentSession; prompt: string }): AsyncIterable<ServerEvent>;

  /**
   * 中止当前 turn。SSE 中断 / 客户端 disconnect 时调用。
   * 实现要点（dsh 侧，B1b T1.6）：调用 Agent.cancel() 或 equivalent；不残留
   * turn in-progress 状态。
   */
  abort(opts: { session: AgentSession; reason?: string }): Promise<void>;

  // ─── transcript 修补 / 续读 ───────────────────────────────────────
  /** 替代 compat/transcript/persistence.ts：把 transcript 条目注入内核。 */
  patchTranscript(opts: { session: AgentSession; entries: TranscriptPatch[] }): Promise<void>;

  /** 从内核重建 transcript 视图（B3 T3.3 在 dsh 侧由 SessionEvent 序列重建）。 */
  readTranscript(opts: { session: AgentSession; sinceSeq?: number }): AsyncIterable<TranscriptEntry>;

  // ─── 回调注册 ─────────────────────────────────────────────────────
  /**
   * 注册 AskUserQuestion 处理回调（dsh 交互 seam → zai askRegistry）。
   * 多次注册：最后注册的 callback 覆盖；返回 disposer 用于清理。
   */
  onAsk(cb: (req: AskRequest) => Promise<AskResponse>): () => void;

  /** 注册权限审批处理回调（dsh approval seam → zai approveRegistry）。 */
  onApprove(cb: (req: ApproveRequest) => Promise<ApproveResponse>): () => void;

  // ─── 状态桥 ───────────────────────────────────────────────────────
  /**
   * 订阅状态变化（cwd/bash_task/v2_task/agent_task）— routes/state 路由消费。
   * 返回 disposer。
   */
  subscribeState(cb: (event: StateChangeEvent) => void): () => void;

  // ─── 队列与 metrics ───────────────────────────────────────────────
  /** 把消息塞进 session 队列（routes/agent.queue.ts 消费）。 */
  enqueue(opts: { session: AgentSession; payload: QueuePayload }): Promise<void>;
  metrics(): KernelMetrics;

  // ─── 后台任务 / 子 agent ──────────────────────────────────────────
  /** B5 阶段实现：把 zai BackgroundRuntime 语义映射到 dsh 子 agent。 */
  startBackgroundTask?(opts: {
    session: AgentSession;
    task: string;
    cwd?: string;
  }): Promise<BackgroundTaskHandle>;

  /** B5 阶段实现：子任务完成通知父 session 续传。 */
  notifySubagentDone?(opts: { session: AgentSession; taskId: string; result: unknown }): void;
}

/**
 * 单测 / 健康检查辅助 — Adapter 自检是否正确处理自身 kernel 字段。
 * 给 dsh adapter 用：在 createDshRuntime 顶部 assert `this.kernel === 'dsh'`。
 */
export function assertAdapterKernel(adapter: KernelAdapter, expected: KernelId): void {
  if (adapter.kernel !== expected) {
    throw new Error(`KernelAdapter kernel mismatch: expected '${expected}', got '${adapter.kernel}'`);
  }
}