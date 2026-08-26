# Spec — zai runtime: 以 print.ts 骨架服务化到 SSE/Web

**Status**: draft (协议层已冒烟验证,实现待启动)
**Implements**: 取代既有 `createOpenccRuntime` 头less bridge 的 zai server 主会话运行时方案
**Code (current)**: `packages/zai/src/server/services/agentRuntime.ts`、`packages/zn-agent-core/src/opencc-src/server/createOpenccRuntime-impl.ts`
**Code (proposed)**: `packages/zai/src/server/services/sessionHost/`(新增)
**Companion plan**: `docs/superpowers/plans/2026-08-24-zai-runtime-printts-bridge-plan.md`

## Problem

zai 的 server-side 主会话运行时基于 `createOpenccRuntime`(`opencc-src/server/createOpenccRuntime-impl.ts`,headless bridge,interative 模式)—— 把 `runtime.query()` 直接调 vendor `QueryEngine.submitMessage`,绕过 vendor REPL/print.ts 的 turn-loop 转轮。

这条路径已在多个维度与 vendor 自己的 REPL/print.ts 分叉:

| 能力 | 期望 | 现状 |
|---|---|---|
| 跨调用状态保持 | 同会话跨多轮 query 共享 mutableMessages | 已有(per-session engine),但需大量 zai-patch |
| 跨进程 resume | 服务重启后 hydrate 完整会话 | 已有(`sessionFacade.readTranscript` + JSONL 反序列化),patch 集中在 `createOpenccRuntime-impl.ts:577-628` |
| 定时任务 / cron | LLM 创建 cron 后到点自动 fire 注入对话 | **缺失** —— CronCreateTool 调用成功但没有任何调度执行器(参见会话 `sess-1787563477242-mte0mfme` 实证:2026-08-24 17:30 创建两条 `durable:false` cron,17:32 预期触发但会话文件止于 17:30:18,后续 0 条消息) |
| AppState 全局状态 | 与 vendor REPL 语义对齐(permission mode、model、mainLoopModel、toolPermissionContext、settings 联动) | patch 后部分对齐,但 `interactive:true` + `isSdk` 双模式造成不一致 |
| commandQueue / 多轮 drain | 用户输入/cron 后台通知/permission 响应统一按 priority drain | 缺失 —— `runtime.query()` 直发不经过 `commandQueue` |
| vendor SDK 协议升级跟踪 | `stream-json`/`control_request`/`tool_use:*_pending` 自动跟随 vendor 演进 | 当前由 zai 自己做 `translateRuntimeEvents`,每次 vendor 升级都要同步适配 |
| `interactive:false` 半成品 | `zai dev --sdk` 期望 SDK/headless 模式 | 仅把 vendor 内 `STATE.isInteractive = false`,既不 spawn 进程也不挂 SDK host |

根本矛盾:zai 在 vendor 既有 **React REPL** 与 **CLI headless (`print.ts`)** 两条"turn-loop 转轮"之外,造了第三条 `createOpenccRuntime`,承担它本身不需要承担的 turn-loop 职责。

## Decision

**把 zai 的主会话 turn-loop 委托给 vendor 的 print.ts 骨架,通过 spawn `opencc -p --sdk` 子进程 + stdio NDJSON + control_request,实现常驻 SSE/Web 宿主。** 子进程是 vendor CLI 的标准常驻形态,天然支持多轮 stdin、resume、cron scheduler、permission 流;zai server 退化为"SDK 宿主"——维护进程生命周期、翻译 SDK 事件到前端 SSE 词汇、桥接 UI 决策回子进程。

**核心契约 —— 显式开关切换、双轨运行**:迁移不是替换,是叠加。zai 在 `initAgentRuntime()` 时读取 `ZAI_OPENCC_CLI`(env 或 `~/.zai/settings.json`)选项,**默认 false(走现有 `createOpenccRuntime` 路径)**,true 时才挂 `SessionRegistry` + `RuntimeAdapter`。阶段 0-4 双轨共存,阶段 5 才把默认值翻成 true 并删旧路径。详细开关契约见 §5.6。

### 决策依据

1. **vendor 已是常驻**:print.ts 的 `runHeadlessStreaming` 在 stdin EOF 或 `end_session` control_request 之前循环不退,原生支持多轮。
2. **协议稳定**:`output-format=stream-json --verbose --include-partial-messages` 已在 vendor SDK/CCR 上线使用,跟单 vendor SDK/CCR 一样用,不引入新协议。
3. **同进程多会话隔离自动成立**:每个子进程持有自己的 `STATE.sessionId`、GrowthBook 缓存、cron scheduler、permission registry,`createOpenccRuntime` 的同进程隔离问题(全局 STATE)不复存在。
4. **复用现成 patch**:zai 已有的 `__zaiBridgeCtx` / `__zaiEventBus` / `askRegistry` / `permissionRegistry` 桥接层不变,职责仅从"in-process 桥"迁移到"跨进程协议桥"。
5. **B1 vs B1' 选 B1**:B1'("把 print.ts 改成同进程可常驻库")需要剥离 vendor 进程级单例(GrowthBook、Sandbox、proactive、STATE.sessionId),与 vendor 分叉,风险大、跟踪升级困难,作为**长期收敛目标**而非短期路径。

### 不在范围

- 替换 `createOpenccRuntime` 之外的所有 zai 子系统(PluginRuntime、SessionInbox、eventBus、Transcription、WeixinBot、BashNotifier)—— 这些与 turn-loop 解耦,继续常驻 zai 进程。
- 把 `--print` 改为完整 REPL 模式 —— B1 目标是 SDK host,不是终端 REPL。
- Vendor SDK 协议自身改造 —— 完全采用 vendor 现成 `stream-json` + `control_request`,不发明新协议。
- 写 SDK 客户端库 —— zai server 内部消费 stream-json,不发布 npm 包。

## 架构

```
┌──────────────────────────────────────────────────────────────────┐
│ 浏览器  │  EventSource(?sid=xxx) ─── POST /api/agent/{query|ask|...} ──┐
└──────────────────────────────────────────────────────────────────┘ │
┌─────────────────────────────▼──────────────────────────────────┐
│ zai server (Express) │
│                                                                  │
│ SessionRegistry ←→  SessionHost (per sid)                         │
│                        ├─ childProcess  spawn `opencc -p --sdk` │
│                        ├─ stdout NDJSON parser  → SSE forwarder │
│                        ├─ stdin JSONL writer ← API requests     │
│                        ├─ control_request in-flight map         │
│                        └─ lifecycle: spawn / healthcheck / kill │
│                                                                  │
│ eventBus ←  SessionHost.* (SSE → frontend spec)                 │
│ sessionFacade ←  vendor CLI 落盘 JSONL (复用 + 加缓存)         │
│ PluginRuntime / SessionInbox / BashNotifier / WeixinBot (不变)  │
└──────────────────────────────────────────────────────────────────┘ │
                          │ stdio NDJSON + control_request          │
                          ▼                                          │
┌──────────────────────────────────────────────────────────────────┐
│ opencc 子进程 (opencc -p --sdk --cwd <cwd> ...)                 │
│ runHeadless → commandQueue / handlePromptSubmit / cronScheduler│
│              → resume/loadInitialMessages                       │
│              → structuredIO.write(stream-json) → stdout         │
└──────────────────────────────────────────────────────────────────┘
```

## Protocol (vendor stream-json,已现场验证)

### 5.1 stdout NDJSON(子进程 → zai)

`opencc -p --output-format=stream-json --verbose --include-partial-messages --bare --no-session-persistence`

**现场协议(NDJSON 行类型,2026-08-24 实测,2 个 turn):**

```
{"type":"system","subtype":"init","cwd":"...","session_id":"...","tools":["Bash","Edit","Read"],
 "mcp_servers":[],"model":"MiniMax-M3","permissionMode":"bypassPermissions",
 "slash_commands":[...],"agents":[...],"skills":[...],"plugins":[{...}], ...}
{"type":"stream_event","event":{"type":"message_start","message":{...},"session_id":"..."}, ...}
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}, ...}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"..."}}, ...}
{"type":"stream_event","event":{"type":"content_block_delta","index":N,"delta":{"type":"text_delta","text":"A"}}, ...}
{"type":"stream_event","event":{"type":"content_block_stop","index":0}, ...}
{"type":"stream_event","event":{"type":"message_stop"}, ...}
{"type":"result","subtype":"success","is_error":false,"duration_ms":N,"num_turns":1,
 "result":"A","session_id":"...","total_cost_usd":0.013,"usage":{...}}
{"type":"stream_event",...}  // turn 2
{"type":"result","subtype":"success","is_error":false,...}  // turn 2
```

事件 type 分布(实测,64 行覆盖两 turn):`stream_event` 53、`content_block_delta` 34、`thinking_delta` 23、`text_delta` 9、`message` 8、`message_start/stop/delta` 各 3、`content_block_start/stop` 5/5、`assistant` 5、`result` 2、`user`(replay) 2、`system` 2、`signature_delta` 2。

### 5.2 stdout → zai ServerEvent 映射(由 zai `translateRuntimeEvents` 承接)

vendor SDK 事件词汇已是 `translateRuntimeEvents`(zai 现有 `routes/agent.ts:265`)的输入域,**直接复用,无需改动**:

| stdout NDJSON | zai SSE ServerEvent |
|---|---|
| `system.subtype='init'` | `session.projection`(tools/skills/agents 快照) |
| `stream_event.content_block_delta.delta.type='text_delta'` | `runtime.delta` |
| `stream_event.content_block_delta.delta.type='thinking_delta'` | `runtime.thinking` |
| `stream_event.content_block_start{type:'tool_use'}` + 后续 `input` | `runtime.tool_call` |
| `stream_event.content_block_stop` (tool) | (内部,无 emit) |
| `assistant.message.content[tool_use]` + 后续 `tool_result` | `runtime.tool_call` / `runtime.tool_result` |
| `stream_event.message_delta` | (累积 usage,内部) |
| `stream_event.message_stop` | `runtime.done` / `compaction.completed` → `runtime.compacted` |
| `result.subtype='success'` | turn 终结,前端 reducer 处理 |
| `tool_use:ask_pending` / `permission_pending` / `approve_pending` | zai 桥接层 → `prompt.ask` / `prompt.permission` / `prompt.approve` |

### 5.3 stdin JSONL(zai → 子进程)

```jsonl
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<prompt>"}]}}
{"type":"control_response","response":{"request_id":"r-1","response":{"behavior":"allow","updatedInput":{...}}}}
{"type":"control_request","request_id":"r-2","request":{"subtype":"interrupt"}}
```

`control_request` ↔ `control_response` 的 reqId 关联由 zai `SessionHost.controlRequest` 注册表维护,请求未 resolve 之前不写后续 control。

### 5.3.1 Interrupt 与 Insert 的协议语义(已现场核对 print.ts:2982-4028 control_request subtype 表)

vendor SDK control_request 的合法 subtype **不含**任何"中途插队"型协议(无 `inject_user_message` / `steer` / `prepend_user_message` 等)。所有 user 消息只能通过 stdin `{"type":"user","message":...}` 投递,由 vendor 内部 `commandQueue` 在 turn 边界自动 drain(vendor 在 idle 时立刻 drain,busy 时排队等当前 turn 结束)。

三种"插入"场景的实际走法:

| 场景 | 协议路径 | 说明 |
|---|---|---|
| 当前 turn 结束后立刻派新 turn | 写 stdin `{"type":"user",...}`,子进程 enqueue | 等价 zai `sessionInbox.followup`(idle 时) / `steer`(busy 时) |
| 中途打断当前 turn 并立刻派新 turn | zai SessionHost orchestrate 两步:control_request `interrupt` → 等子进程 emit 终结 `result`(is_error) → 写 stdin user message | vendor 没有原子化协议;zai 必须自己编排 |
| 纯通知 inject(不打断、不唤醒下一 turn) | 写 stdin user message,但 zai SessionHost 不触发 wake handler | 由 zai 控制,子进程仍按 idle 立即 drain |

zai sessionInbox lane 与 SDK 协议映射(对齐现有 `services/sessionInbox.ts:49-66`):

| zai 抽象 | vendor 协议 |
|---|---|
| `followup(sid, msg)` | stdin user message;zai wakeHandler 触发 drain |
| `steer(sid, msg)` | stdin user message(vendor 自动 enqueue);zai wakeHandler 触发 drain |
| `inject(sid, msg)` | stdin user message;zai **不**触发 wakeHandler,等下一次 turn 自然 drain |
| `abort(sid, reason)` | control_request `{subtype: 'interrupt'}` |
| (新增)`steerAndRestart(sid, prompt)` | interrupt + 等 result + enqueue user message(zai SessionHost orchestrate) |

zai `SessionHost.steerAndRestart(sid, newPrompt)` 必须实现的状态机:

```ts
async steerAndRestart(sid: string, newPrompt: string): Promise<void> {
  const host = SessionRegistry.get(sid)!
  await host.sendControlRequest({subtype: 'interrupt'})   // 1) 子进程 abort 当前 turn
  await host.waitForResultTerminal()                    // 2) 等 result 行(is_error:true 表示 abort 成功)
  await host.sendUserMessage(newPrompt)                  // 3) 投递新 prompt
  await host.run()                                       // 5) (可选)kick 子进程 drain
}
```

注意:`interrupt` 之后 vendor 内部 `commandQueue` 仍持有之前未消费的 user message(如果有),新 enqueue 的 message 会排在它们后面 —— 若要"只跑新 prompt"必须先清空。zai SessionHost 应暴露 `purgeQueue()` 等价物(子进程目前没有该协议;实现方式是:zai 侧记一个"steer checkpoint",子进程回完 result 后丢弃该 checkpoint 之前的所有 enqueue)。

**实施阶段 1 需明确**:zai 现有 `runtime.abort(sessionId, reason)` 的契约是否"中断 + 清队列"语义;若 zai 历史语义是"中断但保留队列",B1 子进程行为对齐即可。

### 5.4 子进程 spawn 参数(推荐 baseline)

```
opencc -p \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --replay-user-messages \
  --bare \
  --no-session-persistence \
  --dangerously-skip-permissions \
  --cwd <cwd> \
  [--resume <sid>] \
  [--model <zai-default-sonnet>]
```

`--bare` 跳过 hooks / LSP / CLAUDE.md / keychain / 持久化(减少握手 1.6s)。 `--no-session-persistence` 由 zai 自己负责 JSONL 落盘(`sessionFacade`)。 `--dangerously-skip-permissions` 由 zai 在 control_request 路径上重新实施具体 permission 决策(不是全局放权)。

> 注:实测中 `--bare` 仍会读 `.claude/plugins/cache/zn-plugins-market/...`(superpowers 等)。这与 zai 的 `.zai/plugins/cache/` 是两套元数据。zai 子进程会"继承"用户全局插件 —— 这与 zai 当前的 `DefaultPluginRuntime` 双轨共存,实施阶段决定是否保留。

### 5.5 会话进程生命周期与 Permission / Interaction 跨进程协议

#### 5.5.1 进程生命周期表

spawn 是**会话级**(per `sessionId`),不是请求级。一个 `SessionHost(sid)` spawn 后长驻,通过 stdin/stdout 持续对话,只在以下场景进入 kill/replace 流程:

| 触发场景 | spawn 新进程? | 理由 |
|---|---|---|
| 用户发一条 prompt | ❌ 不 spawn | 已长驻 `SessionHost(sid)` 写 stdin user message |
| 中断当前 turn(ESC / Abort 按钮) | ❌ 不 spawn | `control_request {subtype:'interrupt'}` → 子进程内部 `abortController.abort()`(`print.ts:1177`、`2009`),进程仍在 |
| 用户在 AskUserQuestion 弹窗里回答 | ❌ 不 spawn | `control_response {behavior:'allow', updatedInput:{...answers}}` → 子进程 resolve tool 继续 turn |
| `permissionMode` 切换 / `model` 切换 / cwd 切换 | ✅ kill 旧 host + spawn 新 host | 子进程的 permissionMode / mainLoopModel / getProjectRoot 都是 bootstrap 时一次性写入,运行期不可变 |
| **新会话**(前端 POST 创建新 sid) | ✅ spawn 新 host | per-sid 独立 STATE、cron scheduler、permission registry |
| **会话恢复**(刷新、断网重连、旧 host 已 LRU 淘汰) | ✅ spawn 新 host + `--resume <sid>` | vendor `loadInitialMessages`(`print.ts:5044`)从 JSONL 反序列化,hydrate 完整对话历史 |
| **子进程崩溃 / OOM kill / panic** | ✅ spawn 新 host + `--resume <sid>` | 错误恢复路径,前端短暂 toast 提示 |
| **zai server 关闭 / `runtime.shutdown()`** | ✅ killAll | SIGTERM/SIGINT handler 调 `SessionRegistry.killAll()`(`agentRuntime.ts:461`) |

zai `SessionRegistry` 接口:

```ts
class SessionRegistry {
  private hosts = new Map<string, SessionHost>()
  getOrSpawn(sid: string, opts: {cwd: string, resume: boolean}): SessionHost
  get(sid: string): SessionHost | undefined
  kill(sid: string, reason?: string): void  //  不抛异常,幂幂
  killAll(reason?: string): Promise<void>
  healthcheck(): Promise<Map<string, 'healthy' | 'stalled' | 'dead'>>
  lruEvictIdle(idleMs: number): void  //  阶段 4 健康/LRU
}
```

#### 5.5.2 AskUserQuestion / permission 跨进程协议

vendor 通用 permission 流(任何需要用户决策的 tool 都走它;AskUserQuestion 是其中之一)。完整协议路径 10 步:

```
1. LLM 在 turn 中调用 AskUserQuestion tool(或其他需 permission 的 tool)
2. vendor 内部 tool 走到 permission 检查点(permissionMode != bypassPermissions)
3. vendor emit 一条 control_request 到 stdout:
   {"type":"control_request",
    "request_id":"r-17",
    "request":{"subtype":"can_use_tool",
               "tool_name":"AskUserQuestion",
               "input":{"questions":[...]}}}
4. zai SessionHost.controlRequest 收到,登记 reqId=r-17 + 持有 stdout emitter
5. SessionHost 调 bridgeToolYield.ts 把 control_request 转 zai `prompt.ask` SSE
   → 前端 reducer 弹 AskUserQuestion 弹窗(现有 useAskQuestion hook 不变)
6. 用户在 UI 回答
7. 前端 POST /api/agent/ask-response {toolUseId, answers}
8. zai askRegistry.resolve(toolUseId, answers) → SessionHost.controlRequest.get(r-17).resolve(answerPayload)
9. SessionHost 写 stdin control_response:
   {"type":"control_response",
    "response":{"request_id":"r-17",
                "response":{"behavior":"allow",
                            "updatedInput":{...input, ...用户回答的 answers 字段}}}}
10. 子进程 resolve tool,继续 turn,产出后续 assistant / result 流
```

`permission`(Bash / Write / Edit 等)走完全相同的协议路径,**只有 5/7/9 三个字段不同**:

| 通道 | control_request 字段 | SSE 事件 | HTTP 路由 | control_response `response` 形态 |
|---|---|---|---|---|
| AskUserQuestion | `tool_name:'AskUserQuestion'` | `prompt.ask` | `POST /api/agent/ask-response` | `{behavior:'allow', updatedInput:{...input, answers:...}}` |
| permission | `tool_name:'Bash'\|'Edit'\|...` | `prompt.permission` | `POST /api/agent/permission-response` | `{behavior:'allow'\|'deny'\|'allow-with-updated-input', updatedInput?, permissions?}` |
| approve(plan mode ExitPlanMode) | `tool_name:'ExitPlanMode'` | `prompt.approve` | `POST /api/agent/approve` | `{behavior:'approve'\|'deny', updatedInput?}` |

zai 侧 `AskRegistry` / `ApproveRegistry` / `PermissionRegistry`(`services/askRegistry.ts`、`approveRegistry.ts`、`permissionRegistry.ts`)的 `resolve()` 实现:

```ts
// 现状(createOpenccRuntime 路径):直接调 vendor 内部函数
class AskRegistry {
  resolve(toolUseId: string, payload: AnswersPayload): void {
    // 直接调 vendor AskUserQuestion tool 的内部 resolve 句柄
    globalThis.__zaiAskResolver?.(toolUseId, payload)
  }
}

// B1 路径:经 SessionHost 写 stdin
class AskRegistry {
  constructor(private registry: SessionRegistry) {}
  resolve(toolUseId: string, payload: AnswersPayload): void {
    const host = this.registry.findByToolUseId(toolUseId)  // toolUseId ↔ reqId 映射
    if (!host) { console.warn('orphan ask response'); return }
    host.respondControl({
      request_id: host.reqIdForToolUseId(toolUseId),
      response: { behavior: 'allow', updatedInput: payload }
    })  //  → 写 stdin control_response
  }
}
```

`toolUseId ↔ reqId` 映射表由 `SessionHost.controlRequest` 在收到 control_request 时建立、resolve 时清除。

#### 5.5.3 zai in-process 兼容层取消计划

| 现有 in-process 桥 | 现状作用 | B1 落点 |
|---|---|---|
| `compat/tools/opencc/AskUserQuestionTool.ts`(读 `__zaiBridgeCtx`) | vendor AskUserQuestion tool 调 `bridgeAskPendingToPromptAsk` 触发 SSE | 删除 —— 改为子进程 control_request stdout → `SessionHost.bridgeToolYield` |
| `services/headlessPermissionBridge.ts`(读 `__zaiBridgeCtx`) | vendor permission tool yield `tool_use:permission_pending` | 删除 —— 改为 control_request stdout → `SessionHost.bridgeToolYield` |
| `(globalThis as any).__zaiBridgeCtx = { askRegistry, permissionRegistry, onYield }`(`agentRuntime.ts:106`) | init 时一次性注入 vendor in-process 桥的入口 | **保留** —— 不再被 vendor 兼容层读,只供 zai server 内部 `SessionHost` 复用 askRegistry / permissionRegistry 实例引用 |
| `(globalThis as any).__zaiEventBus = eventBus`、`__zaiSessionInbox = sessionInbox` | vendor 在 in-process emit 的桥 | 保留 —— zai server 内部其他子系统(weixin、bashNotifier、weixinBot)仍用 |
| `__zaiBridgeCtx.sessionId`(`createOpenccRuntime-impl.ts:642`) | per-query 桥 context | 删除 —— 子进程自己有 sessionId,走 SessionHost 路由 |
| `sessionInbox`(`services/sessionInbox.ts:39`) | zai 抽象的 followup/steer/inject 三 lane | 保留 + 重写—— 见 §5.3.1 映射表;原 in-process 调用替换为 SessionHost.sendUserMessage / sendControlRequest |

`compat/tools/opencc/AskUserQuestionTool.ts` 删除时间表:阶段 5(收敛阶段)。阶段 1-4 双轨时该文件保留(zai 启动时 `ZAI_RUNTIME=legacy` 走它,`adapter` 走 SessionHost 桥)。

### 5.6 双轨运行开关(`ZAI_OPENCC_CLI`)

迁移采用**显式开关 + 默认关闭**模式,而非直接替换 `createOpenccRuntime`。目的是让新路径在生产环境小流量验证、问题可快速回滚,而不是"一次切完"的爆炸半径。

#### 5.6.1 开关命名与读取优先级

| 来源 | 优先级 | 字段 |
|---|---|---|
| 进程 env | 1(最高) | `ZAI_OPENCC_CLI` |
| 项目级 `cwd/.zai/settings.json` | 2 | `runtime.openccCli: boolean` |
| 用户级 `~/.zai/settings.json` | 3 | 同上 |
| 默认值 | — | `false` |

解析规则(对齐 `services/paths.ts` / `services/zaiSettingsStore.ts`):

```ts
function resolveOpenccCliFlag(settings: ZaiSettings): boolean {
  if (process.env.ZAI_OPENCC_CLI !== undefined) return isEnvTruthy(process.env.ZAI_OPENCC_CLI)
  return settings.runtime?.openccCli ?? false  // 默认 false
}
```

读取一次,在 `initAgentRuntime(cwd)` 入口决策。**不在每个 query 重读**(避免会话中途翻车)。

#### 5.6.2 启动分支

```ts
// agentRuntime.ts initAgentRuntime()
const useOpenccCli = resolveOpenccCliFlag(await readZaiSettings())
if (useOpenccCli) {
  // B1 路径
  await initSessionRegistry({ cwd, dataDir })  // 新增
  await initRuntimeAdapter()                    // 新增,挂 getRuntime() 接口
  // 保留:PluginRuntime、enableOpenccConfigs、__zaiBridgeCtx(eventBus + inbox 桥)
} else {
  // 现状路径
  runtime = await createOpenccRuntime({ cwd, dataDir, interactive: true, ... })
}
console.log(`[initAgentRuntime] runtime path: ${useOpenccCli ? 'opencc-cli' : 'in-process'} (ZAI_OPENCC_CLI=${useOpenccCli})`)
```

两种路径下都**保留**:
- `PluginRuntime`(zai 内部)
- `eventBus` / `__zaiEventBus`(SSE 通道)
- `askRegistry` / `permissionRegistry` / `approveRegistry`(只是 `resolve()` 实现不同)
- `sessionInbox`(lane 语义不变,落点从 in-process 调换成 stdin)
- `sessionFacade`(JSONL 落盘)

#### 5.6.3 切换影响面

| 切到 `ZAI_OPENCC_CLI=true` 时 | 行为 |
|---|---|
| `runtime.query()` 输出流 | vendor SDK event 词汇不变 → `translateRuntimeEvents` 不变 → SSE 不变(前端零感知) |
| 会话持久化 | 不变(sessionFacade 直接读 JSONL) |
| `__zaiEventBus` / SSE | 不变 |
| `__zaiBridgeCtx.askRegistry` / `permissionRegistry` / `onYield` | **保留,但职责收缩** —— `onYield` 不再被 vendor in-process 兼容层读,只供 zai server 内部 SessionHost 引用 |
| cron scheduler | 切换到 true 后**自动生效**(子进程挂载) |
| 多轮 stdin 常驻 | 切换后立刻可用 |
| `--dangerously-skip-permissions` 语义 | 改变 —— 不再是 vendor 全局放权,而是 zai 在 control_request 路径上做 decision(子进程默认 `--permission-mode default`) |
| 子进程 cold start | 首次会话延迟 ~1.6s(`--bare` 实测) |
| `runtime.shutdown()` / `abort()` | 实现替换(从 AbortController → control_request + kill) |

| 切回 `ZAI_OPENCC_CLI=false` 时 | 行为 |
|---|---|
| 现有 in-process runtime 立即接管 | SessionRegistry.killAll() 后 fallback 到 `createOpenccRuntime` |
| 已有 cron 任务(durable:true) | 子进程已把 cron 写盘到 `<cwd>/.zai/scheduled_tasks.json`,切回后由 createOpenccRuntime 读(但 createOpenccRuntime 没挂 scheduler —— 这是已知 gap,切回后 cron fire 行为退化到迁移前状态) |
| 已有会话 transcript | JSONL 不动,前端 hydration 不变 |

#### 5.6.4 双轨部署建议

- **阶段 0-1**:内网/小流量 instance 设 `ZAI_OPENCC_CLI=true`,回归不显著的走默认 false
- **阶段 2-3**:针对**已知痛点的会话**(cron / 状态保持 / permission 流)按 instance 维度放量
- **阶段 4**:全量 instance 验证,前端无感知
- **阶段 5**:把默认值翻成 true,删除 legacy 路径,删除 `ZAI_OPENCC_CLI` env 兜底

#### 5.6.5 监控埋点

双轨期间 zai server 启动日志必须显式标出运行时路径:

```ts
// agentRuntime.ts initAgentRuntime()
const useOpenccCli = resolveOpenccCliFlag(await readZaiSettings())
console.log(`[initAgentRuntime] runtime=${useOpenccCli ? 'opencc-cli' : 'in-process'} cwd=${cwd}`)
eventBus.emit({
  type: 'instance.changed',
  payload: { runtime: useOpenccCli ? 'opencc-cli' : 'in-process' }
})
```

`instance.changed` 是 zai 现有 eventBus 事件类型(`shared/events.ts:381-394`),前端 useAppStore 可选择显示在 instance 信息里(运维自检)。

## OpenccRuntime 8 方法适配

zai 现有 `OpenccRuntime` 契约(`opencc-src/server/serverTypes.ts:274-293`):

| 方法 | zai 调用方 | B1 落点 |
|---|---|---|
| `query(input)` → AsyncGenerator | `routes/agent.ts:1114`、`backgroundRuntime.ts:82` | `SessionHost.forwardQuery(input)` → 写 stdin JSONL → 从 stdout 反压 vendor SDK event 流 |
| `abort(sessionId, reason)` | `agentRuntime.ts:577`、`backgroundRuntime.ts` | `SessionHost.abort()` → 写 `control_request {subtype:'interrupt'}` |
| `shutdown()` | `agentRuntime.ts:461` | `SessionRegistry.killAll()` |
| `getSession / listSessions / readTranscript / patchSession / removeSession` | (类型已定,目前未直接消费) | 走 `sessionFacade`(opencc 已 JSONL 落盘,直接读 `<dataDir>/projects/<sanitize(cwd)>/<sid>.jsonl`,不经过子进程) |
| `plugins.listInstalled/listAvailable/...` | `routes/plugins.ts`(仅 guard) | zai server 内 `DefaultPluginRuntime`(agentRuntime.ts:605),不进子进程 |

**结论**:真正走子进程 stdio 的只有 `query/abort` 两件事;**会话元数据 + 持久化直接读本地 JSONL**(阶段 2 切换);**plugin API 走 zai server 内 PluginRuntime**。

## 改造点概览

### 6.1 新增 `packages/zai/src/server/services/sessionHost/`

| 文件 | 职责 |
|---|---|
| `SessionHost.ts` | 单个会话进程宿主:`spawn(opts)` / `forwardQuery(input)` / `abort()` / `forwardSse()` / `kill()` |
| `SessionRegistry.ts` | 全局 `Map<sid, SessionHost>`;spawn/healthcheck/LRU/孤儿清理 |
| `ndjsonStream.ts` | stdout NDJSON 行解析(逐行 backpressure + EOF 处理 + 错误恢复) |
| `controlRequest.ts` | control_request 注册表(in-flight reqId → resolver);correlate control_response |
| `bridgeToolYield.ts` | 把子进程的 `tool_use:ask_pending / permission_pending / approve_pending` 翻译成 zai 的 `prompt.*`(复用 `agentRuntime.ts:121/158/196` 三件套) |
| `cliSpawn.ts` | spawn 参数构造(`opencc -p --sdk ... --cwd <cwd> --resume <sid>`) + node 直跑入口(zai dev 注入的 `tsx --loader bun-protocol` 也可复用) |

### 6.2 改 `services/agentRuntime.ts`

- 保留 `PluginRuntime`、`SessionInbox`、`sessionControllers`、`__zaiEventBus/__zaiBridgeCtx` 全局桥(职责不变)
- `getRuntime()` 接口**保留**,内部从 `createOpenccRuntime` 改为 `RuntimeAdapter`(下文 6.3)
- `initAgentRuntime(cwd)` 不再调 `createOpenccRuntime`,改为:
  - 启动 `SessionRegistry`(读 zai config,准备 cwd)
  - 保留 `PluginRuntime` + `enableOpenccConfigs`
  - 保留 `__zaiBridgeCtx` 桥(指向 `bridgeToolYield`)
- 删除 `isSdk` 参数(子进程本身即 SDK 模式,无需客户端模拟)
- `abortAllAgentPrompts` → `SessionRegistry.abortAll()`

### 6.3 新增 `services/agentRuntime/RuntimeAdapter.ts`

```ts
class SessionHostRuntimeAdapter implements OpenccRuntime {
  async *query(input) {
    const host = SessionRegistry.getOrSpawn(input.sessionId, { cwd, resume: !!input.sessionId })
    for await (const evt of host.forwardQuery(input)) yield evt
  }
  async abort(sid, reason) { SessionRegistry.get(sid)?.abort(reason) }
  // 6 个持久化方法走 sessionFacade,本地 JSONL,不进子进程
  async getSession(sid) { return sessionFacade.get(sid) }
  async listSessions(opts) { return sessionFacade.list(opts) }
  readTranscript(sid) { return sessionFacade.readTranscript(sid) }
  patchSession(sid, p) { return sessionFacade.patchSession(sid, p) }
  async removeSession(sid) { SessionRegistry.kill(sid); return sessionFacade.removeSession(sid) }
  async shutdown() { await SessionRegistry.killAll() }
}
```

`translateRuntimeEvents`(`routes/agent.ts:265`)无需改动 —— 它消费 vendor SDK event 词汇,子进程产出的就是这套,adapter 喂它。

### 6.4 改 `routes/agent.ts`

- `runtime.query()` 调用形态不变(已对齐 `OpenccRuntime` 契约)
- hydration 路径(`GET /api/agent/sessions/:sid/state`)继续工作 —— adapter 把 `readTranscript`/`getSession` 落到本地 JSONL
- 新增 `GET /api/agent/sessions/:sid/health`(SessionRegistry 健康探测,前端降级显示)

### 6.5 收敛

- `services/backgroundRuntime.ts` 不再直发 `runtime.query()` —— 后台任务注入走 `SessionRegistry.host(sid).forwardQuery({ isMeta: true })`
- `createOpenccRuntime.ts/-impl.ts`、`createHeadlessContext*.ts`、`sessionFacade-impl.ts` 中"为塞进 createOpenccRuntime 而存在"的 in-memory patch 可大幅简化(阶段 5 清理)

## 阶段(摘要)

| 阶段 | 时长 | 验收口径 |
|---|---|---|
| 0 地基 | 0.5 周 | 双轨启动(`ZAI_RUNTIME=adapter|legacy`),浏览器对话冒烟(单 prompt / tool_use / result) |
| 1 事件词汇完整 | 1 周 | 多轮流式、permission 弹窗、tool 卡片全部正常;control_request↔response reqId 关联 |
| 2 持久化切 JSONL | 0.5 周 | 删除 legacy `TranscriptStore`;刷新/断网/跨 cwd 恢复全部 OK |
| 3 cron 自动生效 | 0 周 | 上一轮定位的 `sess-1787563477242-mte0mfme` 案例(cron fire)重新跑通 |
| 4 健康/LRU | 0.5 周 | 长会话不漏消息;子进程 killed 后重发 prompt 恢复 |
| 5 收敛 | 1 周 | 删除 `createOpenccRuntime` 旧路径,清理 zai-patch 注释,默认 `ZAI_RUNTIME=adapter` |

详细 Phase 0-5 文件 / 复用 / Verify 命令见 plan 文档。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 子进程冷启动慢(opencc un-stripped ~5s 解析) | `SessionRegistry` 预热:读 sessionList 后为最近 N 个活跃 sid 提前 spawn;前端 loading 接受冷启动延迟 |
| stdio 通信错位 / 丢消息 | NDJSON + 行级 ack;启动握手:`system init` 到达后才接受 user 输入;心跳 + 健康检查 |
| 子进程死亡状态丢失 | 状态由 JSONL 持久化;死亡 = 重 spawn + `--resume <sid>` 恢复;前端短暂 toast |
| vendor SDK 协议升级 | 走 `output-format stream-json` + `--include-partial-messages` 这套 vendor 公开稳定接口;zai 侧 eventBus spec(`shared/events.ts:381-394`)独立维护 |
| zai patch 与旧 runtime 兼容性 | 阶段 5 才删旧 runtime,期间双轨(`ZAI_RUNTIME` 切换);无需担忧 |
| 多用户多 cwd(同进程多 instance 启动) | zai 实例配置每个 instance 一个 server 进程(`instances.json` 已隔离),SessionRegistry 天然 per-instance |
| 子进程 cron 持锁(`cronTasksLock`) | 子进程持锁 + cwd 隔离 + lockIdentity 来自 sid,跨子进程不冲突(`cronScheduler` 已设计 per-process) |
| vendor CLI 自带的 plugins 加载(实测 superpowers 仍在) | 阶段 1 评估是否 `--no-plugins` 或 zai 自管 plugin list;不影响核心迁移,后续 issue 处理 |

## 与此 spec 关联的工作

- **跟进**:会话 `sess-1787563477242-mte0mfme`(2026-08-24 17:30)实证 CronCreateTool 不 fire → 本 spec 阶段 3 自动解决
- **上游兼容性**:`createOpenccRuntime` 删除时间表(阶段 5);期间 zai 不升级 `STATE.isInteractive` 默认值(zai 当前为 true)
- **跨仓库参考**:`packages/zn-agent-core/src/opencc-src/compat/subagents/codex/` 已是 "spawn CLI + JSON-RPC" 的同类模式,`spawn.ts` / `jsonRpc.ts` 的失败处理(env scrub、tree-kill、abort idempotency)直接复用

## Out of scope

- `B1'`(把 print.ts 改成同进程可常驻库) —— 长期方向,需要 vendor 自身演进
- zai 前端 UI 适配 —— 服务端迁移不影响 frontend eventBus spec
- 完整 cron / permission UX 重设计 —— 本 spec 只解决"功能不生效",UX 在后续 issue 单独讨论
- SDK 协议层优化(zai 进程 → 子进程 IPC 用 UDS 而非 stdio) —— 当前 stdio 性能已满足(单 turn < 10s LLM 调用主导),UDS 化是优化未来