# Plan — zai runtime: 以 print.ts 骨架服务化到 SSE/Web

Implements `docs/superpowers/specs/2026-08-24-zai-runtime-printts-sse-web-bridge.md`.

**迁移原则**:显式开关 `ZAI_OPENCC_CLI`,默认 false,阶段 0-4 双轨共存,阶段 5 才把默认值翻 true 并删 legacy 路径(见 spec §5.6)。

## Phase A — Foundation(SessionHost 最小可用)

### A1. 会话进程基础(`packages/zai/src/server/services/sessionHost/`)

新增:

- `types.ts` — `SessionHostOpts { cwd, resume, model?, permissionMode? }`、`SpawnRequest`、`SessionHostState { 'pending' | 'initializing' | 'ready' | 'killed' }`、`ControlRequestSubtype` 联合类型(基于 `print.ts:2982-4028` 完整 control_request subtype 表)
- `cliSpawn.ts` — `buildCliArgs(opts)` 构造 `opencc -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages --bare --no-session-persistence --dangerously-skip-permissions --cwd <cwd> [--resume <sid>] [--model ...]`;`spawnSessionHost(opts): SessionHostHandle` 用 `child_process.spawn`,pipe stdio
- `SessionHost.ts` — 单个会话进程宿主:`forwardQuery(input)`(AsyncGenerator,反压 vendor SDK event 流)、`sendUserMessage(content)`、`sendControlRequest(subtype, payload)`、`respondControl(reqId, response)`、`abort()`、`kill()`、`onSse()`(AsyncIterable)
- `ndjsonStream.ts` — `parseNdjson(stream): AsyncGenerator<unknown>`,逐行 backpressure,处理 EOF / partial line / 非法 JSON 容错
- `controlRequest.ts` — `ControlRequestRegistry { register(reqId, payload, emitter): Promise<unknown>; respond(reqId, response): void; pending: number }`,correlate stdout `control_request` ↔ stdin `control_response`
- `SessionRegistry.ts` — `Map<string, SessionHost>` 全局表,`getOrSpawn(sid, opts)`、`get(sid)`、`kill(sid)`、`killAll()`
- `index.ts` — barrel

复用:

- `getCurrentSessionId()` / `setCurrentSessionId()`(agentRuntime.ts:510)做 per-session 跟踪
- zai server 进程启动时已注入的 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_DEFAULT_*_MODEL` shell env,通过 `child_process.spawn` 默认 `env: process.env` 透传(不显式 scrub —— zai server dev 时已经设置好)
- 调试日志前缀沿用 zai 现有 `[initAgentRuntime]` / `[sessionHost]` 风格(`agentRuntime.ts:354`)

Verify:

```bash
pnpm --filter @zn-ai/zai test src/server/services/sessionHost/
pnpm --filter @zn-ai/zai exec tsc --noEmit
```

### A2. RuntimeAdapter(`packages/zai/src/server/services/agentRuntime/RuntimeAdapter.ts`)

新增 `SessionHostRuntimeAdapter implements OpenccRuntime`(serverTypes.ts:274-293 8 方法契约):

```ts
class SessionHostRuntimeAdapter implements OpenccRuntime {
  constructor(private registry: SessionRegistry, private facade: SessionFacade) {}
  async *query(input) { yield* this.registry.getOrSpawn(input.sessionId, {cwd, resume: !!input.sessionId}).forwardQuery(input) }
  async abort(sid, reason) { this.registry.get(sid)?.abort(reason) }
  async getSession(sid) { return this.facade.get(sid) }
  async listSessions(opts) { return this.facade.list(opts) }
  readTranscript(sid) { return this.facade.readTranscript(sid) }
  patchSession(sid, patch, opts) { return this.facade.patchSession(sid, patch, opts) }
  async removeSession(sid) { this.registry.kill(sid); return this.facade.removeSession(sid) }
  async shutdown() { await this.registry.killAll() }
}
```

**约束**:`OpenccRuntime` 契约不动(zai `getRuntime()` 调用方 `routes/agent.ts:1114`、`backgroundRuntime.ts:82`、`agentRuntime.ts:461/577` 全部继续工作)。

### A3. `agentRuntime.ts` 双轨分支

改 `services/agentRuntime.ts`:

- `initAgentRuntime(cwd, isSdk?)` 在 `enableOpenccConfigs` 之后、`createOpenccRuntime` 之前插入分支:

```ts
const useOpenccCli = resolveOpenccCliFlag(await readZaiSettings())  // §5.6.1
console.log(`[initAgentRuntime] runtime=${useOpenccCli ? 'opencc-cli' : 'in-process'} cwd=${cwd}`)
eventBus.emit({ type: 'instance.changed', payload: { runtime: useOpenccCli ? 'opencc-cli' : 'in-process' } })
if (useOpenccCli) {
  sessionRegistry = await initSessionRegistry({ cwd, dataDir })
  const facade = await createSessionFacadeImpl({ cwd, dataDir })
  runtime = new SessionHostRuntimeAdapter(sessionRegistry, facade)
  process.once('SIGTERM', () => sessionRegistry.killAll())
  process.once('SIGINT', () => sessionRegistry.killAll())
} else {
  // 现状
  runtime = await factory({ cwd, dataDir, mainAgent, mainAgents, runtimeId: 'zai-server', defaultCwd: cwd, interactive: !(isSdk ?? false), ... })
}
```

- 删除 `isSdk` 参数语义(`interactive:false` 由 `ZAI_OPENCC_CLI=true` 取代,见 spec §5.6.2)
- 保留 `__zaiEventBus` / `__zaiSessionInbox` / `__zaiBridgeCtx` 三个 globalThis 桥(职责收缩:不再被 vendor 兼容层读,只供 zai server 内部 SessionHost 复用)
- 保留 `sessionInbox` lane 抽象(暂不动 `followup`/`steer`/`inject` 落点,后续 phase B 替换)

复用:

- `enableOpenccConfigs({cwd})`(agentRuntime.ts:353)双轨都调 —— 仍需初始化 vendor 全局 config 系统(`configReadingAllowed` 标志)
- `PluginRuntime` 实例(`agentRuntime.ts:604-617`)双轨都保留(不进子进程)

Verify(双轨冒烟):

```bash
pnpm --filter @zn-ai/zai exec tsc --noEmit

# legacy 路径冒烟(默认)
pnpm --filter @zn-ai/zai dev -- --port 8103 --api-port 7716
# /ego-browser 验证:打开网页,发 prompt,LLM 回复;关闭浏览器,旧 transcript 还在
# kill 服务,验证不报错

# adapter 路径冒烟
ZAI_OPENCC_CLI=1 pnpm --filter @zn-ai/zai dev -- --port 8103 --api-port 7716
# /ego-browser 验证:打开网页,发 prompt,LLM 回复;前端体验一致
# kill 服务,验证 SessionRegistry.killAll() 不漏消息
```

## Phase B — 事件词汇完整 + 跨进程 permission 流

### B1. bridgeToolYield(`packages/zai/src/server/services/sessionHost/bridgeToolYield.ts`)

新增 — 把子进程 stdout `control_request {tool_use:ask_pending|permission_pending|approve_pending}` 翻译成 zai SSE 事件:

| 控制请求 | zai SSE 事件 | emit 字段 |
|---|---|---|
| `tool_name: 'AskUserQuestion'` | `prompt.ask` | `{sessionId, toolUseId, questions}` |
| `tool_name: 'Bash'\|'Edit'\|...`(其他需 permission) | `prompt.permission` | `{sessionId, toolUseId, toolName, description, input}` |
| `tool_name: 'ExitPlanMode'` | `prompt.approve` | `{sessionId, toolUseId, description, input}` |

复用:

- `agentRuntime.ts:121/158/196` 三个 bridge 函数 `bridgeAskPendingToPromptAsk` / `bridgePermissionPendingToPromptPermission` / `bridgeToolYieldToPrompt` —— 直接调用,不再通过 `__zaiBridgeCtx.onYield` globalThis 桥
- `eventBus.emit()` 直接发 SSE(已有)

Verify:

```bash
pnpm --filter @zn-ai/zai test src/server/services/sessionHost/bridgeToolYield.test.ts
pnpm --filter @zn-ai/zai exec tsc --noEmit
```

### B2. zai registry `resolve()` 改造

改 `services/askRegistry.ts`、`approveRegistry.ts`、`permissionRegistry.ts`(新建或扩):

- 现 `AskRegistry.resolve(toolUseId, payload)` 直接调 `__zaiAskResolver` globalThis 桥(vendor 内部句柄)→ 改为:`SessionRegistry.findByToolUseId(toolUseId)?.respondControl(reqId, {behavior:'allow', updatedInput: payload})`
- `SessionHost.toolUseIdByReqId: Map<reqId, toolUseId>`(B1 注册时建,resolve 时清)
- `PermissionRegistry` / `ApproveRegistry` 同款改造

复用:

- 三个 registry 现有 class 结构(`AskRegistry`、`ApproveRegistry`、`PermissionRegistry`,agentRuntime.ts:68-70)不变
- HTTP 路由 `POST /api/agent/{ask-response|permission-response|approve}`(`routes/agent.ts`)不变 —— registry 实例签名不变,只是 `resolve()` 落点换了

Verify:

```bash
pnpm --filter @zn-ai/zai test src/server/services/askRegistry.test.ts \
                                src/server/services/permissionRegistry.test.ts \
                                src/server/services/approveRegistry.test.ts
pnpm --filter @zn-ai/zai exec tsc --noEmit
# /ego-browser:触发 AskUserQuestion / Bash 权限确认 / ExitPlanMode 三类,前端弹窗 + 回答后子进程继续 turn
ZAI_OPENCC_CLI=1 pnpm --filter @zn-ai/zai dev -- --port 8103 --api-port 7716
```

### B3. sessionInbox lane 落点替换

改 `services/sessionInbox.ts`:

- `followup(sid, msg)` 当前通过 `__zaiSessionInbox.followup` → 改为:`SessionRegistry.get(sid)?.sendUserMessage(content)` + 触发 wakeHandler(同现状)
- `steer(sid, msg)` 同 `followup`(vendor 没有"中途插队"协议,见 spec §5.3.1)
- `inject(sid, msg)` 同 `followup` 但不触发 wakeHandler
- 新增 `steerAndRestart(sid, newPrompt)` 实现 `interrupt + waitForResultTerminal + sendUserMessage` 三步编排(spec §5.3.1 状态机)

Verify:

```bash
pnpm --filter @zn-ai/zai test src/server/services/sessionInbox.test.ts
# /ego-browser:后台 BashNotifier 触发 inject → 主会话 turn 自然 drain 后看到通知;BashNotifier 不引发额外 query
```

## Phase C — 会话持久化切到 JSONL(收尾)

### C1. 删除 legacy TranscriptStore 兜底

改 `services/agentRuntime.ts:66`(transcriptStore 引用)、`services/agentRuntime.ts:538-541`(`getTranscriptStore()` 导出)、`routes/{agent, transcript, approve}.ts` 的旧 reader 调用点:

- 改 `getTranscriptStore()` 为 deprecated 警告(zai 已有注释 `agentRuntime.ts:18-24` 明确 TranscriptStore 是 legacy 兜底)
- 改 `runtime.readTranscript(...)` 直接返回 sessionFacade JSONL(adapter A2 已实现)
- 删 `routes/transcript.ts`(若全部走 `runtime.readTranscript`)

复用:

- `sessionFacadeImpl`(`opencc-src/server/sessionFacade-impl.ts:createSessionFacadeImpl`)已经是 JSONL 落盘,无需改动
- `services/transcriptStore.ts`(若存在)直接删除

Verify:

```bash
pnpm --filter @zn-ai/zai test src/server/routes/transcript.test.ts
pnpm --filter @zn-ai/zai exec tsc --noEmit
# /ego-browser:刷新页面 → hydrate 历史完整;断网 → 重连 → 状态恢复
# /ego-browser:跨 cwd 会话恢复(切换 instance 之后切回原 cwd)
```

## Phase D — cron 自动生效(伴随产物)

**几乎无独立工作**。子进程 `runHeadless` 已在 `print.ts:2857-2885` 挂载 `cronScheduler`,`--no-session-persistence` 只禁持久化(写盘),不影响 session-only cron;durable:true 任务写 `<cwd>/.zai/scheduled_tasks.json`,spawn 时 `--cwd` 自然读取。

### D1. 验证 cron fire 路径(spec 关联的会话 `sess-1787563477242-mte0mfme` 案例)

Verify(`/ego-browser skill 真实浏览器验收):

```bash
ZAI_OPENCC_CLI=1 pnpm --filter @zn-ai/zai dev -- --port 8103 --api-port 7716

# 浏览器测试:
# 1) "每 2 分钟输出当前时间,17:40 停止" → LLM 创建 cron,默认 durable:false(session-only)
# 2) 等 2 分钟,观察会话是否出现新消息(时间文本)
# 3) 17:40 时另一条 cron 触发,自动删除 + 报告停止
```

预期:会话 transcript 出现多条 assistant 消息,LLM 主动输出当前时间;无需 zai 侧任何额外代码。

### D2. durable cron 跨重启恢复验证

Verify:

```bash
# 1) 浏览器创建 durable:true cron("明天 9 点提醒 X")
# 2) kill zai 服务(pkill -f 'zai dev')
# 3) 启动新实例(spawn 新子进程会读 <cwd>/.zai/scheduled_tasks.json)
# 4) 等 9 点,验证子进程触发 cron
```

预期:zai 进程重启后 cron 自动恢复 —— vendor 子进程长驻,无需 zai 维护状态。

## Phase E — 健康 / LRU / 错误恢复

### E1. 心跳与健康探测

改 `SessionRegistry.ts` / `SessionHost.ts`:

- 子进程 5s 无 stdout 输出(`system_event` 之外)→ 标 `stalled`,30s 仍无输出 → 标 `dead`,SessionRegistry 自动 kill + spawn + `--resume`
- 控制请求 in-flight 超时 60s → 自动 `deny` control_response + 标 `unhealthy`

复用:

- vendor `headless heartbeat`(print.ts:1070 `createHeadlessHeartbeatStructuredEmitter`)emit `HeadlessHeartbeatEvent`,zai SessionHost 在 init handshake 时订阅

Verify:

```bash
pnpm --filter @zn-ai/zai test src/server/services/sessionHost/SessionRegistry.healthcheck.test.ts
# /ego-browser:kill -9 <sub-pid>(模拟 OOM)→ 浏览器端 toast 显示"会话重启中" → 新会话恢复
```

### E2. LRU 淘汰

改 `SessionRegistry.ts`:

- `idleMs > 30min` 的 host 进入 `idle` 状态,5min 内未被复用 → `kill()` + spawn 新 host + `--resume`
- 极端 instance(100+ sid 同时活跃)→ 内存压力检测 + 强制 LRU evict

Verify:

```bash
pnpm --filter @zn-ai/zai test src/server/services/sessionHost/SessionRegistry.lru.test.ts
```

## Phase F — 收敛(默认翻 true,删 legacy)

### F1. 默认值翻转

改 `services/agentRuntime.ts:resolveOpenccCliFlag`:

```ts
function resolveOpenccCliFlag(settings: ZaiSettings): boolean {
  if (process.env.ZAI_OPENCC_CLI !== undefined) return isEnvTruthy(process.env.ZAI_OPENCC_CLI)
  return settings.runtime?.openccCli ?? true  // 默认 true
}
```

### F2. 删除 legacy 路径

- 删 `services/agentRuntime.ts` 中 `else` 分支(legacy `createOpenccRuntime` 调用),删除 `runtime = await factory(...)` 块
- 删 `services/agentRuntime.ts:66` legacy `transcriptStore` 引用 + `getTranscriptStore()` 导出
- 删 `packages/zn-agent-core/src/opencc-src/server/createOpenccRuntime-impl.ts`(若全 zai 路径已迁移),或保留作为 vendor 内部模块(给 Agent SDK daemon 等其他用)
- 删 `packages/zn-agent-core/src/opencc-src/compat/tools/opencc/AskUserQuestionTool.ts`(双轨时已停用)
- 删 `packages/zn-agent-core/src/opencc-src/compat/runtime/headlessPermissionBridge.ts`
- 简化 `agentRuntime.ts` 顶部注释(去掉 zai-patch 注释,如 `createOpenccRuntime-impl.ts:568-578` 中"sess-1787121363115-0zq3bo8a hydration patch"等)
- 删除 `ZAI_OPENCC_CLI` env 兜底(选项层删除,settings.runtime.openccCli 字段保留作为 zai config 显式开关)

Verify:

```bash
# 全 workspace 类型检查
pnpm -r exec tsc --noEmit
# 单元测试(只跑受影响文件,不全量)
pnpm --filter @zn-ai/zai test
# 关键:e2e / 集成路径
pnpm --filter @zn-ai/zai test test/integration/
# 真实浏览器回归(覆盖:多轮对话、permission 弹窗、AskUserQuestion、cron fire、跨 cwd 恢复、durable cron 跨重启)
/ego-browser
```

## 阶段时间估算

| Phase | 工作量 | 累计 |
|---|---|---|
| A 地基 | 0.5 周 | 0.5 周 |
| B 协议完整 | 1 周 | 1.5 周 |
| C 持久化 | 0.5 周 | 2 周 |
| D cron | 0 周(伴随) | 2 周 |
| E 健康 | 0.5 周 | 2.5 周 |
| F 收敛 | 1 周 | 3.5 周 |

总计 ~3.5 周;阶段 A 完成后即可让 spec 关联的 cron 修复(`sess-1787563477242-mte0mfme`)走 B1 路径验证。

## Verify 总览(对齐 AGENTS.md 强约束)

| 节点 | 命令 |
|---|---|
| 每次 phase 完成 | `pnpm --filter @zn-ai/zai exec tsc --noEmit` |
| 单元测试(只跑受影响文件) | `pnpm --filter @zn-ai/zai test <changed-path>` |
| 改 core 后(本 plan 阶段不涉及) | `pnpm run build:core`(本 plan 阶段 A-E 都不改 core,F 才删 createOpenccRuntime) |
| 真实浏览器验收 | `/ego-browser` skill,启动 zai dev,走用户路径 |
| 端口冲突检查 | `lsof -i :<port>` 前置(AGENTS.md 强制);phase A 起独立 dev 端口(`--port 8103 --api-port 7716`),**不杀 920x 正式服务** |
| Cron 实证验证 | 复用 spec 关联会话 `sess-1787563477242-mte0mfme` 的 LLM prompt 模式,直接验证阶段 D |
| 子进程 stdio 通信健壮性 | `pnpm --filter @zn-ai/zai test src/server/services/sessionHost/` 覆盖 NDJSON 解析 / partial line / EOF / 异常 JSON 容错 |
| 多 cwd 实例隔离 | 启动两个 zai instance(不同 cwd),各自 spawn 子进程,验证互不串扰 |

## 关联工作

- **spec**: `docs/superpowers/specs/2026-08-24-zai-runtime-printts-sse-web-bridge.md`(已写完,本 plan 是其实现)
- **跟进问题**:上一轮定位的 `sess-1787563477242-mte0mfme` cron 不 fire 问题(阶段 D 自动解决)
- **下游**:阶段 F 完成后可考虑把 print.ts B1' 路线("vendor 自身演进支持同进程常驻多会话")作为独立 spec 提给 opencc 上游(降低 zai 子进程运维成本)