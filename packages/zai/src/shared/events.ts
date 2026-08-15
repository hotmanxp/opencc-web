import { z } from 'zod'

const Base = z.object({
  eventId: z.string(),
  ts: z.number(),
})

const RuntimeEvent = z.discriminatedUnion('type', [
  z.object({ ...Base.shape, type: z.literal('runtime.started'),
             sessionId: z.string(), turnIndex: z.number(),
             // zai patch (2026-08-09): 把 metrics 提升到 runtime.started
             // 上推送,每次 LLM 调用起点就刷新一次,不再等 runtime.done
             // (整条 prompt 跑完才发一次)。详见 routes/agent.ts 注释。
             apiRequestCount: z.number().optional(),
             contextTokens: z.number().optional() }),
  z.object({ ...Base.shape, type: z.literal('runtime.delta'),
             sessionId: z.string(), turnIndex: z.number(),
             delta: z.string() }),
  // 思考块的流式分片. 与 runtime.delta 平行通道 — UI 把 thinking 与
  // 文本独立折叠显示. 早期版本 thinking_delta 被 silently 丢弃, 只能从
  // transcript 刷新后看到, 流式过程看不到 — 这里加一条独立 spec event.
  z.object({ ...Base.shape, type: z.literal('runtime.thinking'),
             sessionId: z.string(), turnIndex: z.number(),
             thinking: z.string() }),
  // runtime.tool_call 必须带 toolUseId: server 在 content_block_stop / tool_use:start
  // 两个分支都填上游 block.id, 客户端不再合成. 这样 runtime.tool_result 用同一 id
  // upsert 能命中 start 条目, ToolCallBlock 才能从 "调用中" 切到 "已完成".
  //
  // runtime.tool_result 也必须带 toolName / input: 客户端 (useAgentStore
  // upsertToolCall 守卫) 依靠这两个字段识别 TodoWrite — TodoWrite 的
  // tool_use (start 阶段) 在守卫被吞掉, 不会写入 messages, 因此 done 路径
  // 无法从 prev 同 toolUseId 的 entry 拿 name / input. server 在
  // content_block_stop / tool_use:start 时把上游 block.name 缓存到
  // pendingToolName, tool_use:done 时再回填进 runtime.tool_result.
  z.object({ ...Base.shape, type: z.literal('runtime.tool_call'),
             sessionId: z.string(), turnIndex: z.number(),
             toolUseId: z.string(),
             toolName: z.string(), input: z.unknown() }),
  z.object({ ...Base.shape, type: z.literal('runtime.tool_result'),
             sessionId: z.string(), turnIndex: z.number(),
             toolUseId: z.string(),
             toolName: z.string(), input: z.unknown(),
             output: z.unknown() }),
  z.object({ ...Base.shape, type: z.literal('runtime.done'),
             sessionId: z.string(), turnIndex: z.number(),
             usage: z.object({ input: z.number(), output: z.number() }).optional(),
             // zai patch (2026-08-09): 该 session 截至本次 runtime.done 为止
             // 累计打给 AI provider 的请求次数(包含子代理/通知 query/非流式
             // fallback;不含 retry,详见 vendor sessionApiCounter.ts 注释)。
             // 前端 useAgentStore 用来显示"API 请求次数"行。
             apiRequestCount: z.number().optional(),
             // zai patch (2026-08-09): 最近一次 API 调用的 total context
             // tokens(input + cache_creation + cache_read,不含 output)。
             // session 首次 runtime.done 之前为 undefined,前端用 "—" 显示。
             // 用于会话信息面板"当前上下文大小"行。
             contextTokens: z.number().optional() }),
  z.object({ ...Base.shape, type: z.literal('runtime.aborted'),
             sessionId: z.string(), turnIndex: z.number(),
             reason: z.string() }),
  // runtime.error 携带 toolUseId 时表示"这是某个具体工具的失败" (例如
  // tool_use:error/invalid/denied 翻译过来的), 前端应把对应 tool_use:start
  // upsert 成 tool_use:error 让 ToolCallBlock 从"调用中"切到"错误".
  // 没有 toolUseId 时是 turn-level / 引擎级别错误, 只 setStatus.
  z.object({ ...Base.shape, type: z.literal('runtime.error'),
             sessionId: z.string(), turnIndex: z.number(),
             error: z.object({ category: z.string(), message: z.string(),
                               recoverable: z.boolean() }),
             toolUseId: z.string().optional() }),
  // 阶段 1 只有 trigger='auto'; manual 走原 kind:'compacted'(不变).
  // 同时 spread Base (拿到 eventId / ts) 与显式 timestamp: 前者是
  // ServerEvent union 共有, eventBus.history 续读 (Last-Event-ID 比对)
  // 与 SSE id: line 推送都依赖; 后者是压缩事件的"语义时间" (brief
  // Step 2 原文), 前端 applyCompactionEvent 用 timestamp + 5000ms 计算
  // toast expiresAt. Base.ts 与 timestamp 同时存在 → emit 时两条都填,
  // 客户端可任选. zod discriminatedUnion 允许成员字段冗余, 字段全集
  // (spread 后的 Base + 显式 timestamp) 完全合法.
  z.object({ ...Base.shape, type: z.literal('runtime.compacted'),
             sessionId: z.string(),
             trigger: z.enum(['auto', 'manual']),
             preTokens: z.number(),
             postTokens: z.number(),
             savedTokens: z.number(),
             timestamp: z.number() }),
  // runtime.retrying: emitted when the model caller retries after a recoverable
  // error (e.g. 529 overload). Frontend uses this to show a retrying toast.
  z.object({ ...Base.shape, type: z.literal('runtime.retrying'),
             sessionId: z.string(), turnIndex: z.number(),
             attempt: z.number(),
             delayMs: z.number(),
             nextAttemptAtMs: z.number(),
             category: z.enum(['llm_provider_overloaded', 'llm_provider_server', 'llm_provider_rate_limit']) }),
])

const SessionEvent = z.discriminatedUnion('type', [
  z.object({ ...Base.shape, type: z.literal('session.created'),
             sessionId: z.string(), title: z.string(), cwd: z.string() }),
  z.object({ ...Base.shape, type: z.literal('session.deleted'),
             sessionId: z.string() }),
  z.object({ ...Base.shape, type: z.literal('session.renamed'),
             sessionId: z.string(), title: z.string() }),
])

// job.* 事件携带 sessionId (派发该 job 的父 session, 在 agent_task 时等于
// BackgroundTask.parentSessionId)。客户端 useBackgroundTasks 据此把 dock
// 任务按当前 useAgentStore.sessionId 切分 — 切到其它 session 后,该 session
// 派发的 job 不再显示,避免多个 session 的任务堆积在同一个状态栏里。
// sessionId 缺失视为"全局 job" (resource_refresh / login / install),仍然
// 显示,与 session 无关。
const JobEvent = z.discriminatedUnion('type', [
  z.object({ ...Base.shape, type: z.literal('job.started'),
             jobId: z.string(),
             kind: z.enum(['resource_refresh','login','install','agent_task']),
             // agent_task 时携带后端 BackgroundTask.id,前端可直接 fetch /api/tasks/:taskId
             taskId: z.string().optional(),
             sessionId: z.string().nullable().optional() }),
  z.object({ ...Base.shape, type: z.literal('job.progress'),
             jobId: z.string(), message: z.string(), percent: z.number().optional(),
             sessionId: z.string().nullable().optional() }),
  z.object({ ...Base.shape, type: z.literal('job.done'),
             jobId: z.string(), result: z.unknown().optional(),
             sessionId: z.string().nullable().optional() }),
  z.object({ ...Base.shape, type: z.literal('job.failed'),
             jobId: z.string(), error: z.string(),
             sessionId: z.string().nullable().optional() }),
])

const PromptEvent = z.discriminatedUnion('type', [
  z.object({ ...Base.shape, type: z.literal('prompt.ask'),
             sessionId: z.string(), toolUseId: z.string(),
             questions: z.array(z.object({
               question: z.string(), header: z.string(),
               options: z.array(z.object({
                 label: z.string(), description: z.string().optional(),
               })),
             })) }),
  // prompt.approve — drawer 只收 filePath, 文档内容由前端按需 fetch
  // /api/agent/approve/file 取得. 这样 SSE 流量与文档大小解耦, 且用户
  // 总能看到 AI 提交后的最新版本(AI 可在 await 期间继续编辑文件).
  z.object({
    ...Base.shape,
    type: z.literal('prompt.approve'),
    sessionId: z.string(),
    toolUseId: z.string(),
    title: z.string(),
    summary: z.string().optional(),
    filePath: z.string(),
  }),
  // prompt.permission — vendor 权限系统返回 behavior:'ask' 时的通用确认.
  // headless permission bridge (headlessPermissionBridge.ts) 发
  // tool_use:permission_pending, agentRuntime.ts 翻译成此事件; 前端
  // PermissionConfirmCard 显示 toolName/description/input, 用户 allow/deny
  // 后 POST /api/agent/permission-response 触发 registry resolve.
  z.object({
    ...Base.shape,
    type: z.literal('prompt.permission'),
    sessionId: z.string(),
    toolUseId: z.string(),
    toolName: z.string(),
    description: z.string(),
    input: z.unknown().nullable(),
    message: z.string(),
  }),
])

const SystemEvent = z.discriminatedUnion('type', [
  z.object({ ...Base.shape, type: z.literal('server.connected'),
             sessionId: z.string().nullable() }),
  z.object({ ...Base.shape, type: z.literal('server.error'),
             message: z.string() }),
  z.object({ ...Base.shape, type: z.literal('toast'),
             level: z.enum(['info','warn','error']), message: z.string() }),
  z.object({ ...Base.shape, type: z.literal('branch.changed'),
             branch: z.string() }),
  z.object({ ...Base.shape, type: z.literal('system.restarting'),
             reason: z.enum(['user_action','auto_recovery','update']),
             deadlineMs: z.number() }),
  z.object({ ...Base.shape, type: z.literal('system.stopping'),
             deadlineMs: z.number() }),
  z.object({ ...Base.shape, type: z.literal('system.restart.canceled') }),
  // app.update.* — zai 自身版本自动升级通道。启动时 `maybeAutoUpdate`
  // (services/updater.ts) 在后台跑 `npm view @zn-ai/zai version` →
  // 比较 → 必要时 `npm install -g`,全程异步,通过这些事件把阶段
  // 同步给前端。payload 故意不带 sessionId(纯 system 级事件),
  // eventBus.isGlobalEvent() 必须显式登记才能跨 sid 广播。
  z.object({ ...Base.shape, type: z.literal('app.update.checking') }),
  z.object({ ...Base.shape, type: z.literal('app.update.installing'),
             from: z.string(), to: z.string() }),
  z.object({ ...Base.shape, type: z.literal('app.update.complete'),
             from: z.string(), to: z.string() }),
  z.object({ ...Base.shape, type: z.literal('app.update.failed'),
             from: z.string().optional(), to: z.string().optional(),
             error: z.string() }),
])

// state.* — 服务端 in-process StateChangeBus 经 zai server bridge 翻译后 emit。
// 4 个 type 都是 session-scoped (走 per-sid filter),除 agent_task.changed 兼容 null。
// payload 是全量快照(不是 diff)。
const StateEvent = z.discriminatedUnion('type', [
  z.object({
    ...Base.shape,
    type: z.literal('cwd.changed'),
    sessionId: z.string(),
    cwd: z.string(),
    updatedAt: z.number(),
  }),
  z.object({
    ...Base.shape,
    type: z.literal('bash_task.changed'),
    sessionId: z.string(),
    task: z.unknown(), // BashTaskInfo shape 由 zai-agent-core 保证
  }),
  z.object({
    ...Base.shape,
    type: z.literal('v2_task.changed'),
    sessionId: z.string(),
    task: z.unknown(),
    action: z.enum(['upsert', 'delete']),
  }),
  z.object({
    ...Base.shape,
    type: z.literal('agent_task.changed'),
    sessionId: z.string().nullable(),
    task: z.unknown(),
  }),
])

// instance.* — 中央实例管理器的状态变更广播. isGlobalEvent 登记, 所有 tab 实时收到.
const InstanceEvent = z.discriminatedUnion('type', [
  z.object({
    ...Base.shape,
    type: z.literal('instance.changed'),
    instanceId: z.string(),
    state: z.enum(['stopped', 'starting', 'running', 'stopping', 'down']),
    port: z.number().nullable(),
    pid: z.number().nullable(),
    lastHeartbeatAt: z.string().nullable(),
  }),
])

// queue.* — 每 session 的消息排队状态快照（对话进行中提交的 prompt 进入后端
// per-session 串行队列, 排队预览 + 状态机依赖此事件）。sid-scoped: 带
// sessionId, eventBus 按 sid 过滤 + historyBySid replay, 刷新后前端可恢复
// 排队状态。pending 为等待中命令的 {id, text} 列表（不含正在执行的那条）。
const QueueEvent = z.discriminatedUnion('type', [
  z.object({
    ...Base.shape,
    type: z.literal('queue.changed'),
    sessionId: z.string(),
    running: z.boolean(),
    queueLength: z.number(),
    pending: z.array(z.object({ id: z.string(), text: z.string() })),
  }),
])

export const ServerEvent = z.discriminatedUnion('type', [
  ...RuntimeEvent.options,
  ...SessionEvent.options,
  ...JobEvent.options,
  ...PromptEvent.options,
  ...SystemEvent.options,
  ...StateEvent.options,
  ...InstanceEvent.options,
  ...QueueEvent.options,
])
export type ServerEvent = z.infer<typeof ServerEvent>
