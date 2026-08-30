# DSH subagent 架构参考（0.1.2-alpha.2）

> **状态**: 参考文档 · 长期维护
> **同步日期**: 2026-08-30
> **上游**: [`deepseek-harness` 0.1.2-alpha.2](https://github.com/deepseek-ai/deepseek-harness) `packages/subagent/*`
> **本地路径参考**: `/Users/ethan/code/deepseek-harness/packages/subagent/`
> **同步落地**: [`docs/superpowers/plans/2026-08-30-zai-agent-tool-dsh-surface-sync-plan.md`](../superpowers/plans/2026-08-30-zai-agent-tool-dsh-surface-sync-plan.md)

本文档记录 deepseek-harness 0.1.2-alpha.2 中 subagent 子系统的架构与核心概念,作为 zai 同步工作的长期参考。

---

## 1. 总览

DSH subagent 在 0.1.2-alpha.2 重构为 **6 Provider × 3 Tool** 的完整能力栈,组织原则是 **三轴架构**:

| 轴 | 维度 | 极端 1 | 极端 2 |
|----|------|--------|--------|
| **进程边界** | in-process vs out-of-process | 同 cordis 上下文,复用 teardown | 独立进程/独立 session/独立 tools |
| **上下文继承** | 零父上下文 vs 完整继承 | fresh agent(看不到父对话) | seed completed-turn prefix(看到父已完成 turn) |
| **工具分层** | 入口/全局控制/child 上报 | per-provider tool 实例 | 与 provider 解耦的全局 send_message + interrupt_agent;child-scoped report |

三轴互相正交,可任意组合。

---

## 2. 三轴架构详解

### 2.1 进程边界

| Provider | 边界 | 性能 | 隔离性 | 跨语言 |
|----------|------|------|--------|--------|
| `spawn-in-process` | 同进程 | 最快(共享 cordis + teardown) | 最差 | ❌ |
| `fork-in-process` | 同进程 | 快(共享 cordis + session log) | 中 | ❌ |
| `subagent-acp` | 子进程(ACP 协议) | 慢(spawn) | 强(独立 session/model/tools) | ✅(任何 ACP runtime) |
| `subagent-dsh-sdk` | 子进程(stdio JSON-RPC) | 慢(IPC) | 强(独立完整 DSH runtime) | ✅ |
| `subagent-claude-code` | 子进程(`@anthropic-ai/claude-agent-sdk` spawn CLI) | 慢 | 强(外部 CLI) | ✅ |
| `subagent-codex` | 子进程(`codex app-server --stdio`) | 慢 | 强(外部 wrapper) | ✅ |

### 2.2 上下文继承(in-process 内)

| Provider | 父上下文 | 子 session | 子 system prompt |
|----------|---------|------------|-----------------|
| `spawn-in-process` | **零继承** | 全新 | 全新 |
| `fork-in-process` | **completed-turn prefix** seed | seed 父 session log,截至 `last turn:end` | 继承 |

源码注释(fork-in-process/src/index.ts):

> "The seed ends at the last `turn/end`: the current tool-call turn is unbalanced and cannot be replayed as a valid child session."

源码注释(spawn-in-process/src/index.ts):

> "runs each child as a fresh child Agent on the same cordis context (its own session, own system prompt, zero parent context). The cheapest transport."

### 2.3 工具分层

DSH 把 subagent 工具拆成三层,职责清晰:

| 工具 | 安装位置 | 与 provider 关系 | 关键职责 |
|------|---------|-----------------|---------|
| `tool-subagent` | per-provider 实例 | **绑定 provider** | model-facing 入口:`delegate(task, provider='spawn')`;3 种输出模式(foreground / background / continuable) |
| `tool-subagent-control` | **全局** | **与 provider 解耦** | `send_message` + `interrupt_agent`;所有 delegation 工具共享一个控制平面 |
| `tool-subagent-report` | **child-scoped** | 仅在 continuable in-process child | child 主动 `report` 给父;roots / one-shot / 远程 / 无 agent 执行看不到 |

源码注释(tool-subagent-control/src/index.ts):

> "live caller against the target's recorded lineage; the tool adds no authority of its own."

源码注释(tool-subagent-report/src/index.ts):

> "installed into every continuable in-process child's **unpublished context**. Roots, one-shot children, remote providers, and agentless executions **never see the registration**."

---

## 3. 6 Provider 详解

### 3.1 `subagent-spawn-in-process`

- **注册名**: `spawn`
- **`inheritsParentContext`**: `false`
- **`capabilities`**: `{ agentOptions, outputSchema, depthLimit, toolFilter, persona }` 全 true
- **`start()`**: 创建 fresh child Agent + 自己的 session + 自己的 system prompt
- **共享驱动**: `dsh-subagent-in-process-driver`(one-shot child 共享)

源码注释:

> "The cheapest transport, reusing the agent factory's quiescent teardown."

### 3.2 `subagent-fork-in-process`

- **注册名**: `fork`(默认)
- **`inheritsParentContext`**: `true`
- **`capabilities`**: 全 true
- **`start()`**: seed 父 session log(截至 last `turn/end`)+ 新 child Agent
- **`prepareContinuable()`**: 返回 `ContinuableCreateSpec.seed` = 同上 completed-turn prefix

源码注释:

> "child Agent SEEDED with a prefix of the parent's session log — so the child inherits the parent's conversation context instead of starting fresh."

### 3.3 `subagent-acp`

- **注册名**: `acp`
- **`inheritsParentContext`**: `false`(ACP 跨进程,看不到父 context)
- **`capabilities`**: `{ noStartCapabilities: true }` — 不支持 start-time features
- **协议**: [Agent Client Protocol](https://github.com/agentclientprotocol/agent-client-protocol),跨进程通信
- **`resolveCwd`**: 唯一读 `request.parent` 的字段(获取 session 的 workspace cwd)

源码注释:

> "Each child has its own process, session, model, and tools, so it shares no Cordis context and advertises no parent-enforced start capabilities."

### 3.4 `subagent-dsh-sdk`

- **注册名**: `subagent-dsh-sdk`
- **`inheritsParentContext`**: `false`
- **`capabilities`**: 只支持 `agentOptions` 子集(provider / model / reasoningEffort / maxTokens)
- **协议**: stdio JSON-RPC 驱动另一个完整 DSH runtime

源码注释:

> "Each child is a complete DeepSeek Harness runtime in its own process — own named profile and patch composition, session, model route, and tools."

### 3.5 `subagent-claude-code`

- **注册名**: `subagent-claude-code`(profile-named)
- **`inheritsParentContext`**: `false`
- **`capabilities`**: `{ noStartCapabilities: true }`
- **传输**: `@anthropic-ai/claude-agent-sdk` 调官方 Claude Agent SDK;SDK-spawned CLI 走共享 subprocess owner

源码注释:

> "Every accepted run invokes the official Agent SDK in the delegating Session's workspace and places the SDK-spawned real CLI under the shared subprocess owner."

### 3.6 `subagent-codex`

- **注册名**: `codex`(profile-named)
- **`inheritsParentContext`**: `false`
- **`capabilities`**: `{ noStartCapabilities: true }`
- **传输**: `codex app-server --stdio` 在 delegating Session 的 workspace 跑 fresh Codex wrapper

源码注释:

> "Every accepted run starts a fresh official package-local Codex wrapper with `app-server --stdio` in the delegating Session's workspace and publishes only after an ephemeral thread exists."

---

## 4. 3 Tool 详解

### 4.1 `tool-subagent` — 入口

**配置**(`packages/subagent/tool-subagent/src/index.ts:48-130`):

```ts
{
  provider: string,                    // 必填,ctx.subagents provider 名
  toolName?: string,                   // 默认 'subagent',每个实例唯一
  modelSelectionSettings?: boolean,    // 默认 false
  enableRunInBackground?: boolean,     // 默认 true
  backgroundMode?: 'one-shot' | 'continuable',  // 默认 'one-shot'
  agentOptions?: AgentOptions,         // 全 child 应用
  persona?: string,                    // per-child persona
  toolFilter?: { allow?: string[]; deny?: string[] },
  maxDepth?: number | 'provider-managed',  // 默认 3
}
```

**`providerWording`(inheritsParentContext 切换)**(`index.ts:251-276`):

```ts
// fork (inheritsParentContext: true):
description: 'Delegate a task to a subagent that inherits this conversation: a child agent seeded with all '
  + 'completed turns so far (it does not see the current in-flight turn). Use this when the subtask '
  + 'builds on this conversation\'s context — a follow-up analysis, a review, a continuation — without '
  + 'consuming this conversation\'s context for the work itself. You receive its result, not its intermediate steps.'
promptDescription: 'The task for the subagent. It already sees this conversation\'s completed turns, '
  + 'so build on them freely and state only what is new.'

// spawn (inheritsParentContext: false):
description: 'Delegate a self-contained task to a subagent (a separate agent that works in its own context) '
  + 'to offload focused, independent work — research, a scoped implementation, an analysis — so it does not '
  + 'consume this conversation\'s context. The subagent returns its result, not its intermediate steps.'
promptDescription: 'The complete, self-contained task for the subagent. It does not share this '
  + 'conversation\'s context, so include everything it needs.'
```

**3 种输出模式**(`index.ts:423-461`):

```ts
discriminatedUnion([
  { kind: 'foreground', runId, output: ContentBlock[] },
  { kind: 'background',  jobId },          // one-shot + jobs seam
  { kind: 'continuable', subagentId },     // continuable, startContinuable 返回
])
```

**Mount 时 capability 校验**(`index.ts:322-344`):

```ts
if (typeof config.maxDepth === 'number' && !provider.capabilities.depthLimit)
  throw new Error('provider "..." cannot enforce maxDepth (no depthLimit capability)')
if (config.agentOptions && !provider.capabilities.agentOptions)
  throw new Error('provider "..." does not support child agentOptions')
if (modelSelectionCapable && !provider.capabilities.agentOptions)
  throw new Error('provider "..." does not support child model selection')
if (continuable && provider.prepareContinuable === undefined)
  throw new Error('provider "..." does not support `backgroundMode: continuable`')
```

### 4.2 `tool-subagent-control` — 全局 send_message + interrupt_agent

源码: `packages/subagent/tool-subagent-control/src/index.ts`

**send_message**(`index.ts:27-78`):

```ts
const messageId = await ctx.subagents.followup(
  parent,                                          // exec.agent
  brandString<SessionId>(args.subagent_id),
  [{ type: 'text', text: args.message }],
  {
    source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id },
    signal: exec.signal,
  },
)
```

> "Send a message to a background subagent by its subagent id, continuing the same conversation. It becomes the subagent's next turn: if it is still working, the message waits until its current turn finishes, so it cannot redirect work already underway. This call returns no answer from the subagent — only confirmation that the message was delivered — so use it to give it more work. A failure means the message was NOT delivered."

**interrupt_agent**(`index.ts:80-119`):

```ts
ctx.subagents.interrupt(
  brandString<SessionId>(args.agent_id),
  { kind: 'ancestor', agent: caller },  // authority check
)
```

> "Request cancellation of a background agent's current turn by its agent id. The target may be your direct child or a deeper agent created under you. Only the current turn stops: messages already queued for the agent stay parked until a later send_message, agents it started keep running, and the agent itself stays available for follow-ups."

**Authority 校验语义**(在 `SubagentContinuationManager.interrupt` 层):

```ts
if (authority.kind === 'ancestor') {
  if (this.ctx.agents.get(caller.id) !== caller)
    throw SubagentError('interrupting "..." requires the exact live ancestor agent', 'UNAUTHORIZED')
  if (caller.id === targetSessionId)
    throw SubagentError('agent "..." cannot interrupt itself', 'UNAUTHORIZED')
}
if (!activation.ancestry.has(authority.agent))
  throw SubagentError('subagent "..." is not a live descendant of agent "..."', 'UNAUTHORIZED')
```

### 4.3 `tool-subagent-report` — child-scoped report

源码: `packages/subagent/tool-subagent-report/src/index.ts`

**install 机制**(`index.ts:134-140`):

```ts
ctx.subagents.registerContinuableSetup(childCtx =>
  installReportTool(childCtx, ctx, reportDelivery))
```

**delivery policy**(`index.ts:25-37`):

```ts
reportDelivery?: 'quiet' | 'next-step'
// 'next-step'(默认):唤醒父 agent,enter at nearest step boundary
// 'quiet':不唤醒,只把 context 加入父的下一次输入(等待另一次 waking input)
```

**report 工具描述**(`index.ts:65-71`):

> "Report selected content to the agent that started you. Call this once before you finish, with a self-contained final result, and earlier for progress or findings that change what that agent does next. That agent shares your workspace but does not automatically receive your transcript, tool output, or reasoning, so finishing your work is not itself a result. Reporting does not end your turn or finish your work, and only your direct parent receives it. A failed call may still have arrived, so do not blindly repeat it."

**attribution**(`continuation.ts:659-723`):

```ts
const message = createUserMessage({
  content: [
    { type: 'text', text: `Background subagent ${activation.childId} reported:` },
    ...content,
  ],
  source: {
    kind: 'subagent-report' as const,
    form: 'relay' as const,
    senderSessionId: activation.childId,
  },
})
if (delivery === 'next-step') {
  this.sendWaking(parent, message, () => { this.sendReport(parent, message, delivery) })
} else {
  this.sendReport(parent, message, delivery)
}
```

---

## 5. Service Definition 核心接口

源码: `packages/subagent/subagent/src/types.ts`

### 5.1 `SubagentProvider`(types.ts:300-346)

```ts
interface SubagentProvider {
  readonly name: string                                    // 注册名
  readonly capabilities: SubagentCapabilities              // 5 flags
  readonly inheritsParentContext: boolean                  // providerWording 用
  readonly agentRouteDefaults?: Readonly<{ provider: string; model: string }>

  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>

  prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>
  // Method presence IS the capability(continuable 子创建)
}
```

### 5.2 `SubagentCapabilities`(types.ts:86-92)

```ts
interface SubagentCapabilities {
  readonly agentOptions: boolean    // 子 agentOptions(provider/model/reasoningEffort/maxTokens)
  readonly outputSchema: boolean    // 子 outputSchema(structured output)
  readonly depthLimit: boolean      // 子 maxDepth(递归深度上限)
  readonly toolFilter: boolean      // 子 toolFilter(允许/禁止工具)
  readonly persona: boolean         // 子 persona(per-child persona)
}
```

### 5.3 `SubagentStartRequest`(types.ts:101-157)

```ts
interface SubagentStartRequest {
  readonly label?: string
  readonly prompt: ContentBlock[]
  readonly parent: Agent                          // spawning agent
  readonly signal: AbortSignal
  readonly agentOptions?: AgentOptions            // 需 capabilities.agentOptions
  readonly outputSchema?: ObjectJsonSchema        // 需 capabilities.outputSchema
  readonly maxDepth?: number                      // 需 capabilities.depthLimit
  readonly toolFilter?: ToolRestriction           // 需 capabilities.toolFilter
  readonly persona?: string                       // 需 capabilities.persona
}
```

### 5.4 `SubagentResult`(types.ts:208-253)

```ts
interface SubagentResult {
  readonly output: ContentBlock[]                 // 最后 non-empty assistant message 内容
  readonly structured?: unknown                   // outputSchema 满足时的结构化值
  readonly diagnostic?: string                    // provider-authored failure detail(≤4096 bytes)
  readonly stopReason: SubagentStopReason         // merge-extensible
}

type SubagentStopReason =
  | 'completed' | 'aborted' | 'error'
  | 'max-tokens' | 'refusal'
// merge-extensible:backend 可加新变体
```

### 5.5 `SubagentRun`(types.ts:264-290)

```ts
interface SubagentRun {
  readonly id: SessionId                                    // parent-scoped run id
  readonly localAgent: Agent | undefined                    // published in-process child,或 undefined(remote)
  readonly result: Promise<SubagentResult>                  // 终态
  dispose(): Promise<void>                                  // 幂等取消 + 释放
}
```

---

## 6. continuation manager(continuable lifecycle)

源码: `packages/subagent/subagent/src/continuation.ts`

**核心数据结构**(`continuation.ts:198-247`):

```ts
interface Activation {
  readonly childId: SessionId
  readonly parentSession: SessionId                  // durable,用于 settlement delivery
  readonly provider: string                         // 记录到 durable descriptor
  readonly handle: AgentHandle                      // 唯一 lifecycle owner
  readonly ancestry: WeakSet<Agent>                 // 精确 live 祖先
  readonly ownedChildren: Set<SessionId>            // 子 childs(blocks settlement)
  readonly observer: ActivationObserver
  disposal: Promise<void> | undefined               // memoized(presence IS admission cutoff)
  readonly accepted: Set<MessageId>                 // admitted waking message ids(防 race)
  announced: boolean                                // 是否曾 delivered
  poke: PromiseWithResolvers<void>                  // 唤醒 settlement watcher
}
```

**`ActivationState`**(`continuation.ts:166,936-940`):

```ts
type ActivationState = 'running' | 'waiting' | 'settled'

private stateOf(activation: Activation): ActivationState {
  if (activation.handle.agent.status === 'running' || activation.accepted.size > 0) return 'running'
  if (activation.ownedChildren.size > 0) return 'waiting'
  return 'settled'
}
```

**核心方法**:

| 方法 | 职责 |
|------|------|
| `startContinuable(spec)` | 保留 childId → 调 `prepareContinuable` 拿 seed → materialize Agent → 提交初始 prompt |
| `followup(parent, childId, content, options)` | routing by residency:`running` 直接 enqueue,`waiting` wake,absent → cold resume |
| `interrupt(targetId, authority)` | 同步 admission,async effect(`Agent.cancel(cause, {keepInbox:true})`);authority check 严格 |
| `reportFrom(child, content, options)` | sender authorization + parent resolution + delivery(next-step → steer / quiet → inject) |
| `coldResume(parent, childId, content, options)` | 从持久化 Session 重建(`query.observeSession` → `agents.resume`) |
| `drain()` | manager 全关闭(materialization quiescence → dispose forest child-first) |
| `drainDescendants(parents)` | scoped 关闭:只关闭指定 root 的 descendants |
| `drainChildren(parent, childIds)` | 选择性关闭:只释放指定 parent 的特定 direct children |

**drain 关键代码**(`continuation.ts:734-748`):

```ts
async drain(): Promise<void> {
  this.draining = true                                       // 同步关闭 admission
  await Promise.all([...this.materializations].map(m => m.settled))  // 等所有 materialization
  const owned = new Set<SessionId>()
  for (const a of this.activations.values())
    for (const c of a.ownedChildren) owned.add(c)
  const roots = [...this.activations.values()].filter(a => !owned.has(a.childId))
  await this.disposeRoots(roots, 'activation(s)')
}
```

**Settlement delivery**(`continuation.ts:1473-1522`):

```ts
private notifySettlement(activation: Activation, terminal: ActivationTerminal): void {
  if (!activation.announced) return                         // 没 announced 不通知
  const parent = this.ctx.agents.get(activation.parentSession)
  if (parent === undefined) return
  const message = createUserMessage({ content: [...summary, ...output], source: {...} })
  if (this.closingTeardownFor(parent) !== undefined) {
    parent.inject(message)                                  // 关闭中父用 inject(不唤醒)
    return
  }
  this.sendWaking(parent, message, () => {
    if (parent.status === 'idle') parent.followup(message)  // 空闲父:一 ordinary turn
    else parent.steer(message)                              // 忙碌父:steer(批处理)
  })
}
```

---

## 7. Message Source Kinds

源码: `packages/subagent/subagent/src/continuation.ts:93-99`

```ts
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    coordinator: CoordinatorMessageSource              // tool-subagent-control send_message
    'subagent-report': SubagentReportMessageSource     // tool-subagent-report child → parent
    'subagent-settled': SubagentSettledMessageSource   // continuation manager 通知 settlement
  }
}
```

| Kind | Form | 用途 | Sender |
|------|------|------|--------|
| `coordinator` | `relay` | 模型协调器 send_message 投递 | coordinator agent session |
| `subagent-report` | `relay` | child 主动 report 给父 | reporting child session |
| `subagent-settled` | `notice` | continuation manager 通知 settlement | settled child session |

---

## 8. SubagentError 类型(7 种)

源码: `packages/subagent/subagent/src/{error.ts, control-types.ts}`

```ts
class SubagentError extends Error {
  constructor(message, code, options?)  // code: 见下表
}
```

| Code | 来源 | 触发场景 |
|------|------|----------|
| `DUPLICATE_CHILD` | continuation.ts | childId 已存在 |
| `UNAUTHORIZED` | continuation.ts | ancestor 不在 lineage / stale Agent / self-targeting |
| `PARENT_UNAVAILABLE` | continuation.ts | reportFrom 找不到直接父 |
| `ACTIVATION_CLOSING` | continuation.ts | parent / child 正在 disposal |
| `DRAINING` | continuation.ts | manager drain 中或 scope drain 中 |
| `NOT_RESUMABLE` | continuation.ts | cold resume 找不到 persisted child / descriptor 无效 |
| `PERSISTENCE_UNAVAILABLE` | continuation.ts | continuable child 需 session persistence 但未挂载 |
| `CONTINUATION_UNAVAILABLE` | continuation.ts | continuable child 需 session query 但未挂载 |
| `ACTIVATION_TEARDOWN_FAILED` | continuation.ts | drain dispose 失败(aggregate) |

**Remote error codes**(protocol 层,`control-types.ts:143-163`):

```ts
interface RemoteErrorDetailsMap {
  'subagent/invalid-time-zone': { value: string }
  'subagent/parent-unavailable': { parentSessionId: SessionId }
  'subagent/not-resumable': { childSessionId: SessionId }
  'subagent/unauthorized': { childSessionId: SessionId }
  'subagent/attachment-unsupported': { childSessionId: SessionId; reason: string }
  'subagent/delivery-unavailable': { childSessionId: SessionId }
  'subagent/projections-unavailable': {}
}
```

---

## 9. SubagentListEntry(浏览器 catalog)

源码: `packages/subagent/subagent/src/control-types.ts:34-79`

```ts
type SubagentListEntry =
  | {
      kind: 'child'
      id: SessionId
      activity: 'running' | 'inactive'                     // live / 仅持久化
      hasChildren: boolean                                 // 是否有直接 descendant(子 subagent)
    } & (
      | { mode: 'one-shot'; label?: string }                // 一次性
      | { mode: 'continuable'; label: string }              // 可续接
    )
  | {
      kind: 'diagnostic'
      id: SessionId
      reason: 'corrupt' | 'unsupported' | 'unavailable'    // 数据损坏 / 不支持 / 暂时不可读
    }
```

---

## 10. capability seam 与 AGENTS.md 关系

源码: `packages/AGENTS.md` + `packages/subagent/AGENTS.md` 引用 upstream `AGENTS.md` 第 110 条:

> "A capability seam comprises Service Definition / Service Provider / Consumer roles. It is complete, never one role; split only when roles evolve independently."

**DSH subagent 完整三角色**:

```
Service Definition  → @deepseek-ai/dsh-subagent            (ctx.subagents 接口 + 校验)
Service Provider    → 6 个 provider(上表)                  (实现)
Service Consumer    → 3 个工具(上表)                       (调用)
```

每个角色独立包,独立演化。

---

## 11. 与 zai 同步的边界

详细实施计划见 [`docs/superpowers/plans/2026-08-30-zai-agent-tool-dsh-surface-sync-plan.md`](../superpowers/plans/2026-08-30-zai-agent-tool-dsh-surface-sync-plan.md)。

**本次同步(model-facing surface,4 phases / 5 PRs / 2-3 weeks)**:

| 工具 | 同步内容 |
|------|---------|
| `tool-subagent` | description 跟随 inheritsParentContext + backgroundMode 切换;3 种输出 discriminatedUnion |
| `tool-subagent-control` | send_message + interrupt_agent description 文案对齐;补 attribution / authority check |
| `tool-subagent-report` | delivery 命名 'next-step' 作为 'wakeup' 别名;attribution 对齐 'subagent-report' |

**本次不同步(独立工作)**:

| 项 | 原因 |
|----|------|
| `SubagentProvider` interface 升级(5 flags → placeholder) | 占位 `{ noStartCapabilities: boolean }` 维持,影响范围太大 |
| provider 实现(claude-code / codex / spawn / fork / acp / dsh-sdk) | zai 已有 claude-code / codex / fork(Stage 4),其余按需独立 PR |
| kernel swap(`kernel.getSeam('subagent')`) | 已有架构不动,dsh kernel 接入是独立工作 |
| continuation manager 内部实现 | 不重构;只消费其 model-facing 接口 |
| vendor `AgentTool.tsx` 直接 patch | 不动 vendor,用 `wrapAsOpenccTool` 模式包装 |

---

## 12. 关键引用

### 12.1 上游源码路径(local)

```
packages/subagent/
  subagent/src/
    index.ts                      (Service Definition 入口)
    types.ts                      (SubagentProvider, SubagentStartRequest, SubagentResult, SubagentRun)
    control-types.ts              (SubagentCatalog, SubagentPromptRequest, RemoteErrorDetailsMap)
    continuation.ts               (SubagentContinuationManager:startContinuable/followup/interrupt/reportFrom/coldResume/drain)
    lifecycle.ts                  (ActivationObserver, ActivationTerminal)
    error.ts                      (SubagentError)
    projection.ts, projection-types.ts  (subagent projection system)
    depth.ts, descriptor.ts       (depth 解析 + descriptor 持久化)
    list-children.ts              (catalog 列出)
  subagent-spawn-in-process/src/  (provider)
  subagent-fork-in-process/src/   (provider)
  subagent-acp/src/               (provider)
  subagent-dsh-sdk/src/           (provider)
  subagent-claude-code/src/       (provider)
  subagent-codex/src/             (provider)
  subagent-in-process-driver/src/ (fork/spawn 共享 driver)
  tool-subagent/src/              (入口 consumer)
  tool-subagent-control/src/      (全局控制 consumer)
  tool-subagent-report/src/       (child-scoped 上报 consumer)
```

### 12.2 上游 spec / plan / note

```
.agents/notes/implemented/architecture/2026-07-15-agent-initiator-scope.md
.agents/notes/implemented/architecture/2026-06-13-capability-seams.md
docs/architecture.md(subagent capability seam 段)
docs/glossary.md#capability-seam
docs/testing.md(subagent 相关测试策略)
```

### 12.3 zai 同步路径(local)

```
docs/superpowers/plans/2026-08-30-zai-agent-tool-dsh-surface-sync-plan.md   (本次 sync plan)
docs/superpowers/specs/2026-08-21-zai-subagent-claude-code-provider-design.md (已实现)
docs/superpowers/specs/2026-08-21-zai-subagent-codex-provider-design.md     (已实现)
docs/superpowers/plans/2026-08-17-dsh-kernel-batch-05-subagent-plugins.md    (双轨改造背景)
```

---

<!--
maintained-by: opencc-web agent workstream
scope: deepseek-harness 0.1.2-alpha.2 subagent subsystem
version: 2026-08-30
next-sync: 跟 deepseek-harness 上游 release 同步更新
-->
