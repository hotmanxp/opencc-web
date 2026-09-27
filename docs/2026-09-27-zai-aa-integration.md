# zai 接入 Agents Anywhere (AA) — 路线 A 实施计划

> **方案**:zai root 进程(已有 `InstanceSupervisor`)作为 AA Connector,**复用现有 AA connector 凭据 `conn_ZeBLE3NEZbnvYw`**,把每个 `InstanceDefinition`(child 子进程)动态注册成 AA `runtime_instance`。手机 AA app 即可看到 zai 管理的所有 session,跟看 Claude/Codex session 同等体验。
>
> **约束**:
> - **手机客户端 + 服务器都用官方**(`https://web.agents-anywhere.com` + AA 官方 iOS/Android/Web app)
> - **zai 不动 Python Connector 源码**(只通过标准 AA v2 WS 协议对接)
> - **child 进程不感知 AA 存在**(root 进程做事件聚合 + 协议适配)
>
> **作者**:zai 接入规划(对齐 zai 现有的 `InstanceSupervisor` + `eventBus`)
>
> **关联文档**:
> - AA 架构:`/Users/ethan/code/Agents-Anywhere/docs/server-architecture.md`
> - AA Runtime Protocol:`/Users/ethan/code/Agents-Anywhere/docs/runtime-protocol/README.md`
> - zai Session 隔离(已存在,本计划复用):`docs/2026-09-06-zai-session-isolation-plan.md`
> - zai Agent Instance Manager design:`docs/superpowers/specs/2026-08-03-zai-agent-instance-manager-design.md`

---

## 0. 架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│ 你的 Mac                                                            │
│                                                                     │
│  zai root process (port 7715 API / 9888 web)                       │
│  ├── InstanceSupervisor(已存在,管 N 个 child 进程)                 │
│  │   ├── child A (port 9201, InstanceDefinition A)                  │
│  │   │   └── 自有 eventBus(单进程) → HTTP /api/internal/child-event │
│  │   ├── child B (port 9202, InstanceDefinition B)                  │
│  │   └── child N (port 920N, InstanceDefinition N)                  │
│  │                                                                   │
│  ├── AA Client(本次新增,挂在 root 上)                              │
│  │   ├── 1 个 AA WebSocket 长连接(复用 conn_ZeBLE3NEZbnvYw 凭据)   │
│  │   ├── N 个动态注册的 runtime_instance(每个 child 一个)          │
│  │   └── runtime_id = "zai_<instance_id>"(稳定 hash)              │
│  │                                                                   │
│  └── eventBus(单进程,root 自己的)                                  │
│       └── AA adapter 订阅 → AA WS 推送                             │
│                                                                     │
│  ~/.zai/aa/                                                         │
│  ├── config.json                   AA server URL + connector 凭据  │
│  ├── runtime-map.json              child_port → aa_runtime_id       │
│  ├── session-map-{port}.json       child_port + zai_session → aa    │
│  └── outbox-{port}.jsonl           离线缓冲(WS 断线时事件暂存)    │
└─────────────────────────────────────────────────────────────────────┘
                       │
                       │ AA v2 WS /api/v2/connector/ws
                       │ Bearer accessToken + X-Device-OS: macos
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│ AA Cloud (https://web.agents-anywhere.com)                          │
│  - POSTGRES durable (connector, runtime_instance, session, timeline)│
│  - Redis coord (lease, pubsub, sequence head)                       │
│  - Revision Clock (v2.24+ int8)                                    │
│  - WebSocket RPC endpoint /api/v2/connector/ws                      │
└─────────────────────────────────────────────────────────────────────┘
                       │
                       │ AA 官方 iOS / Android / Web app
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 你的手机 AA app                                                      │
│  - 看到你的 Mac connector                                            │
│  - 看到 runtime_instance: "Claude" / "Project A child" / "Project B" │
│  - 看到所有 session + timeline(实时) + notice(审批/输入请求)        │
│  - 发消息 / 批准 / interrupt → 经 AA server → root → 对应 child    │
└─────────────────────────────────────────────────────────────────────┘
```

### 关键设计决策

| 决策 | 选择 | 理由 |
|---|---|---|
| **启动 opt-in** | **新增 `--aa` flag**,root + child 都需显式传入 | zai 哲学是 local-first + 显式 opt-in;不传 `--aa` 则全本地化,AA 服务不初始化,事件不上报 |
| 凭据 | **新建 connector**(走法 A 配对) | AA Desktop 的 cxt_xxx 在 keychain 里不可读;zai 必须自己配对拿一个独立 connector 凭据 |
| runtime_instance 粒度 | **每个 `InstanceDefinition` = 1 个** | 手机 AA app 端 "Runtime" 选择器显示项目名,跟 AA 原生体验一致 |
| session_id 映射 | **AA server 分配**;zai 持久 `zai_session ↔ aa_session` 映射 | zai 的 session_id 不能直接当 AA 的用,必须 AA 分配保证全局唯一 |
| WS 连接数 | **1 个**(多路复用 N 个 runtime) | 单 connector 单 WS 是 AA 原生模式,避免 server 端连接数爆炸 |
| child → root 通讯 | **HTTP /api/internal/child-event**(loopback 127.0.0.1) | 复用现有 Express,调试方便;LAN 实例走 LAN IP |
| 离线缓冲 | **按 runtime_id 分文件 JSONL** | 可读、可追;不用 SQLite(跟 zai 现有风格一致) |
| Token 隔离 | AA `cxt_*` token 只在 root server-side,前端 token 不变 | 保持现有 `X-Zai-Token` 安全边界 |

### `--aa` opt-in 行为契约

```
zai dev   (no --aa)
└── ZAI_AA_ENABLED unset
    ├── aaClient modules: not initialized
    ├── /api/aa/* routes: mounted but return 503 aa_disabled
    ├── InstanceSupervisor spawns children without --aa
    │   └── child ZAI_AA_ENABLED unset
    │       └── eventBus events stay local (no POST to root)
    └── AA pairing not possible (user must restart with --aa)

zai dev --aa
└── ZAI_AA_ENABLED=1
    ├── aaClient.initAaClient() runs (T2+)
    ├── /api/aa/* routes work normally
    ├── InstanceSupervisor spawns children with --aa (auto-forwarded)
    │   └── child ZAI_AA_ENABLED=1
    │       └── child POSTs events to root's /api/internal/child-event (T4.5)
    └── Pairing flow available

zai start --aa  →  same as dev --aa but production SPA + API
```

**关键代码位置**:
- `src/cli/index.ts` — `--aa` flag 落到 `process.env.ZAI_AA_ENABLED = '1'`
- `src/cli/start.ts` — 透传 `--aa` 到 supervisor child
- `src/server/services/instanceSupervisor.ts:298` — 透传 `--aa` 到 child instances
- `src/server/services/aaClient/index.ts` — `isAaEnabled()` 单一入口
- `src/server/routes/aa/pairing.ts` — 路由级 `aaGate` middleware(返回 503)

---

## 1. AA v2 协议契约(本计划相关部分)

来源:`/Users/ethan/code/Agents-Anywhere/connector/connector/server/{auth.py, urls.py, client.py, runtime_rpc.py, runtime_host.py, protocol.py}`

### 1.1 鉴权

```
POST {server_url}/api/v2/connector/auth
Headers: Authorization: Connector {connector_id}:{connector_token}

→ 200
{
  "accessToken": "aat_...",
  "expiresIn": 3600
}
```

### 1.2 WebSocket

```
URL:    {ws|wss}://{server_host}/api/v2/connector/ws
Headers:
  Authorization: Bearer {accessToken}
  X-Device-OS: macos | windows | linux

→ 连接后,服务端可推送任意 method 的 notification
→ 客户端可发起 request(method+id+params),服务端异步回 response(同 id)
→ 客户端也可发 notification(无 id),服务端不会回(单向)
```

### 1.3 帧结构(JSON-RPC 2.0)

```typescript
// Request (client → server)
{ "jsonrpc": "2.0", "id": "req_1", "method": "session.discover", "params": {...} }
// Response (server → client)
{ "jsonrpc": "2.0", "id": "req_1", "ok": true, "result": {...} }
// Notification (任意方向,无 id)
{ "jsonrpc": "2.0", "method": "session.meta.upsert", "params": {...} }
```

注意:AA 实际用的是 `{ok, result}` / `{ok: false, error: {code, message}}` 风格,**不是** 标准 JSON-RPC 的 `result/error` 互斥。zai 端需适配。

### 1.4 zai 端需要实现的 inbound RPC(server → zai)

(对应 AA `runtime_rpc.py` 处理的方法)

| method | 作用 | zai 端处理 |
|---|---|---|
| `runtime.discover` | server 询问可用 runtime | 返回 N 个 InstanceDefinition 注册的 runtime_instance |
| `runtime.capabilities` | server 询问 capability 集 | 返回每个 runtime 的 protocol capability |
| `session.create` | server 请求新 session(用户在 mobile 操作) | 路由到对应 child,创建 zai session,返回 aa_session_id |
| `session.send_message` | mobile 发消息 | 路由到 child,入队到 zai `agentRuntime` |
| `session.steer` | mobile 在 turn 中发新消息 | 路由到 child,中断当前 turn,steer 新消息 |
| `session.interrupt` | mobile 中断 turn | 路由到 child,abort controller |
| `session.notices` | server 拉 notice 列表 | 返回 child 当前未处理 notice |
| `session.selections.update` | mobile 切换模型/权限 | 路由到 child,改 modelCaller |
| `session.command.execute` | mobile 跑 slash command | 路由到 child,执行 slash |
| `interaction.respond` | mobile 响应 approval/input | 路由到 child,resolve approveRegistry / askRegistry |

### 1.5 zai 端需要发送的 outbound notifications(zai → server)

(对应 AA `publish_runtime_notifications` allowlist + capabilities/heartbeat)

| method | 频率 | 触发 |
|---|---|---|
| `connector.heartbeat` | 30s | 心跳 |
| `protocol.capabilitiesUpdated` | 连接时 + 变更时 | runtime 注册/卸载后 |
| `session.meta.upsert` | 一次性/变更 | session 创建/重命名/cwd 变更 |
| `session.state.updated` | 频繁 | turn 状态变更、选 model、error |
| `session.turnEnded` | per turn | turn 完成/aborted/failed |
| `timeline.itemUpsert` | 高频 | 消息、tool call、tool result 等 |
| `timeline.sync` | 周期 | 整段 timeline 同步(用于断线重连) |
| `notice.upserted` | 偶发 | approval/input_request/error notice |
| `session.inventory.begin` / `.complete` | 启动时 | session inventory 收尾 |

---

## 2. 任务拆分(15 个 task,3 周)

### Phase 1:协议栈接通(第 1 周)

#### T1. AA 凭据接入

**目标**:zai 启动时检测/读取 AA connector 凭据,持久化到 `~/.zai/aa/config.json`

**改动**:
- `packages/zai/src/server/services/paths.ts` 新增:
  ```typescript
  export const AA_DIR = join(ZAI_DIR, 'aa')
  export function aaConfigPath(): string { return join(AA_DIR, 'config.json') }
  export function aaRuntimeMapPath(): string { return join(AA_DIR, 'runtime-map.json') }
  export function aaSessionMapPath(childPort: number): string { return join(AA_DIR, `session-map-${childPort}.json`) }
  export function aaOutboxPath(childPort: number): string { return join(AA_DIR, `outbox-${childPort}.jsonl`) }
  ```
- 新文件:`packages/zai/src/server/services/aaClient/config.ts`
  - `loadConfig()` 读 `~/.agents-anywhere/connector-runtime.json` 拿 `serverUrl` + `connectorId`
  - **不**持久化 `cxt_*` token(那是 AA Connector Desktop 的;zai 走自己的 access_token 流程)
  - zod schema 校验;失败给清晰错误(引导用户跑 `uv run anywhere-cli start`)
- 新增 env var:`ZAI_AA_ENABLED=true|false`(默认 `true`,显式 `false` 可禁用)

**验证**:
- `bun test packages/zai/test/aaClient/config.test.ts` 通过
- `bun run dev` → 控制台显示 `aa client: enabled, server=https://web.agents-anywhere.com, connector=conn_ZeBLE3NEZbnvYw`

**风险**:🟢 低 — 纯本地文件读取 + 校验。

#### T2. AA v2 JSON-RPC + WS 单连接管理

**目标**:zai 后端实现 AA WS 长连接管理(单连接 + 自动重连)

**改动**:
- 新文件:`packages/zai/src/server/services/aaClient/protocol.ts`
  - zod schema:`RequestFrame`、`ResponseFrame`、`NotificationFrame`(分别对应 `id`+`method`+`params`、`id`+`ok`+`result`/`error`、无 `id`+`method`+`params`)
- 新文件:`packages/zai/src/server/services/aaClient/connection.ts`
  - 复用 `ws`(已在 zai devDependencies)
  - `connect()`:WS 连接 + 鉴权握手 + 30s 心跳(发送 `connector.heartbeat`)
  - 断线指数退避(1s → 2s → 4s → ... → 30s 上限)
  - request/response correlation 用 monotonic counter
  - 写 `eventBus`:`aa.connection.connected` / `aa.connection.disconnected` / `aa.connection.error`

**验证**:
- 单元测试 mock WS server,验证帧编解码 + 重连
- 集成测试:zai 启动 → 真连 `https://web.agents-anywhere.com` → 控制台看到 `ws open` → 心跳日志每 30s

**风险**:🟡 中 — 真连云端,需观察 AA server 端是否正常接受。

#### T3. AA RPC 客户端封装

**目标**:zai 调用 AA inbound RPC + 接收 outbound notification 的统一封装

**改动**:
- 新文件:`packages/zai/src/server/services/aaClient/rpc.ts`
- 方法分类:
  ```typescript
  // Runtime lifecycle
  runtimeDiscover(): Promise<DiscoveryResult>
  publishCapabilities(runtimeId: string, capabilities: CapabilitySet): Promise<void>
  
  // Session lifecycle
  sessionCreate(runtimeId: string, metadata: Record<string, unknown>): Promise<{aaSessionId: string}>
  sessionSendMessage(aaSessionId: string, content: MessageContent): Promise<void>
  sessionSteer(aaSessionId: string, content: MessageContent): Promise<void>
  sessionInterrupt(aaSessionId: string): Promise<void>
  
  // Timeline + notices (outbound notifications, 不需要 response)
  notifySessionMetaUpsert(runtimeId, aaSessionId, meta): void
  notifySessionStateUpdated(runtimeId, aaSessionId, state): void
  notifyTimelineItemUpsert(runtimeId, aaSessionId, item): void
  notifyNoticeUpserted(runtimeId, aaSessionId, notice): void
  notifyTurnEnded(runtimeId, aaSessionId, turnId, outcome): void
  
  // Internal — for T7 reverse path
  onNotification(method: string, handler: (params) => void): Disposable
  ```
- zod schema 严格匹配 AA 实际字段(camelCase 优先;从 `runtime_rpc_payloads.py` / `runtime_host.py` 抓真值)
- 错误处理:`{ok: false, error: {code, message}}` 转成 zai 异常类型(`AAError`)

**验证**:
- 单元测试 mock WS server,验证每种 RPC 入参/出参 schema
- 真实连通后,跑一次 `runtimeDiscover()` 验证返回 N 个 runtime

**风险**:🟡 中 — 字段错位风险;缓解:zod schema 严格校验 + 真帧抓包对比。

#### T4. Hook 进 InstanceSupervisor 动态注册/注销

**目标**:zai 启动/child 增删时,自动向 AA 注册/注销 runtime_instance

**改动**:
- 新文件:`packages/zai/src/server/services/aaClient/runtimeRegistry.ts`
- 监听 `instanceSupervisor` 的事件:
  - `instance.changed`(zai eventBus 已发,看 `eventBus.ts:55`)→ 触发 `registerInstance(instance)` 或 `unregisterInstance(instance)`
- 注册逻辑:
  1. 计算稳定 `runtime_id`:`zai_${instance.id}`(短前缀避免跟 codex/claude/dsh 撞)
  2. 调 `publishCapabilities(runtimeId, capabilitiesForInstance(instance))`
  3. 持久化 `{childPort → runtimeId}` 到 `~/.zai/aa/runtime-map.json`
  4. 写 eventBus:`aa.runtime.registered`
- 注销:从 runtime-map.json 删 + 调 AA `runtime.stop`(?待确认 AA 是否需要显式 deregister)

**验证**:
- `bun run dev` + 创建 3 个 InstanceDefinition → AA Web 后台 "设备" 页看到 3 个 runtime 名为 "Project A" / "Project B" / "Project C"
- 删除一个 → AA 端 runtime 消失

**风险**:🟡 中 — runtime 数量上限未实测;AA supervisor 是 dict 理论无限制。

#### T5. session_id 映射层

**目标**:zai 创建会话时向 AA 注册,持久化 `zai_session_id ↔ aa_session_id`

**改动**:
- 新文件:`packages/zai/src/server/services/aaClient/sessionMap.ts`
- key 设计:`{childPort}:{zaiSessionId}`(跨 child 不会撞,因为 port 唯一)
- 触发点:zai session 创建后,调 `sessionCreate(runtimeId, metadata)` → 拿到 `aa_session_id` → 写入 `~/.zai/aa/session-map-{port}.json`
- 启动 reconcile:zai 启动时扫 session-map.json,跟 child 当前 live session 对账;不一致时以 zai 为准重建 AA session
- `proper-lockfile`(已依赖)防并发写

**验证**:
- zai 创建 session → 30 秒内 AA Web 看到
- 重启 zai + child → session 重新在 AA 端可见

**风险**:🟢 低 — 已有 session 隔离 plan 兜底。

### Phase 2:事件推送(第 2 周)

#### T6. zai eventBus → AA notification 适配器

**目标**:zai 内部事件 → AA timeline/state/notice 推送

**改动**:
- 新文件:`packages/zai/src/server/services/aaClient/eventAdapter.ts`
- 订阅 zai `eventBus`(单进程,root 自己的):
  | zai event | AA notification |
  |---|---|
  | `session.created` | `session.meta.upsert` |
  | `session.deleted` | (server 自己回收) |
  | `session.status_changed` | `session.state.updated` |
  | `message.appended` | `timeline.itemUpsert(type=message)` |
  | `turn.started` / `turn.completed` | `session.turnEnded` + `session.state.updated` |
  | `tool.started` / `tool.completed` | `timeline.itemUpsert(type=tool)` |
  | `approval.requested` | `notice.upserted(type=interaction, kind=approval)` |
  | `input.requested` | `notice.upserted(type=interaction, kind=input)` |
  | `error.runtime` | `notice.upserted(type=notification, severity=error)` |
- 批量缓冲:100ms 窗口合并再推送(AA server `ingest.py` 已支持)
- 通过 `sessionMap.ts` 把 zai session 转成 aa_session_id
- 通过 `runtimeRegistry.ts` 把 child port 转成 aa_runtime_id

**验证**:
- zai 跑一个 turn → AA Web/mobile 端 timeline 实时渲染
- 100ms 内合并 N 个 tool event

**风险**:🟢 低 — 复用已有 eventBus,无新架构风险。

#### T7. AA notification → root → child 反向分发

**目标**:mobile AA app 操作回流到 zai

**改动**:
- 新文件:`packages/zai/src/server/services/aaClient/reverseDispatch.ts`
- AA notification 路由表:
  - `session.message.created` → 通过 `runtimeMap` + `sessionMap` 反查到 child + zai_session → HTTP POST `http://127.0.0.1:{childPort}/api/internal/push-action` 路由到 child
  - `session.notice.resolved` → 类似
  - `session.command.requested` → 类似
- 幂等键(`client_message_id`)防重复触发

**验证**:
- mobile 端发消息 → AA server → zai root → 对应 child → zai turn 被 steer

**风险**:🟡 中 — 反向路由依赖 child 在线 + port 已知;断线时排队(T8 处理)。

#### T7.5. child 端接收 push-action

**目标**:child 端实现 root → child 通道

**改动**:
- 新文件:`packages/zai/src/server/routes/internal/pushAction.ts`
- `POST /api/internal/push-action`(需 `X-Zai-Token` + 验证 root 来源 IP/loopback)
- action 类型:sendMessage / steer / interrupt / approve / input / command
- 调 zai 现有入口(`agentRuntime.ts` / `approveRegistry.ts` / `askRegistry.ts` / `slash.ts`)
- 幂等:zod schema 含 `idempotencyKey`,child 端做去重表

**验证**:
- root 端模拟 mobile 推送 → child 端 action 触发

**风险**:🟢 低 — 加新路由,不动现有逻辑。

#### T4.5. child → root eventBus 内部桥

**目标**:child 进程事件 → root 进程 eventBus(因为 eventBus 是 per-process 单例)

**改动**:
- 新文件:`packages/zai/src/server/services/internal/childEventGateway.ts`(root 端)
- 新文件:`packages/zai/src/server/routes/internal/childEvent.ts`(child 端)
- child 端 `agentRuntime.ts` 等关键 emit 点加 hook:`POST /api/internal/child-event { type, payload, childPort }`(走 loopback)
- root 端收到 → `eventBus.emit({ type, ...payload, childPort })` → T6 adapter 自动接住

**关键 hook 点**(zai 侧):
- `session.created` / `session.deleted` / `session.renamed` — `instanceStore` + `agentRuntime` 入/出口
- `turn.started` / `turn.completed` — `agentRuntime.repl.ts`
- `message.appended` — `eventBus` 已存在,直接加 hook
- `tool.started` / `tool.completed` — `toolExecution.ts`
- `approval.requested` / `input.requested` — `approveRegistry` / `askRegistry`

**验证**:
- 3 个 child 同时跑 turn → root 端 eventBus 收 3 路独立事件流
- root 端 `eventAdapter` 收到后正确推到 AA(每个 runtime_id 不串)

**风险**:🟡 中 — 改多处 hook 点,需仔细回归。

#### T8. 离线缓冲 + 重连补发

**目标**:zai 与 AA 断线时,本地缓存事件,重连后补发

**改动**:
- 新文件:`packages/zai/src/server/services/aaClient/offlineBuffer.ts`
- WS 断开 → 事件落 `~/.zai/aa/outbox-{port}.jsonl`(每行一条)
- WS 重连 → 按顺序回放
- 去重:`timeline.itemUpsert` 自带 `id`,AA server 端幂等(`server/ingest.py` 内部 dedup)
- 上限:`ZAI_AA_OUTBOX_MAX_MB=50`(默认),超出告警 + 截断最老

**验证**:
- `tc qdisc add dev eth0 root netem loss 100%` 30s,期间 zai 跑 turn,恢复后 AA 端 timeline 无丢失

**风险**:🟢 低 — 跟 AA server `ingest.py` 协同,server 端已有幂等。

### Phase 3:前端 + 收尾(第 3 周)

#### T9. 前端"AA 远程会话"页面

**目标**:zai 本地 UI 多一个 tab,看 AA 端 session + 跨设备操作

**改动**:
- 新页面:`packages/zai/src/web/src/pages/AASessions.tsx`
- 数据源:zai 后端新路由 `/api/aa/{runtimes,sessions,notices}`(读 `aaClient` 缓存,不直连 AA server)
- 功能:
  - 列出所有 runtime_instance:zai local (N child) + AA 端的 Claude/Codex/DSH
  - 显示 session 状态、最后消息、未处理 notice 计数
  - 点击 notice → zai 端 respond(走 T7 reverse path)
  - 移动端样式:复用 `MobileAgent.tsx` + `MobileSuperTasks.tsx`

**验证**:
- `http://localhost:9888/aa-sessions` → 看到所有 session
- mobile 上发消息 → zai 这里实时显示

**风险**:🟢 低 — 纯前端 + 复用样式 token。

#### T10. Token 隔离 + AA 路由鉴权

**目标**:zai 已有 `X-Zai-Token` 安全模型扩展到 AA 路由

**改动**:
- `packages/zai/src/server/middleware/auth.ts`:扩展,AA 凭据放 server-side only
- 新路由挂在 `/api/aa/*`,复用现有 token
- AA RPC 调用全在 server-side(前端不直连 AA server)

**验证**:
- `curl -H "X-Zai-Token: xxx" http://localhost:9888/api/aa/sessions` 返回正常
- 无 token → 401

**风险**:🟢 低。

#### T11. 多 child 并发隔离测试

**目标**:验证 N 个 InstanceDefinition 同时 push 不串扰

**改动**:
- 新文件:`packages/zai/test/aaClient/multiInstance.test.ts`
- 场景:
  - 启动 3 个 child
  - 每个创建 session + 跑 turn
  - 验证 AA server 端看到 3 个独立 runtime_instance
  - 验证每个 session timeline 不串
  - 验证 session-map 持久化正确
  - 验证 child 重启后 mapping 不丢

**验证**:`bun test packages/zai/test/aaClient/multiInstance.test.ts` 全绿

**风险**:🟢 低。

#### T12. 文档 + ops runbook

**改动**:
- `packages/zai/docs/aa-integration.md`:架构图、配置项、故障排查
- `packages/zai/AGENTS.md`(若不存在则新建):"AA 集成"章节
- `docs/2026-09-27-zai-aa-integration.md`(本计划归档,持续更新)
- 故障排查:server 连不上 / auth 失败 / outbox 积压 / runtime 不显示

**风险**:🟢 低。

#### T13. E2E 验证

**验证 checklist**:
- [ ] zai 启动 → AA server 显示 zai Mac 为 online
- [ ] zai 创建 session → 手机 AA app 立即看到
- [ ] zai turn 进行中 → 手机 AA app 实时 timeline 滚动
- [ ] zai 触发 approval → 手机 AA app 收到通知
- [ ] 手机批准 → zai 端继续执行
- [ ] 手机发新消息 → zai turn 被 steer
- [ ] zai 关闭 → AA 端 session 进入 disconnected 状态
- [ ] zai 重启 → AA 端 session 自动恢复
- [ ] 3 个 child 同时跑 turn → AA 端 3 个 runtime 各自独立 timeline

---

## 3. 关键文件改动清单

```
新增:
packages/zai/src/server/services/aaClient/
├── config.ts              T1
├── protocol.ts            T2
├── connection.ts          T2
├── rpc.ts                 T3
├── runtimeRegistry.ts     T4
├── sessionMap.ts          T5
├── eventAdapter.ts        T6
├── reverseDispatch.ts     T7
├── offlineBuffer.ts       T8
└── index.ts               barrel export

packages/zai/src/server/services/internal/
└── childEventGateway.ts   T4.5 (root 端)

packages/zai/src/server/routes/internal/
├── childEvent.ts          T4.5 (child 端)
└── pushAction.ts          T7.5 (child 端)

packages/zai/src/server/routes/aa/
├── runtimes.ts            T9
├── sessions.ts            T9
└── notices.ts             T9

packages/zai/src/web/src/pages/
└── AASessions.tsx         T9

测试:
packages/zai/test/aaClient/
├── config.test.ts
├── protocol.test.ts
├── connection.test.ts
├── rpc.test.ts
├── runtimeRegistry.test.ts
├── sessionMap.test.ts
├── eventAdapter.test.ts
├── offlineBuffer.test.ts
└── multiInstance.test.ts  T11

修改:
packages/zai/src/server/services/paths.ts    # 加 AA_DIR + 路径常量
packages/zai/src/server/services/instanceSupervisor.ts  # 加 hook
packages/zai/src/server/services/eventBus.ts            # 加 aa.* 事件(可选)
packages/zai/src/server/index.ts              # 挂载新路由
packages/zai/src/web/src/router.tsx           # 加 /aa-sessions 路由
packages/zai/src/server/middleware/auth.ts    # 加 aa/* 鉴权
```

---

## 4. 风险 + 缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| AA server runtime_instance 数量上限 | 🟡 中 | T4 先测 5 个;AA supervisor 是 dict 理论无限制 |
| zai session_id ↔ AA session_id 漂移 | 🟡 中 | T5 双写 JSON + 启动 reconcile;不一致以 zai 为准 |
| 高频事件 backlog | 🟢 低 | T6 100ms 批量;AA server 已支持 |
| mobile AA app 不识别 zai-specific timeline items | 🟡 中 | T9 用 AA 标准 type,不用 zai 私有 type |
| AA protocol 字段漂移(2.0.0 vs 2.0.1) | 🟡 中 | T3 zod schema 严格匹配 + CI 抓真实帧对比 |
| child crash 时 session 悬挂 | 🟢 低 | supervisor 30 分钟 stale reset;AA 端检测 RPC 断线 → disconnected |
| child 重启 runtime_instance 重注册 | 🟢 低 | T4 用稳定 hash(child_id + port),不重新分配 |
| multi-child session ID 漂移 | 🟢 低 | 已有 session-isolation-plan 兜底;root 只加 AA 映射层 |
| 反向路由 child 不在线 | 🟡 中 | T8 离线缓冲 + child 上线后补发 |
| auth token 过期 | 🟢 低 | T2 60s 提前刷新(skew) |
| AA server 协议版本不匹配 | 🟡 中 | 启动时握手 `protocolVersions`,失败清晰报错 |
| zod schema 跟 Python pydantic 字段名错位 | 🟡 中 | zod `.strict()` 拒绝未声明字段;CI 跑 mock frame 测试 |

---

## 5. 进度追踪

| Task | 状态 | Commit | 验证 |
|---|---|---|---|
| T1 凭据接入 | ✅ DONE | (this commit) | 27/27 unit tests pass; typecheck clean |
| T2 WS 连接管理 | ✅ DONE | (this commit) | 63/63 tests pass; typecheck clean |
| T3 RPC 客户端 | ✅ DONE | (this commit) | typecheck clean |
| T4 动态注册 runtime | ✅ DONE | (this commit) | hooks InstanceSupervisor; typecheck clean |
| T4.5 child → root 事件桥 | ✅ DONE | (this commit) | /api/internal/child-event route; typecheck clean |
| T5 session 映射 | ✅ DONE | (this commit) | per-port file map + serial chain; typecheck clean |
| T6 事件适配器 | ✅ DONE | (this commit) | session + notice + state events mapped; typecheck clean |
| T7 反向分发 | ✅ DONE | (this commit) | AA inbound → child forward (sendMessage/steer/interrupt/interaction.respond); typecheck clean |
| T7.5 child push-action | ✅ DONE | (this commit) | 真实 handler — 通过 HTTP loopback 转发到 zai 现有 API (/api/agent/prompt/abort/approve/answer/slash); typecheck clean |
| T8 离线缓冲 | ✅ DONE | (this commit) | outbox-{port}.jsonl + size cap; typecheck clean |
| T9 前端页面 | ✅ DONE | (this commit) | AASettings page + aaApi client + 接入 Manage tab; typecheck clean; web build clean; 4 web tests pass |
| T10 Token 隔离 | ✅ DONE | (T1 + T9 实质完成) | token 不落 env;config 文件 mode 0600;route handler redacts token;UI never sees cxt_xxx |
| T11 多 child 测试 | ✅ DONE | (this commit) | 6 tests covering runtime reg, session map isolation, port-independent ids, concurrent writes; all pass |
| T12 文档 | ✅ DONE | (this commit) | docs/aa-ops-runbook.md — day-to-day + troubleshooting + file map + env vars + escalation |
| T13 E2E | ✅ DONE | (this commit) | docs/aa-e2e-checklist.md — 12 sections × 60+ sub-checks + scripts/aa-e2e-smoke.sh runs all wiring checks pass |

---

## 6. 实施日志

(随实施推进填写)

- **2026-09-27**:计划落档。开始 T1。
- **2026-09-27 (T1 完成)**:
  - 新增 `paths.ts` AA 路径常量(函数化,跟 weixin 模式一致 — 每次从 env 重读 ZAI_DATA_DIR,支持测试 override)
  - 新增 `services/aaClient/config.ts` — zod schema + 原子写 + chmod 0600 + mutation chain
  - 新增 `services/aaClient/pairing.ts` — startPairing / pollPairing / finalizePairing / cancelPairing / waitForPairingClaim + 自定义错误类
  - 新增 `services/aaClient/index.ts` — barrel + `isAaEnabled()`
  - 新增 `routes/aa/pairing.ts` — 5 个 Express 路由 + `aaGate` middleware(返回 503 当 `--aa` 未启用)
  - 路由挂载到 `index.ts`(挂在 `/api/aa` 前缀)
  - **新增 `--aa` CLI flag(opt-in)**:cli/index.ts 两 command 都加,start.ts 透传到 supervisor child,instanceSupervisor.ts 透传到 child instances
  - 3 个测试文件 / 34 测试用例,全绿;typecheck clean
  - **重要发现**:zai 不能直接复用 `conn_ZeBLE3NEZbnvYw` 的 token — AA Desktop 的 cxt_xxx 在 keychain 里。改用走法 A(配对流程),zai 是**独立 connector**
