import { z } from 'zod'

import {
  SubagentEvent,
  SubagentStartEvent,
  SubagentEndEvent,
  SubagentDescriptorEvent,
  SubagentStateEvent,
  SubagentMessageEvent,
  SubagentErrorEvent,
} from './subagentEvents.js'

const Base = z.object({
  eventId: z.string(),
  ts: z.number(),
  // 服务端全局单调递增顺序号 — 消息合并 / 重连补发 / 投影合并的唯一基准。
  // 由 eventBus.emit 分配（emit 时省略则自动填充）。只保证单进程内单调，
  // 跨重启由 eventId + history replay 兜底，不得当持久化 ID 用。
  seq: z.number(),
})

/**
 * DshToolTodo upstream 产出的 TodoItem schema(whole-list snapshot,无 id 字段,
 * content 是唯一标识)。dsh-bridge translate/sessionEvents.ts 直接透传到
 * v2_task.changed event 的 `tasks` 字段。客户端 reducer (useAgentStore
 * applyV2TaskChanged action='snapshot' 分支) cast 成 V2TaskItem 后做映射
 * (id=content, subject=content, blocks=[], blockedBy=[], updatedAt=now)。
 *
 * 故意不引 V2TaskItemWire 的 zod schema 在此处 — translate 路径 payload 与
 * 客户端 V2TaskItem 不在同一形态,前端做映射更干净(snapshot 是 opaque
 * 投影,客户端知道怎么转)。
 */
const DshTodoItemSchema = z.object({
  content: z.string(),
  status: z.string(),
})

export const RuntimeEvent = z.discriminatedUnion('type', [
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
             output: z.unknown(),
             // Phase 4 P1: 透传 dsh `tool/result` 事件顶层 `meta`
             // (presentationMeta — SearchResultView / ReadResultView 等
             // opaque 渲染元数据)。当前仅 `grep` / `glob` 等结构化工具
             // 会携带;其他工具 absent → 前端 renderer 走默认文本路径。
             meta: z.unknown().optional() }),
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
  // DSH subagent 生命周期事件 (Task 2 aligned with vendor schema)
  SubagentStartEvent,
  SubagentEndEvent,
  SubagentDescriptorEvent,
  SubagentStateEvent,
  SubagentMessageEvent,
  SubagentErrorEvent,
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
  // Phase 5P5 适配:dsh-tool-todo 上游是 whole-list snapshot 语义(每次
  // `todo/write` 携带 `tasks: TodoItem[]` 整 list 替换,无 id 字段),与
  // opencc-mode 单 task CRUD 的 upsert/delete 语义不兼容。
  //
  // 之前的错尝试(已修):把 snapshot 分支塞进同一个 `v2_task.changed`
  // discriminator 同名 slot,期望 zod 跨 action 联合。但 zod
  // discriminatedUnion 只看单一字段('type'),同 type literal 重复立即抛
  // `Discriminator property type has duplicate value v2_task.changed`,
  // 模块 load 阶段就崩,React <div id="root"> 永远空(SSE 连接都建不起来)。
  //
  // 正确做法:开新 event type 'v2_task.snapshot'。reducer
  // (useAgentStore.applyV2TaskSnapshot) 整 list 替换 v2TasksBySession[sid],
  // 把 TodoItem[] 映射成 V2TaskItem[] (id=content, subject=content,
  // blocks=[], blockedBy=[], updatedAt=now)。opencc 模式仍走 v2_task.changed
  // upsert/delete 单 task CRUD,两条通道互不干扰,topics['v2'] 在
  // services/eventBus.ts:topicMatches 同时匹配两个 type。
  z.object({
    ...Base.shape,
    type: z.literal('v2_task.snapshot'),
    sessionId: z.string(),
    tasks: z.array(DshTodoItemSchema),
    action: z.literal('snapshot'),
  }),
  z.object({
    ...Base.shape,
    type: z.literal('agent_task.changed'),
    sessionId: z.string().nullable(),
    task: z.unknown(),
  }),
  // dsh-018: dsh-mode cron 任务变化(从 dsh-bridge 透传)。
  // payload 用 z.unknown() — zai-side dsh factory 写入的 cron 任务有
  // 自己的 schema(dsh-bridge cron.ts 的 CronTask),UI 端按需 cast。
  z.object({
    ...Base.shape,
    type: z.literal('cron.changed'),
    sessionId: z.string(),
    cronTaskId: z.string(),
    cron: z.string(),
    prompt: z.string(),
    nextFireAt: z.number(),
    action: z.enum(['create', 'delete', 'list', 'fire']),
  }),
  /**
   * @deprecated 自 2026-08-24 起使用 `subagent.start` / `subagent.end` 替代;
   * 旧事件运行期同步发(deprecation shim),2026-09-30 通过 feature flag
   * `agent.subagent.eventV2.enabled` 关闭。详见 spec §4 事件 Schema 对齐。
   */
  z.object({
    ...Base.shape,
    type: z.literal('subagent.changed'),
    sessionId: z.string(),
    taskId: z.string(),
    description: z.string(),
    status: z.enum(['running', 'done', 'failed', 'cancelled']),
    result: z.string().optional(),
    error: z.string().optional(),
    action: z.enum(['start', 'finish']),
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

// command.* — 命令生命周期埋点。/api/agent/command 入口发 command.run,
// 三处出口(local call / prompt branch / skill fallthrough / exception)各自
// 发 command.done,共享同一 commandId 配对。设计借鉴 dsh `command/run` +
// `command/done` 模式,用于会话日志、调试、慢命令分析。
//
// 决策(2026-08-16):
// - 归 `command.*` group,与 session.* / job.* / prompt.* 同级(语义集中,避免
//   堆到 system.* 里变成杂项)。isGlobalEvent 同步登记,跨 sid 广播;前端
//   NAMED_EVENT_TYPES 同步加,否则 EventSource 静默丢。
// - `ts` 字段手动填 Date.now():run.ts = 触发瞬间,done.ts = 结束瞬间;
//   durationMs = done.ts - run.ts,精确测量而非依赖 eventBus 自动填充。
// - args 1KB 截断:超过 MAX_ARGS_LENGTH 时 args 截断到 1024 bytes,加
//   argsTruncated:true 标记,防止 1MB 文本注入把 history/context 撑爆。
// - trigger: 'user' = /cmd 直接调用, 'skill' = skill fallthrough;
//   后续 AI 内部主动跑命令再加 'agent'。
const CommandEvent = z.discriminatedUnion('type', [
  z.object({
    ...Base.shape,
    type: z.literal('command.run'),
    sessionId: z.string(),
    // uuid, run/done 配对 (crypto.randomUUID() 生成,单进程全局唯一)
    commandId: z.string(),
    // 命令名, e.g. 'compact' / 'handoff' / 'unknown' (cmd.get 没找到时空字串)
    name: z.string(),
    // 原始 args 字符串(已 1KB 截断, 截断时同时设 argsTruncated:true)
    args: z.string(),
    argsTruncated: z.boolean().optional(),
    trigger: z.enum(['user', 'skill']),
    // 触发瞬间, 命令进入路由时手动填 Date.now()
    ts: z.number(),
  }),
  z.object({
    ...Base.shape,
    type: z.literal('command.done'),
    sessionId: z.string(),
    commandId: z.string(),
    name: z.string(),
    // 出口类型: 'cleared' / 'compacted' / 'status' / 'message' / 'prompt' /
    // 'error' / 'unknown'。union 与 routes/command.ts 的 res.json 类型严格
    // 对齐,新增 kind 时必须同步这里(以及 routes/command.ts 的 res.json),
    // zod 编译期拦截飘移。
    result: z.enum([
      'cleared',
      'compacted',
      'status',
      'message',
      'prompt',
      'error',
      'unknown',
    ]),
    durationMs: z.number(),
    // 异常时填充,result='error' 时必填
    error: z.string().optional(),
    // 结束瞬间, 手动填 Date.now()
    ts: z.number(),
  }),
])

// stream/error — 结构化帧级错误。server 在 SSE 写入中途崩溃 / 业务侧捕获
// 未预期异常且无法继续推送时，发一个闭合 code 的错误帧再关闭连接。
// code 为闭合 union，前端按 code 路由，新错误类型无需字符串匹配。
// 纯 server→client 推送，无 sid（可选 sessionId），isGlobalEvent 登记为全局。
const RpcErrorCode = z.enum([
  'internal',
  'bad-request',
  'session-not-found',
  'session-conflict',
  'model-unavailable',
  'timeout',
  'cancelled',
  'agent-busy',
  'stream-write-failed',
  'invalid-response',
])

const StreamErrorEvent = z.object({
  ...Base.shape,
  type: z.literal('stream/error'),
  error: z.object({
    code: RpcErrorCode,
    message: z.string(),
    details: z.record(z.unknown()).default({}),
  }),
})

// weixin.inbound — 微信入站消息事件,sid-scoped (sessionId 命名约定:
// `weixin:<accountId>:<chatType>:<chatId>`)。B3 阶段微信适配器
// (services/weixinBot/WeixinAdapter.ts) 解析 iLink long-poll 消息后 emit,
// 推给 SSE → Web UI InboxPreview,以及对端镜像订阅者。B3 阶段的
// WeixinBotManager 通过订阅此事件 + eventBus 的 runtime.* 出站事件,
// 完成双向桥。详见 docs/superpowers/plans/2026-08-16-zai-weixin-bot-platform.md B3。
const WeixinInboundEvent = z.object({
  ...Base.shape,
  type: z.literal('weixin.inbound'),
  sessionId: z.string(),
  accountId: z.string(),
  chatType: z.enum(['dm', 'group']),
  chatId: z.string(),
  senderId: z.string(),
  text: z.string(),
  // 本地缓存路径(已下载 + AES-128-ECB 解密)
  mediaPaths: z.array(z.string()).default([]),
  mediaTypes: z.array(z.string()).default([]),
  messageId: z.string(),
  contextToken: z.string().nullable(),
  // iLink 原始 payload,留作调试
  raw: z.unknown().optional(),
})

// session/projection — host 算完的派生值快照按 key 整体推送（不是 diff）。
// client 只做 higher-seq-wins 合并（seq 即投影单元的 watermark，复用全局
// 事件 seq：emit 省略时由 eventBus 分配）。重连后 host 重算整体重发，
// client 无需关心合并。
const ProjectionEvent = z.object({
  ...Base.shape,
  type: z.literal('session/projection'),
  sessionId: z.string(),
  key: z.string().min(1),
  value: z.unknown(), // host 侧 schema 已校验；此处保持 wide
  seq: z.number().int().nonnegative(), // 投影单元的 watermark，higher-seq-wins
})

export const ServerEvent = z.discriminatedUnion('type', [
  ...RuntimeEvent.options,
  ...SessionEvent.options,
  ...JobEvent.options,
  ...PromptEvent.options,
  ...SystemEvent.options,
  ...StateEvent.options,
  ...InstanceEvent.options,
  ...QueueEvent.options,
  ...CommandEvent.options,
  WeixinInboundEvent,
  StreamErrorEvent,
  ProjectionEvent,
])
export type ServerEvent = z.infer<typeof ServerEvent>
