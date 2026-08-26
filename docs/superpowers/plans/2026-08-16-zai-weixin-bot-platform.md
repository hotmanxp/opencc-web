# ZAI Weixin (微信) 个人号机器人远程通信 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan phase-by-phase. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 zai (`packages/zai`) 中实现一个**长期后台运行**的微信 (Weixin) 个人号机器人适配器,把 iLink Bot API 的入站消息接入 zai 现有的 `eventBus` / SSE 通道,把 zai agent runtime 的回复镜像回微信,让用户可以在手机微信里跟本地 zai 对话。

**Scope:** 复用 hermes-agent 已验证的协议层设计(`gateway/platforms/weixin.py` 2379 行),翻译为 zai 的:
- zai 服务端 **同进程**长跑后台 task(不走子进程,免 IPC 复杂度 — zai 已经用 `instanceSupervisor` 管多实例,这里再加一个 listener 类的后台 task 即可)
- zai **事件总线** (`services/eventBus.ts`) 替代 hermes 的 `BasePlatformAdapter.handle_message`
- zai **agent runtime** (`services/agentRuntime.ts` 的 `getRuntime().query(...)`) 替代 hermes 的 `MessageEvent` → agent 调度链路
- zai **已有的 SSE / 路由体系** (`routes/` + `services/sse.ts`) 替代 hermes 的 `DeliveryRouter`
- zai **配置 / 设置** (`shared/settings.ts` + `~/.zai/settings.json`) 替代 hermes 的 `~/.hermes/.env`

**Architecture at a glance:** 一个 `WeixinBotManager` 在 `initAgentRuntime()` 之后被构造;它根据 `zaiSettings.weixinBot` 配置决定是否启动 `WeixinAdapter`(若启用则 `connect()` 启动 long-poll loop)。适配器是纯 TypeScript 类,封装 iLink Client / 状态存储 / 媒体层;它通过 `eventBus` 与 zai 余下部分通信 —— **入站**把 iLink 消息翻译成 `prompt.ask` 类 ServerEvent 抛到 bus,**出站**订阅 bus 上的 `runtime.delta` / `runtime.done` 事件,镜像给 iLink `sendmessage`。这样 SSE 仍然把同样的事件流推给 Web UI,微信和 Web 实质上共享同一份对话视图。

**Tech Stack:** TypeScript 5.6, Node.js ≥20, Express 4.21, Vitest 4.1, zod 3, Node 内置 `fetch` / `crypto` (Web Crypto API), `proper-lockfile` (用于账号 token 单实例锁), `qrcode-terminal` (CLI wizard 终端二维码渲染),不引入新网络层(用 Node 20+ 原生 fetch / undici)。

---

## 全局约束

- **不引入 iLink 私有 SDK / 第三方微信 SDK**:协议层来自 hermes-agent 已逆向验证的 6 个端点(`getupdates` / `sendmessage` / `sendtyping` / `getconfig` / `getuploadurl` / `get_bot_qrcode` / `get_qrcode_status`),全部 HTTP/HTTPS,自己组装 aiohttp-style request。
- **CDN 域名白名单硬编码**:仅允许 `novac2c.cdn.weixin.qq.com` / `ilinkai.weixin.qq.com` / `wx.qlogo.cn` / `thirdwx.qlogo.cn` / `res.wx.qq.com` / `mmbiz.qpic.cn` / `mmbiz.qlogo.cn`,SSRF 防护。
- **运行时依赖**:仅 `proper-lockfile` (账号锁) + `qrcode-terminal` (CLI 二维码,wizard 阶段)。Node ≥20 自带 `fetch` / `crypto.subtle` / `AbortController`,无需 `axios` / `node-fetch` / `crypto-js` / `form-data`。
- **iLink 身份限制(已知)**:iLink Bot identity(`...@im.bot`)通常不会收到普通微信群事件;文档 + 启动日志必须**显式警告**用户,`group_policy=disabled` 是默认。最常见的落地形态是**只** DM。
- **媒体加密**:AES-128-ECB + PKCS#7,使用 Node 内置 `crypto.createCipheriv` / `createDecipheriv`(`aes-128-ecb` 算法 + 自动 PKCS#7 padding),不引入 `crypto-js`。
- **不实现 group @mention 路由**:iLink Bot 身份不支持,plan 留口子但不复用 hermes 的 `is_mentioned` 逻辑。
- **持久化目录**:`~/.zai/weixin/accounts/<account_id>.json`(账号元数据), `~/.zai/weixin/sync/<account_id>.buf`(long-poll 游标), `~/.zai/weixin/context-tokens/<account_id>.json`(per-peer context token)。**所有路径**走 `services/paths.ts` 已有的 `ZAI_DIR` 常量,不直接 `os.homedir()`。
- **账号锁**:同一 `token` 只能一个 zai 实例拉,使用 `proper-lockfile` 在 `~/.zai/weixin/locks/<token-hash>.lock` 上加锁;run 多实例(如 dev + prod)会得到清晰错误,**禁止**静默切换端口(参见根 AGENTS.md 端口约束)。
- **不依赖**:browser / playwright / puppeteer / curl — 仅服务端 + Vite Web UI(纯文本 + 二维码 URL 即可,扫码在用户手机端)。
- **不破坏现有 zai 启动流程**:WeixinBotManager 启动失败 → 警告日志 + 继续,不让整个 zai 进程崩;Web UI 状态栏显示 "weixin: disconnected" 即可。
- **TypeScript 严格模式**:所有新增模块必须 `strict: true` 通过,无 `any` 滥用;只允许 `unknown` + 显式 narrowing。
- **测试粒度**:每个阶段只跑**直接相关**的 Vitest 文件(参见根 AGENTS.md "测试粒度"),不跑 `pnpm -r test` 全量。
- **真实浏览器 / 终端验收**:完成 B7 后必须用 `pnpm --filter @zn-ai/zai dev` 启动真实 zai 实例,通过 Vite Web UI 走通 DM 接 → QR 扫码 → 收到消息 → 收到回复 全链路(参见根 AGENTS.md "真实浏览器验收" 强制项)。

---

## 架构图

### 整体视图

```
┌────────────────────────────────────────────────────────────────────────────┐
│                zai 进程 (Express + RN/zai-agent-core)                      │
│                                                                            │
│  ┌──────────────┐  ┌──────────────────────────────────────────────────┐    │
│  │ Web UI       │  │ routes/                                          │    │
│  │ (Vite/React) │  │   /api/event       (SSE, eventBus 订阅)          │    │
│  │   │          │  │   /api/agent/...   (createSseStream, runtime)     │    │
│  │   │ SSE      │  │   /api/weixin/...  (控制 + 状态)        ◄── NEW   │    │
│  │   ▼          │  │   /api/plugins/... (已有,不冲突)                 │    │
│  │ ┌────────┐   │  └──────────────────────────────────────────────────┘    │
│  │ │store/  │   │                                                          │
│  │ │Zustand │   │  ┌──────────────────────────────────────────────────┐    │
│  │ │store   │   │  │ services/                                         │    │
│  │ └────────┘   │  │   eventBus     (ServerEventBus, 256 ring)         │    │
│  │              │  │   agentRuntime (initAgentRuntime, getRuntime())   │    │
│  │   ▲          │  │   sse          (writeSse, event 序列化)          │    │
│  │   │ prompt   │  │   paths.ts     (ZAI_DIR 常量)              ◄── MOD │    │
│  │   │ /delta   │  │   weixinBot/  ◄─────────────────────────── NEW ──┤    │
│  └──────────────┘  │     WeixinBotManager(同进程长跑 task)              │    │
│                    │       └─ WeixinAdapter (per account)               │    │
│                    │            ├─ iLinkClient (HTTP long-poll)        │    │
│                    │            ├─ ContextTokenStore (持久化)           │    │
│                    │            ├─ SyncBufStore (持久化)                │    │
│                    │            ├─ TypingTicketCache (内存)             │    │
│                    │            ├─ MessageDeduplicator (内存)           │    │
│                    │            ├─ AccountLock (proper-lockfile)         │    │
│                    │            └─ MediaCrypto (AES-128-ECB)            │    │
│                    └──────────────────────────────────────────────────┘    │
│                                                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  zai-agent-core (zn-agent-core)                                     │   │
│  │    OpenccRuntime.query({sessionId, content}) ──► runtime.delta/...  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                            │
└─────────────────────────────────────┬──────────────────────────────────────┘
                                      │ HTTPS (long-poll + sendmessage)
                                      ▼
              ┌─────────────────────────────────────────────────────┐
              │  iLink Bot API (ilinkai.weixin.qq.com)               │
              │   /ilink/bot/getupdates  (pull, 35s hold)             │
              │   /ilink/bot/sendmessage (push)                       │
              │   /ilink/bot/sendtyping  (push)                       │
              │   /ilink/bot/getconfig   (typing_ticket)              │
              │   /ilink/bot/getuploadurl (media)                     │
              │   /ilink/bot/get_bot_qrcode  (login)                  │
              │   /ilink/bot/get_qrcode_status (login poll)           │
              └─────────────────────────────────────────────────────┘
                                      │ HTTPS (encrypted CDN)
                                      ▼
              ┌─────────────────────────────────────────────────────┐
              │  CDN (novac2c.cdn.weixin.qq.com/c2c)                 │
              │   /upload?encrypted_query_param=...&filekey=...       │
              │   /download?encrypted_query_param=...                 │
              │   (AES-128-ECB + PKCS#7)                              │
              └─────────────────────────────────────────────────────┘
```

### 单条消息入站时序

```
┌──────────┐  HTTPS  ┌──────────────┐  eventBus.emit  ┌──────────────┐
│  iLink   │──poll──►│ WeixinAdapter │──prompt.ask──► │  eventBus     │──SSE──► Web UI
│          │  msgs[] │  _poll_loop   │  (sessionId=   │              │
│          │         │  │            │  weixin:<acct> │              │
│          │         │  ▼            │   :<peerId>)   │              │
│          │         │_process_mesg  │                │              │
│          │         │  ├─ dedup     │                │              │
│          │         │  ├─ access    │                │              │
│          │         │  │  policy    │                │              │
│          │         │  ├─ media     │                │              │
│          │         │  │  download  │                │              │
│          │         │  └─ debounce  │                │              │
└──────────┘         └──────────────┘                └──────────────┘
```

### 单条回复出站时序

```
┌──────────────┐  runtime.delta   ┌──────────────┐  HTTPS  ┌──────────┐
│ agentRuntime │──eventBus────────►│ WeixinAdapter│──send──►│  iLink   │
│              │                  │  send_sub    │  message│          │
│   (subscribe  │──runtime.done───►│  (text       │  . 分块 │          │
│    on weixin  │                  │   chunk +    │  AES-128│          │
│    sessionId) │                  │   media)     │  upload │          │
└──────────────┘                  └──────────────┘    │   URL)  └──────────┘
```

---

## 与 zai 现有架构的集成点

| 接入位置 | 现有 zai 组件 | weixin-bot 接入方式 |
|----------|---------------|---------------------|
| 配置 | `~/.zai/settings.json` + `shared/settings.ts` (zaiSettings) | 新增 `zaiSettings.weixinBot: { accountId, token, baseUrl?, cdnBaseUrl?, dmPolicy, groupPolicy, allowFrom?, groupAllowFrom?, textBatchDelaySeconds?, ... }`,在 `shared/settings.ts` 增 zod schema |
| 持久化 | `services/paths.ts` (`ZAI_DIR` = `~/.zai`) | 在 `paths.ts` 增 `WEIXIN_DIR` / `WEIXIN_ACCOUNTS_DIR` / `WEIXIN_LOCKS_DIR` / `WEIXIN_SYNC_DIR` / `WEIXIN_CONTEXT_DIR` |
| 启动 | `services/agentRuntime.ts` 的 `initAgentRuntime()` | 函数末尾追加 `await weixinBotManager.start()`,best-effort(失败 warn,不 throw) |
| 进程信号 | `instanceSupervisor.ts` / `runtimeLifecycle.ts` | 复用现有 `process.on('SIGTERM' / 'SIGINT')` 钩子,`weixinBotManager.stop()` 在 `runtimeLifecycle` 之内 |
| 事件总线 | `services/eventBus.ts` | **入站**:`eventBus.emit({ type: 'prompt.ask', sessionId: 'weixin:<acct>:<peer>', ... })` 或者新增 `runtime.user.message` 子类型;**出站**:`eventBus.subscribeTopics('weixin:<acct>:<peer>', ['runtime.delta', 'runtime.done', 'runtime.tool_call'], ...)` |
| 直接 agent 调用 | `runtime.query({ sessionId, content })` | 当 `dmPolicy=pairing` 初次配对 / `dmPolicy=open` 直接把入站消息当新 prompt 调 `runtime.query(...)` |
| HTTP API | `routes/*.ts` (Express Router) | 新增 `routes/weixin.ts`:`GET /api/weixin/status` / `POST /api/weixin/connect` / `POST /api/weixin/disconnect` / `POST /api/weixin/setup/start` / `GET /api/weixin/setup/qrcode` / `POST /api/weixin/setup/confirm` |
| Web UI | `web/src/components/` (Vite + React + AntD + Zustand) | 新增 `web/src/components/WeixinBotPanel.tsx` + 在 `SettingsDrawer.tsx` 加 tab |
| 测试 | `packages/zai/test/...` (Vitest) | 新增 `packages/zai/test/server/weixinBot/*.test.ts` |

---

## 核心类

### `ILinkClient`(`services/weixinBot/iLinkClient.ts`)

```ts
export class ILinkClient {
  constructor(opts: {
    baseUrl: string           // 默认 https://ilinkai.weixin.qq.com
    token: string
    fetchImpl?: typeof fetch  // 可注入,测试用 vi.fn
  })

  // 35s 长轮询,带 syncBuf 续读
  async getUpdates(syncBuf: string, timeoutMs: number): Promise<{
    ret: number; errcode: number; errmsg?: string
    msgs?: ILinkInboundMessage[]
    longpolling_timeout_ms?: number
    get_updates_buf?: string
  }>

  async sendMessage(to: string, text: string, contextToken: string | null, clientId: string): Promise<ILinkResponse>
  async sendTyping(toUserId: string, typingTicket: string, status: 1 | 2): Promise<ILinkResponse>
  async getConfig(userId: string, contextToken: string | null): Promise<{ typing_ticket: string; ... }>
  async getUploadUrl(): Promise<{ upload_url: string; encrypted_query_param: string }>
  async getBotQrcode(): Promise<{ qrcode_url: string; qrcode_id: string }>
  async getQrcodeStatus(qrcodeId: string): Promise<{ status: 'waiting' | 'scanned' | 'confirmed' | 'expired'; account_id?: string; token?: string; base_url?: string }>
}
```

**iLink 协议字段**:`base_info: { ilink_app_id: 'bot', ilink_app_client_version: '0x020200' }`,所有 POST body 为 JSON。

### 状态存储(4 个)

```ts
// 服务端持久化,per-account-per-peer
class ContextTokenStore {
  load(accountId: string): Map<peerId, string>
  save(accountId: string, peerId: string, token: string): Promise<void>
  get(accountId: string, peerId: string): string | null
}

// 持久化,per-account
class SyncBufStore {
  load(accountId: string): Promise<string>
  save(accountId: string, buf: string): Promise<void>  // 原子写,fsync
}

// 内存,per-user,TTL 600s
class TypingTicketCache {
  get(userId: string): string | null
  set(userId: string, ticket: string): void
  // 内部定时清理
}

// 内存,TTL 5 分钟,双保险(message_id + content md5)
class MessageDeduplicator {
  constructor(ttlSeconds: number)
  isDuplicate(key: string): boolean  // 命中返回 true 并续期
}
```

### `MediaCrypto`(`services/weixinBot/mediaCrypto.ts`)

```ts
export class MediaCrypto {
  // 16-byte AES-128-ECB,Node 内置
  static encrypt(plaintext: Buffer, keyB64: string): Buffer  // PKCS#7 padding
  static decrypt(ciphertext: Buffer, keyB64: string): Buffer
  static generateKey(): string         // 16-byte random,base64
  static parseKey(raw: string): Buffer // 兼容 base64 / hex 入站 key
}

// CDN URL 防御
export function assertSafeCdnUrl(url: string): void  // 命中白名单放行,否则 throw
export const WEIXIN_CDN_ALLOWLIST: ReadonlySet<string> = new Set([
  'novac2c.cdn.weixin.qq.com', 'ilinkai.weixin.qq.com',
  'wx.qlogo.cn', 'thirdwx.qlogo.cn', 'res.wx.qq.com',
  'mmbiz.qpic.cn', 'mmbiz.qlogo.cn',
])
```

### `WeixinAdapter`(`services/weixinBot/WeixinAdapter.ts`)

核心类,持有一个 `ILinkClient` + 4 个 state stores + 2 个 aiohttp-style session(`pollSession` / `sendSession` 用 Node 20+ `fetch` + `AbortController` 实现)。关键 API:

```ts
export class WeixinAdapter {
  readonly accountId: string
  constructor(opts: WeixinAdapterOptions)

  async connect(): Promise<void>          // 启动 _poll_loop task,获取账号锁
  async disconnect(): Promise<void>      // 取消 task,释放账号锁,关闭 session
  isConnected(): boolean
  getStatus(): { state: 'connected' | 'disconnected' | 'reconnecting'; lastError?: string; lastConnAt?: number }

  // iLink → eventBus 翻译
  private async _pollLoop(): Promise<void>      // 永不抛出,出错降级 + 退避
  private async _processMessage(msg: ILinkInboundMessage): Promise<void>

  // eventBus → iLink 翻译(订阅注册由 WeixinBotManager 调用)
  registerOutboundSubscriber(sub: WeixinOutboundSubscriber): void
  private async _sendTextChunk(chatId, chunk, contextToken, clientId): Promise<void>
  async sendText(chatId, text): Promise<{ success: boolean; messageId?: string; error?: string }>
  async sendImage(chatId, imagePath): Promise<...>
  async sendDocument(chatId, filePath): Promise<...>
  async sendVideo(chatId, videoPath): Promise<...>
  async sendVoice(chatId, audioPath): Promise<...>
  async sendTyping(chatId, status: 'start' | 'stop'): Promise<void>
}
```

### `WeixinBotManager`(`services/weixinBot/WeixinBotManager.ts`)

```ts
export class WeixinBotManager {
  private runtime: OpenccRuntime | null      // setRuntime(r)
  private adapter: WeixinAdapter | null
  private busUnsub: (() => void) | null

  constructor()

  setRuntime(r: OpenccRuntime): void       // initAgentRuntime 末尾调用
  async start(): Promise<void>              // 读 zaiSettings.weixinBot,按需 start adapter
  async stop(): Promise<void>              // 反向:disconnect adapter,unsub bus
  async reload(): Promise<void>             // reconnect,settings 改动后用

  getStatus(): { configured: boolean; enabled: boolean; state: ...; accountId?: string; lastError?: string }
  async startSetup(): Promise<{ qrcodeUrl: string; qrcodeId: string }>  // 走 iLinkClient.getBotQrcode
  async pollSetup(qrcodeId: string): Promise<SetupStatus>
  async cancelSetup(): Promise<void>
}
```

接在 `initAgentRuntime()` 末尾:

```ts
export async function initAgentRuntime(...) {
  // ... 现有初始化 ...
  weixinBotManager.setRuntime(r)
  await weixinBotManager.start()  // best-effort,失败仅 warn
}
```

接在 `runtimeLifecycle.shutdownForensic()` 内:

```ts
export async function shutdownForensics() {
  await weixinBotManager.stop()  // 顺序:先停止 inbound,再断开 runtime
  // ... 现有清理 ...
}
```

---

## 文件地图

### 新增文件

#### 服务端

- `packages/zai/src/server/services/paths.ts` — **修改**:追加 `WEIXIN_DIR` / `WEIXIN_ACCOUNTS_DIR` / `WEIXIN_LOCKS_DIR` / `WEIXIN_SYNC_DIR` / `WEIXIN_CONTEXT_DIR` 常量,并提供 `ensureWeixinDirs()` helper。
- `packages/zai/src/server/services/weixinBot/iLinkClient.ts` — iLink HTTP 客户端(6 个端点,getUpdates 带 35s 超时)。
- `packages/zai/src/server/services/weixinBot/iLinkTypes.ts` — zod schema 描述入站 `ILinkInboundMessage` / 出站 payload / 错误码枚举(`SESSION_EXPIRED = -14` / `RATE_LIMIT = -2`)。
- `packages/zai/src/server/services/weixinBot/stores/ContextTokenStore.ts` — 磁盘持久化 per-account-per-peer。
- `packages/zai/src/server/services/weixinBot/stores/SyncBufStore.ts` — 磁盘持久化 long-poll 游标,原子写。
- `packages/zai/src/server/services/weixinBot/stores/TypingTicketCache.ts` — 内存 TTL 600s。
- `packages/zai/src/server/services/weixinBot/stores/MessageDeduplicator.ts` — 内存 TTL 300s,双指纹。
- `packages/zai/src/server/services/weixinBot/AccountLock.ts` — `proper-lockfile` 包裹,token-hash 锁。
- `packages/zai/src/server/services/weixinBot/mediaCrypto.ts` — AES-128-ECB + PKCS#7 + URL 白名单 + 入站 key 解析。
- `packages/zai/src/server/services/weixinBot/accessPolicy.ts` — DM policy(open / allowlist / pairing / disabled) + group policy(open / allowlist / disabled)。
- `packages/zai/src/server/services/weixinBot/debounce.ts` — 文本批量合并(3s / 5s 静默期)。
- `packages/zai/src/server/services/weixinBot/WeixinAdapter.ts` — 核心适配器(connect / disconnect / _pollLoop / _processMessage / sendText / sendImage / sendDocument / sendVideo / sendVoice / sendTyping)。
- `packages/zai/src/server/services/weixinBot/WeixinBotManager.ts` — 顶层 manager + 与 zai 集成的入口。
- `packages/zai/src/server/services/weixinBot/index.ts` — 单例 `weixinBotManager` + public exports。
- `packages/zai/src/server/routes/weixin.ts` — REST API:`GET /api/weixin/status` / `POST /api/weixin/connect` / `POST /api/weixin/disconnect` / `POST /api/weixin/reload` / `POST /api/weixin/setup/start` / `GET /api/weixin/setup/qrcode` / `POST /api/weixin/setup/confirm`。
- `packages/zai/src/shared/weixin.ts` — 客户端共享类型(`WeixinStatus` / `WeixinSetupState` / `WeixinSettingsSchema`)。
- `packages/zai/src/shared/settings.ts` — **修改**:zaiSettings zod schema 加 `weixinBot?: WeixinBotSettings`。

#### 前端

- `packages/zai/src/web/src/components/WeixinBotPanel.tsx` — 设置抽屉中的微信 tab:账户状态 / 启停按钮 / 设置表单 / 实时入站消息预览(SSE)。
- `packages/zai/src/web/src/components/WeixinBotPanel.test.tsx` — 组件测试。
- `packages/zai/src/web/src/components/SettingsDrawer.tsx` — **修改**:新增微信 tab + lazy-load WeixinBotPanel。
- `packages/zai/src/web/src/components/StatusDot.tsx` — **修改**:可选新增 'weixin' source,在状态栏显示在线/离线。
- `packages/zai/src/web/src/lib/api/weixin.ts` — `apiRpc` 类型化 stub:`weixinStatus()` / `weixinConnect()` / `weixinDisconnect()` / `weixinSetupStart()` / `weixinSetupPoll()` ...

#### 测试

- `packages/zai/test/server/weixinBot/iLinkClient.test.ts` — 用 `vi.fn()` 注入 fetch,覆盖 6 端点 + 错误码。
- `packages/zai/test/server/weixinBot/MediaCrypto.test.ts` — AES-128-ECB round-trip + 白名单 URL。
- `packages/zai/test/server/weixinBot/ContextTokenStore.test.ts` — 持久化 + 并发写。
- `packages/zai/test/server/weixinBot/SyncBufStore.test.ts` — 原子写 + 损坏文件恢复。
- `packages/zai/test/server/weixinBot/MessageDeduplicator.test.ts` — TTL 过期 + 命中续期。
- `packages/zai/test/server/weixinBot/debounce.test.ts` — 静默期合并 + 重置 + 长度阈值切换延迟。
- `packages/zai/test/server/weixinBot/accessPolicy.test.ts` — 4 种 DM policy + 3 种 group policy + 互相独立。
- `packages/zai/test/server/weixinBot/WeixinAdapter.test.ts` — mock iLinkClient,验证 _pollLoop / _processMessage / send / 重试链。
- `packages/zai/test/server/weixinBot/WeixinBotManager.test.ts` — 验证启动 / 停止 / 重新加载 + 与 eventBus 联动。
- `packages/zai/test/server/routes/weixin.test.ts` — Express supertest,验证 router 端点 + 503 兜底。

### 修改文件

- `packages/zai/src/server/services/agentRuntime.ts` — `initAgentRuntime(...)` 末尾追加 `weixinBotManager.setRuntime(r); await weixinBotManager.start()`;`shutdownForensics(...)` 头部追加 `await weixinBotManager.stop()`。
- `packages/zai/src/server/services/runtimeLifecycle.ts` — 复用或追加 `weixinBotManager.stop()` hook。
- `packages/zai/src/server/routes/index.ts` — `app.use('/api/weixin', weixinRouter)`。
- `packages/zai/src/server/index.ts` — 若 `initAgentRuntime` / `shutdownForensics` 与现有 patch 位置有冲突,合并而非覆盖(参见根 AGENTS.md "禁止" 规则)。
- `packages/zai/src/shared/events.ts` — **新增** `runtime.user.message` 事件类型(若不复用 `prompt.ask`);或复用 `prompt.ask` + `sessionId` 字段表达源 session(sid 命名约定 `weixin:<acct>:<peer>`)。
- `packages/zai/src/web/src/store/useAgentStore.ts` — **可选**:增加 `weixinInbox` 投影字段,用于在状态栏展示「来自微信的新消息」徽标。
- `packages/zai/package.json` — dependencies: `proper-lockfile`(仅 server 子树,确认重复则跳过);devDependencies: `qrcode-terminal`。
- `packages/zai/AGENTS.md`(若存在) — 增补 weixin-bot 章节,与根 AGENTS.md 风格一致。

---

## 实施阶段

### B0 — 协议契约与持久化骨架

**Goal:** 落地 iLink 协议 zod schema、4 个状态存储、媒体 crypto + SSRF 白名单、账号锁。不连真实 iLink,纯单元测试。

**Files:**
- Create: `packages/zai/src/server/services/weixinBot/iLinkClient.ts`
- Create: `packages/zai/src/server/services/weixinBot/iLinkTypes.ts`
- Create: `packages/zai/src/server/services/weixinBot/stores/{ContextTokenStore,SyncBufStore,TypingTicketCache,MessageDeduplicator}.ts`
- Create: `packages/zai/src/server/services/weixinBot/AccountLock.ts`
- Create: `packages/zai/src/server/services/weixinBot/mediaCrypto.ts`
- Create: `packages/zai/src/server/services/weixinBot/accessPolicy.ts`
- Modify: `packages/zai/src/server/services/paths.ts`(末尾追加 5 个常量 + `ensureWeixinDirs()`)
- Test: `packages/zai/test/server/weixinBot/{MediaCrypto,ContextTokenStore,SyncBufStore,MessageDeduplicator,accessPolicy,iLinkClient}.test.ts`

**关键 Step:**

- [ ] **B0-S1: iLink 协议 schema 与错误码**

  在 `iLinkTypes.ts` 用 zod 定义:

  ```ts
  export const ILINK_ERROR = {
    OK: 0, SESSION_EXPIRED: -14, RATE_LIMIT: -2,
  } as const

  // 入站
  export const ILinkInboundMessage = z.object({
    message_id: z.string(),
    from_user_id: z.string(),
    to_user_id: z.string(),
    room_id: z.string().optional(),
    chat_room_id: z.string().optional(),
    msg_type: z.union([z.literal(1), z.literal(2)]),  // 1=user, 2=bot
    context_token: z.string().optional(),
    item_list: z.array(z.object({
      type: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),  // text/image/voice/file/video
      text_item: z.object({ text: z.string() }).optional(),
      image_item: z.object({ aeskey: z.string().optional(), media: z.object({ encrypt_query_param: z.string().optional(), full_url: z.string().optional() }).optional() }).optional(),
      // ... other types
    })),
  })

  // 出站
  export const ILinkSendMessageRequest = z.object({
    from_user_id: z.literal(''),
    to_user_id: z.string(),
    client_id: z.string(),
    message_type: z.literal(2),
    content: z.object({ text: z.string(), context_token: z.string().optional() }),
    base_info: z.object({ ilink_app_id: z.literal('bot'), ilink_app_client_version: z.literal('0x020200') }),
  })
  ```

- [ ] **B0-S2: iLinkClient 骨架 + fetch 注入**

  `iLinkClient.getUpdates` / `sendMessage` / `sendTyping` / `getConfig` / `getUploadUrl` / `getBotQrcode` / `getQrcodeStatus` 全部用 `this.opts.fetchImpl ?? fetch`,测试时注入 `vi.fn()`。35s 超时用 `AbortController` + `setTimeout` 强制 abort。

- [ ] **B0-S3: 状态存储 + 单元测试**

  - `ContextTokenStore`:`{ peerId: token }` map,持久化到 `~/.zai/weixin/context-tokens/<accountId>.json`,`fs.writeFile` + `fsync` 原子写。
  - `SyncBufStore`:单字符串,持久化到 `~/.zai/weixin/sync/<accountId>.buf`,缺省返回 `''`。
  - `TypingTicketCache`:内存 `Map<userId, { ticket, expiresAt }>`,TTL 600s。
  - `MessageDeduplicator`:内存 `Map<key, expiresAt>`,TTL 300s,`isDuplicate(key)` 命中则刷新 TTL。
  - `AccountLock`:基于 `proper-lockfile`,锁路径 `~/.zai/weixin/locks/<sha256(token).hex>.lock`,`acquire()` / `release()` 都是 async。

- [ ] **B0-S4: MediaCrypto + SSRF 防护**

  ```ts
  export function encryptAes128Ecb(plaintext: Buffer, keyB64: string): Buffer {
    const key = parseKey(keyB64)
    const cipher = crypto.createCipheriv('aes-128-ecb', key, null)
    cipher.setAutoPadding(true)  // PKCS#7
    return Buffer.concat([cipher.update(plaintext), cipher.final()])
  }

  export function parseKey(raw: string): Buffer {
    // 16-byte 直接 base64;32-byte 视为 hex-string(去包 base64)
    const decoded = Buffer.from(raw, 'base64')
    if (decoded.length === 16) return decoded
    if (decoded.length === 32) {
      const asText = decoded.toString('ascii')
      if (/^[0-9a-fA-F]+$/.test(asText) && asText.length === 32) return Buffer.from(asText, 'hex')
    }
    throw new Error('weixin-media: aes key must be 16 raw bytes or 32 hex chars (base64-encoded)')
  }

  // 白名单 + http(s) only
  export function assertSafeCdnUrl(url: string): void {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('weixin-media: non-http scheme')
    if (!WEIXIN_CDN_ALLOWLIST.has(u.hostname)) throw new Error(`weixin-media: host ${u.hostname} not in allowlist`)
  }
  ```

- [ ] **B0-S5: accessPolicy**

  `evaluate({ policy: 'open' | 'allowlist' | 'pairing' | 'disabled', allowFrom: string[], senderId: string })` → `boolean`。Group policy 同样,只是 chatType 不同。把 hermes 的 `_is_dm_intake_allowed` / `_is_dm_allowed` 拆成两个函数:`evaluateIntake`(LM 处理前)vs `evaluateResponse`(已通过 intake 后的额外校验)。

- [ ] **B0-S6: 单元测试 + 类型检查**

  每个 store / crypto / policy 至少 3 个 case(成功 / 失败 / 边界)。
  ```bash
  pnpm --filter @zn-ai/zai test test/server/weixinBot/iLinkClient.test.ts \
                                test/server/weixinBot/MediaCrypto.test.ts \
                                test/server/weixinBot/ContextTokenStore.test.ts \
                                test/server/weixinBot/SyncBufStore.test.ts \
                                test/server/weixinBot/MessageDeduplicator.test.ts \
                                test/server/weixinBot/accessPolicy.test.ts
  pnpm -r exec tsc --noEmit
  ```

- [ ] **B0-S7: Commit**

  ```bash
  git add packages/zai/src/server/services/weixinBot/ \
          packages/zai/src/server/services/paths.ts \
          packages/zai/test/server/weixinBot/
  git commit -m "feat(zai): weixin-bot B0 — iLink 协议契约 + 状态存储 + 媒体加密"
  ```

---

### B1 — WeixinAdapter 核心(轮询 + 入站解析)

**Goal:** 实现 WeixinAdapter 的 `_pollLoop` / `_processMessage` / 访问控制 / 文本 debounce / 媒体下载。pure inbound 路径完成,出站(推送)留到 B2。

**Files:**
- Create: `packages/zai/src/server/services/weixinBot/debounce.ts`
- Create: `packages/zai/src/server/services/weixinBot/WeixinAdapter.ts`(只到 inbound 部分)
- Test: `packages/zai/test/server/weixinBot/debounce.test.ts`
- Test: `packages/zai/test/server/weixinBot/WeixinAdapter.inbound.test.ts`

**关键 Step:**

- [ ] **B1-S1: debounce**

  `BufferingDebounce(key, event, delaySeconds)`,内部 `Map<key, { event, timer }>`,新事件合并(文本追加,媒体追加列表)并 reset timer。`text_batch_split_delay_seconds` 阈值:最近一条 chunk 长度 ≥ 1800 时切到长延迟(5s)。

- [ ] **B1-S2: WeixinAdapter 构造 + connect / disconnect**

  `connect()`:
  1. 校验 `accountId` / `token` 非空
  2. `await AccountLock.acquire(token)`(失败 throw)
  3. 构造 `iLinkClient` / 4 个 stores
  4. 启动 `this._pollTask = scheduleTask(this._pollLoop.bind(this))`
  5. `restore syncBuf from disk`
  6. 标记 `_state = 'connected'`

  `disconnect()`:
  1. 取消 `_pollTask`,`await task` 等到 cancelled
  2. 关闭 iLinkClient(取消所有 in-flight fetch via AbortController)
  3. `_pendingDebounceTimers.forEach(clearTimeout)`
  4. `AccountLock.release(token)`
  5. 标记 `_state = 'disconnected'`

- [ ] **B1-S3: _pollLoop**

  `while (this._running)`:
  1. `result = await iLinkClient.getUpdates(syncBuf, 35_000)`
  2. 更新 `syncBuf = result.get_updates_buf`,`await SyncBufStore.save(...)` 立即 fsync
  3. 根据 `result.longpolling_timeout_ms` 调整下次 timeout
  4. 错误处理:
     - `ret === SESSION_EXPIRED (-14)` → 暂停 10 分钟,清零 consecutiveFailures
     - 前 2 次错误 → `sleep(2s)` 重试
     - 3+ 次 → `sleep(30s)`,重置 counter
     - `TimeoutError`(正常 long-poll)→ 立即重试
  5. `for (const msg of result.msgs ?? [])` 不阻塞:
     ```ts
     void this._processMessageSafe(msg)  // 用 scheduleTask 异步
     ```

- [ ] **B1-S4: _processMessage**

  1. dedup: `message_id` hit → skip;文本 md5(`md5(\`content:${senderId}:${md5(text)}\`)`)hit → skip
  2. classify chat: `_guessChatType(msg)` → `'dm' | 'group'`
  3. access policy: group `disabled` → skip;DM `_is_dm_intake_allowed` → skip
  4. context token: `msg.context_token` → `ContextTokenStore.save(...)`
  5. typing ticket: `void iLinkClient.getConfig(senderId, ctxToken)` 异步预热,缓存到 `TypingTicketCache`
  6. media: `for (item of msg.item_list) await _collectMedia(item, paths, types)` 用 `assertSafeCdnUrl` + `decryptAes128Ecb`
  7. 构造 `InternalWeixinMessage`(本阶段只需结构化,eventBus 派发在 B3):
     ```ts
     interface InternalWeixinMessage {
       accountId: string
       chatId: string           // dm: sender; group: room_id
       chatType: 'dm' | 'group'
       senderId: string
       text: string
       mediaPaths: string[]
       mediaTypes: string[]
       messageId: string
       contextToken: string | null
       raw: unknown
     }
     ```
  8. 文本 → enqueue debounce;媒体 → 立即 flush
  9. flush 时调 `this._emitInternal(message)`(B1 阶段方法体空,B3 接入 eventBus)

- [ ] **B1-S5: 单元测试**

  - mock iLinkClient,断言 `_pollLoop` 在 SESSION_EXPIRED 时暂停 10 分钟(`vi.useFakeTimers`)
  - 同一 `message_id` 两次 poll 只 dispatch 一次
  - DM policy=allowlist 不在 allowFrom 的 sender 被 skip
  - text debounce 3s 后 dispatch,期间新消息被合并
  - 媒体下载 mock CDN server,assert assertSafeCdnUrl 拒绝第三方 host

- [ ] **B1-S6: Commit**

  ```bash
  git add packages/zai/src/server/services/weixinBot/{debounce.ts,WeixinAdapter.ts}
  git commit -m "feat(zai): weixin-bot B1 — Adapter 入站 long-poll + 解析 + 防重"
  ```

---

### B2 — WeixinAdapter 出站(推送链路)

**Goal:** 实现 `sendText` / `sendImage` / `sendDocument` / `sendVideo` / `sendVoice` / `sendTyping` / 媒体上传加密流程。重试链、限流熔断、文本 debounce flush 之后的格式转换都在这里。

**Files:**
- Modify: `packages/zai/src/server/services/weixinBot/WeixinAdapter.ts`(追加 sendXxx)
- Test: `packages/zai/test/server/weixinBot/WeixinAdapter.outbound.test.ts`

**关键 Step:**

- [ ] **B2-S1: 文本分块 + 发送**

  `sendText(chatId, text)`:
  1. 取 `contextToken = ContextTokenStore.get(accountId, chatId)`
  2. `chunks = splitText(text, { maxLen: 4000, respectCodeFences: true })`(保护 ``` 块不被切断)
  3. `for chunk of chunks`:
     - `await _sendTextChunk({ chatId, chunk, contextToken })`
     - chunk 之间 `sleep(1.5s)`(可配 `WEIXIN_SEND_CHUNK_DELAY_SECONDS`)
  4. `_sendTextChunk` 用 `Semaphore`(自己实现的 `Mutex`)串行化所有 send,避免限流

- [ ] **B2-S2: 重试链 + 限流熔断**

  `_sendTextChunk`:
  - 4 次 retry,指数 backoff
  - 错码 `-14`(session expired)且 `contextToken` 非空 → 剥掉 token 重试 1 次(`tokenless` 兜底,对 cron 触发消息有用)
  - 错码 `-2`(rate limit) → 触发 `RateLimitCircuit`,30s 冷却;`recordRateLimit()` 计入滑动窗口,阈值 `WEIXIN_RATE_LIMIT_CIRCUIT_THRESHOLD` (默认 1) 时打开
  - 退出条件:成功 / 风扇打开 / 重试耗尽 (raise RuntimeError)

- [ ] **B2-S3: 媒体上传通用 helper `_sendFile`**

  1. `key = MediaCrypto.generateKey()`
  2. `ciphertext = MediaCrypto.encrypt(file, key)`
  3. `uploadInfo = await iLinkClient.getUploadUrl()`
  4. `uploadUrl = \`${cdnBaseUrl}/upload?encrypted_query_param=${uploadInfo.encrypted_query_param}&filekey=${filename}\``
  5. `await fetch(uploadUrl, { method: 'POST', body: ciphertext, headers: { 'Content-Type': 'application/octet-stream' } })`
  6. 拿 `x-encrypted-param` header 作为 outbound reference
  7. `await iLinkClient.sendMessage(chatId, { media: { encrypt_query_param: xEncrypted, aes_key: key, ... } }, contextToken)`

- [ ] **B2-S4: sendImage / sendDocument / sendVideo / sendVoice**

  封装 `_sendFile` + media 类型分发:
  - image: `mime=image`,iLink 端 type=2
  - video: `mime=video`,iLink 端 type=5
  - file: 任意 mime,iLink 端 type=4
  - voice: 仅 `.silk` 时走 voice 通道(type=3,10s 上限),否则降级为 file

- [ ] **B2-S5: sendTyping / stopTyping**

  - 调 `_ensureTypingTicket(chatId)` — 缓存 miss 时 `iLinkClient.getConfig(chatId, ctxToken)` 续期
  - `iLinkClient.sendTyping(chatId, ticket, status: 1 | 2)`

- [ ] **B2-S6: 单元测试**

  - mock iLinkClient,验证 4 次重试耗尽抛 RuntimeError
  - 模拟 `-14` 错码,验证 contextToken 被剥掉重试
  - 模拟 `-2` 错码连续 2 次,验证 CircuitBreaker 打开
  - 媒体上传 mock `fetch`,验证 `application/octet-stream` body + `x-encrypted-param` 提取
  - assertSafeCdnUrl 拒绝 `evil.example.com` 抛 `Error`

- [ ] **B2-S7: Commit**

  ```bash
  git add packages/zai/src/server/services/weixinBot/WeixinAdapter.ts
  git commit -m "feat(zai): weixin-bot B2 — 出站推送 + 重试 + 限流熔断 + 媒体加密"
  ```

---

### B3 — 与 zai eventBus 集成(双向桥)

**Goal:** 把 WeixinAdapter 接入 zai 的 SSE 事件总线。入站 → `prompt.ask`,出站 ← 订阅 `runtime.delta` / `runtime.done`。

**Files:**
- Modify: `packages/zai/src/server/services/weixinBot/WeixinAdapter.ts`(`_emitInternal` 真实实现)
- Create: `packages/zai/src/server/services/weixinBot/WeixinBotManager.ts`
- Modify: `packages/zai/src/server/services/agentRuntime.ts`(`initAgentRuntime` 末尾 + `shutdownForensics` 头部)
- Modify: `packages/zai/src/server/services/runtimeLifecycle.ts`(若需)
- Modify: `packages/zai/src/shared/events.ts`(增 `runtime.user.message` 类型,若不复用 `prompt.ask`)
- Test: `packages/zai/test/server/weixinBot/WeixinBotManager.test.ts`

**关键 Step:**

- [ ] **B3-S1: 入站派发**

  `_emitInternal(msg: InternalWeixinMessage)`:
  - 生成 `sessionId = \`weixin:${msg.accountId}:${msg.chatType}:${msg.chatId}\``(dm 时 chatId = senderId; group 时 chatId = room_id)
  - 生成 `senderId = msg.senderId`
  - 调用 `eventBus.emit({ type: 'prompt.ask', sessionId, senderId, content: msg.text, mediaPaths: msg.mediaPaths, source: 'weixin', pendingMessageId: msg.messageId })`
  - 注意:若 access policy 在 `prompt.ask` 处理处也要二次校验(防 prompt injection),由 `agentRuntime` 处理;这里只负责翻译

- [ ] **B3-S2: 出站订阅**

  `WeixinBotManager._subscribeOutbound()`:
  - `handleSessionId = \`weixin:${accountId}:${chatType}:${chatId}\``
  - `eventBus.subscribeTopics(handleSessionId, ['runtime.delta', 'runtime.done', 'runtime.tool_call', 'runtime.thinking'], (event) => { ... })`
  - `runtime.delta` → `adapter.sendText(sessionId, event.delta)`(节流:每 1.5s 才 flush 一次,避免乱序)
  - `runtime.done` → `finalizeSend(chatId)`,同时 `stop_typing`
  - `runtime.tool_call` 不送微信(用户只在 chat 视角看到进度)
  - `runtime.thinking` 默认折叠,不送

- [ ] **B3-S3: WeixinBotManager 启动 / 停止**

  - `start()` 读 `zaiSettings.weixinBot`,若 `enabled === false` → 跳过,标记 `state: 'disabled'`
  - 若 `enabled && accountId && token` → `new WeixinAdapter({...}).connect()`
  - `stop()` 对称 `disconnect()`
  - 启动失败不 throw,只 `console.warn` + `state: 'failed'`
  - `getStatus()` 返回 `{ configured, enabled, state, accountId?, lastError? }`

- [ ] **B3-S4: agentRuntime 接入**

  `initAgentRuntime()` 末尾:
  ```ts
  import { weixinBotManager } from './weixinBot/index.js'
  // ... 现有初始化 ...
  weixinBotManager.setRuntime(r)
  await weixinBotManager.start()  // best-effort
  ```

  `shutdownForensics()` 头部:
  ```ts
  await weixinBotManager.stop()
  ```

- [ ] **B3-S5: 单元测试**

  - mock eventBus,模拟入站,assert `prompt.ask` event 被 emit,sessionId 格式正确
  - 模拟 `runtime.delta` 事件,assert adapter.sendText 被调用
  - 重启流程:`start()` 之后再 `stop()`,adapter 资源释放(token 锁释放,fetch AbortController 触发)

- [ ] **B3-S6: Commit**

  ```bash
  git add packages/zai/src/server/services/weixinBot/{WeixinAdapter.ts,WeixinBotManager.ts,index.ts} \
          packages/zai/src/server/services/agentRuntime.ts \
          packages/zai/src/server/services/runtimeLifecycle.ts \
          packages/zai/src/shared/events.ts
  git commit -m "feat(zai): weixin-bot B3 — 接入 eventBus,入站派发 + 出站镜像"
  ```

---

### B4 — HTTP API + Settings

**Goal:** `routes/weixin.ts` 提供完整 REST 控制(`/api/weixin/*`),zaiSettings schema 落地。

**Files:**
- Create: `packages/zai/src/server/routes/weixin.ts`
- Create: `packages/zai/src/shared/weixin.ts`
- Modify: `packages/zai/src/shared/settings.ts`(`zaiSettings.weixinBot` schema)
- Modify: `packages/zai/src/server/routes/index.ts`(`app.use('/api/weixin', weixinRouter)`)
- Test: `packages/zai/test/server/routes/weixin.test.ts`

**协议:**

```ts
// GET /api/weixin/status
{ configured: boolean, enabled: boolean, state: 'connected' | 'disconnected' | 'reconnecting' | 'failed' | 'disabled', accountId?: string, lastError?: string, lastConnAt?: number }

// POST /api/weixin/connect       { accountId, token, ... }
// POST /api/weixin/disconnect
// POST /api/weixin/reload        (settings 改动后)

// POST /api/weixin/setup/start
{ qrcodeId: string, qrcodeUrl: string }

// GET /api/weixin/setup/poll?qrcodeId=xxx
{ status: 'waiting' | 'scanned' | 'confirmed' | 'expired', accountId?: string, baseUrl?: string }

// POST /api/weixin/setup/confirm  { qrcodeId }  → 拉取 token + 持久化 + 启动 adapter
// POST /api/weixin/setup/cancel
```

**关键 Step:**

- [ ] **B4-S1: zaiSettings schema**

  ```ts
  // shared/settings.ts
  export const WeixinBotSettingsSchema = z.object({
    enabled: z.boolean().default(false),
    accountId: z.string().optional(),
    token: z.string().optional(),  // 实际不存 settings.json,运行时从持久化文件读
    baseUrl: z.string().url().default('https://ilinkai.weixin.qq.com'),
    cdnBaseUrl: z.string().url().default('https://novac2c.cdn.weixin.qq.com/c2c'),
    dmPolicy: z.enum(['open', 'allowlist', 'pairing', 'disabled']).default('pairing'),
    groupPolicy: z.enum(['open', 'allowlist', 'disabled']).default('disabled'),
    allowFrom: z.array(z.string()).default([]),
    groupAllowFrom: z.array(z.string()).default([]),
    textBatchDelaySeconds: z.number().nonnegative().default(3.0),
    textBatchSplitDelaySeconds: z.number().nonnegative().default(5.0),
    sendChunkDelaySeconds: z.number().nonnegative().default(1.5),
    sendChunkRetries: z.number().int().nonnegative().default(4),
    rateLimitCircuitThreshold: z.number().int().positive().default(1),
    rateLimitCircuitOpenSeconds: z.number().nonnegative().default(30.0),
  })

  // 顶层 zaiSettingsSchema 加:
  weixinBot: WeixinBotSettingsSchema.optional()
  ```

- [ ] **B4-S2: routes/weixin.ts**

  - 所有 endpoint 走 `zod` body schema,验证失败 → 400
  - 状态变更(`connect` / `disconnect`) → `weixinBotManager.start() / stop() / reload()`
  - `setup/start` 调 `weixinBotManager.startSetup()`,返回 `qrcodeUrl` 和 `qrcodeId`
  - `setup/poll` 调 `weixinBotManager.pollSetup(qrcodeId)`,定时给前端轮询
  - `setup/confirm` 拿到 `accountId` + `token` 后存到 `~/.zai/weixin/accounts/<accountId>.json`,启动 adapter

- [ ] **B4-S3: supertest 集成测试**

  - `GET /api/weixin/status` 返回 200 + 状态
  - `POST /api/weixin/connect` 缺 config → 400
  - `POST /api/weixin/disconnect` 后 status state === 'disconnected'
  - `POST /api/weixin/setup/start` 返回 mock QR(测试时 iLinkClient 注入 mock)

- [ ] **B4-S4: Commit**

  ```bash
  git add packages/zai/src/server/routes/weixin.ts \
          packages/zai/src/shared/{weixin.ts,settings.ts} \
          packages/zai/src/server/routes/index.ts
  git commit -m "feat(zai): weixin-bot B4 — REST API + zaiSettings schema"
  ```

---

### B5 — QR 登录流程

**Goal:** `hermes gateway setup` 配套的 weixin 子流程,允许用户扫码登录获取 token。CLI wizard + Web UI 两条路径都要支持,Web UI 走 setup/* 接口,CLI 走 `bun / tsx` 启临时 wizard(可选,B5 阶段先做 Web UI)。

**Files:**
- Modify: `packages/zai/src/server/services/weixinBot/WeixinBotManager.ts`(加 `startSetup` / `pollSetup` / `cancelSetup` / `confirmSetup`)
- Test: `packages/zai/test/server/weixinBot/WeixinBotManager.setup.test.ts`

**关键 Step:**

- [ ] **B5-S1: iLinkClient QR 端点**

  ```ts
  async getBotQrcode(): Promise<{ qrcode_id: string; qrcode_url: string }>
  async getQrcodeStatus(qrcodeId: string): Promise<{
    status: 'waiting' | 'scanned' | 'confirmed' | 'expired'
    account_id?: string; token?: string; base_url?: string
  }>
  ```

- [ ] **B5-S2: WeixinBotManager.setup state machine**

  - `startSetup()` →
    1. 调 `iLinkClient.getBotQrcode()`
    2. 暂存 `activeSetup = { qrcodeId, qrcodeUrl }`
    3. 启动后台 `pollSetupLoop`(每 2s 调 `getQrcodeStatus`)
  - `pollSetup` 命中 `confirmed` → 写 `~/.zai/weixin/accounts/<accountId>.json`,自动 `connect()`
  - `pollSetup` 命中 `expired` → 自动 `startSetup()` 重新拉(最多 3 次)
  - `cancelSetup()` 取消 `pollSetupLoop` + 清 `activeSetup`

- [ ] **B5-S3: 凭据持久化**

  ```ts
  // ~/.zai/weixin/accounts/<accountId>.json
  {
    "accountId": "a5ace6fd482e@im.bot",
    "token": "...",
    "baseUrl": "https://ilinkai.weixin.qq.com",
    "createdAt": "2026-08-16T10:00:00Z",
    "lastConnAt": "2026-08-16T10:01:00Z"
  }
  ```

  写入用 `writeFile` + `fsync` + `rename`(原子),`mode: 0o600`(windows 跳过)。

- [ ] **B5-S4: 单元测试**

  - mock iLinkClient,`startSetup` → `pollSetup` 命中 confirmed → 凭据写入 + connect 调用
  - mock expired,自动重试 3 次,第 4 次超限放弃
  - `cancelSetup` 后 `pollSetupLoop` 停止

- [ ] **B5-S5: Commit**

  ```bash
  git add packages/zai/src/server/services/weixinBot/WeixinBotManager.ts
  git commit -m "feat(zai): weixin-bot B5 — QR 登录 wizard + 凭据持久化"
  ```

---

### B6 — Vite 前端 UI

**Goal:** 在 SettingsDrawer 增加「微信」tab,展示状态 + 启停按钮 + QR 码 + 设置表单 + 实时入站消息预览(SSE 订阅)。

**Files:**
- Create: `packages/zai/src/web/src/components/WeixinBotPanel.tsx`
- Create: `packages/zai/src/web/src/components/WeixinBotPanel.test.tsx`
- Create: `packages/zai/src/web/src/lib/api/weixin.ts`
- Modify: `packages/zai/src/web/src/components/SettingsDrawer.tsx`
- Modify: `packages/zai/src/web/src/components/StatusDot.tsx`(可选)

**关键 Step:**

- [ ] **B6-S1: apiRpc stub**

  `lib/api/weixin.ts` 用 `apiRpc` (已有类型化 RPC 工具,见 `docs/superpowers/specs/2026-08-16-rpc-type-safe-client-stubs.md`):
  ```ts
  export function weixinStatus(): Promise<WeixinStatusResponse>
  export function weixinConnect(req: WeixinConnectRequest): Promise<void>
  export function weixinDisconnect(): Promise<void>
  export function weixinReload(): Promise<void>
  export function weixinSetupStart(): Promise<WeixinQrcodeResponse>
  export function weixinSetupPoll(qrcodeId: string): Promise<WeixinSetupStatusResponse>
  export function weixinSetupCancel(): Promise<void>
  ```

- [ ] **B6-S2: WeixinBotPanel 组件**

  4 个 section:
  1. **StatusBanner**:连接状态 / `accountId` / `lastError`(若失败)/「重连」按钮
  2. **SetupSection** (未配置时):「连接微信」按钮 → 调 `weixinSetupStart()` → 渲染 `qrcodeUrl` (img 标签) + 轮询 `weixinSetupPoll(qrcodeId)`(每 2s) → 命中 `confirmed` 自动 reload
  3. **SettingsForm**(已配置时):dmPolicy / groupPolicy / allowFrom / 各种 delay / 各种阈值,保存时 `weixinReload()`
  4. **InboxPreview**(已连接时):订阅 SSE `prompt.ask` + `sessionId` 命中 `weixin:*` 的事件,展示最近 50 条入站消息(用户头像 + 文本 + 时间)

- [ ] **B6-S3: SettingsDrawer 集成**

  `SettingsDrawer.tsx` 新增 `Tabs` item「微信」,`activeKey === 'weixin'` 渲染 `<WeixinBotPanel />`,用 `React.lazy` 避免主 tab 拖慢首屏。

- [ ] **B6-S4: 单元测试**

  - 组件测试:`weixinStatus` mock → component renders status banner
  - Setup 流程:点击「连接微信」 → 出现 QR(URL 渲染成 img) → mock poll 返回 confirmed → 状态切换
  - Settings 表单提交 → `weixinReload` 调用

- [ ] **B6-S5: Commit**

  ```bash
  git add packages/zai/src/web/src/components/WeixinBotPanel.tsx \
          packages/zai/src/web/src/components/WeixinBotPanel.test.tsx \
          packages/zai/src/web/src/lib/api/weixin.ts \
          packages/zai/src/web/src/components/SettingsDrawer.tsx
  git commit -m "feat(zai): weixin-bot B6 — Vite 前端 UI(状态/QR/设置/入站预览)"
  ```

---

### B7 — 真实浏览器验收(强制)

**Goal:** 走真实 zai 实例 + 真实微信扫码,验证端到端流程。

**先决条件:**
- B0–B6 全部 commit
- `pnpm -r exec tsc --noEmit` 通过
- 全部 Vitest 文件通过:`pnpm --filter @zn-ai/zai test test/server/weixinBot/ test/server/routes/weixin.test.ts`

**Step:**

- [ ] **B7-S1: 启动独立 dev 实例**

  ```bash
  # 端口显式指定,避开 920x 正式服务与 8101 已占用实例(参见根 AGENTS.md 端口约束)
  pnpm --filter @zn-ai/zai dev -- --port 8201 --api-port 7716
  ```

  启动日志须含 `weixin: state=disabled, configured=false`(默认未启用)。

- [ ] **B7-S2: Web UI 走 QR 登录**

  用 `/ego-browser` skill 启动真实浏览器,访问 `http://localhost:8201`:
  - 打开 Settings → 微信 tab
  - 点「连接微信」 → 后端 `getBotQrcode` → 终端/页面渲染 QR
  - 用真实微信手机扫码确认
  - 状态从 `waiting` → `scanned` → `confirmed` → `connected`
  - `accountId` 显示出来(如 `a5ace6fd482e@im.bot`)

- [ ] **B7-S3: 端到端 DM 收发**

  - 在被扫码的微信里发文本消息 → Web UI 应在 1-2s 内出现该消息(InboxPreview)
  - Web UI Agent 输入框发一条普通消息 → 微信里收到回复
  - 模拟图片场景:微信发图片 → zai 收到 → agent 处理 → 微信收到文字回复(图片入库到 `~/.zai/weixin/media/`)
  - 模拟 media 出站:agent 触发 `send_image` 工具 → 微信收到 native image(走 CDN 上传)

- [ ] **B7-S4: 异常路径**

  - 杀掉 dev 实例,再起一个 → 验证 AccountLock 拒绝双实例(`proper-lockfile` 报清晰错误)
  - 一天后 session 过期(模拟 `errcode=-14`),适配器 warn + 暂停 10 分钟(Web UI 状态: `reconnecting(lastError=session expired)`)
  - 网络断 5s → abort 后恢复 → poll 续传

- [ ] **B7-S5: 文档**

  - `packages/zai/AGENTS.md`(若存在) 增 weixin-bot 章节(启动 / 配置 / 已知约束)
  - `docs/DEVELOPMENT_REFERENCE.md` 增第 15 章(微信机器人适配器,简述架构 + 集成点)
  - 主仓库 `README.md` 索引 `docs/superpowers/plans/2026-08-16-zai-weixin-bot-platform.md`(若有)

- [ ] **B7-S6: 收尾 Commit**

  ```bash
  git add docs/ packages/zai/AGENTS.md
  git commit -m "feat(zai): weixin-bot — 真实浏览器验收 + 文档"
  ```

---

## 验收清单

### 功能

- [ ] zai 启动日志包含 `weixin: state=...` 一行
- [ ] 默认未配置时,`GET /api/weixin/status` 返回 `{ configured: false, enabled: false, state: 'disabled' }`
- [ ] 配置 + 启用后,adapter 启动,`state` 切换为 `connected`
- [ ] 微信 DM → zai SSE 推送 `prompt.ask` 事件(前端 InboxPreview 可见)
- [ ] zai SSE 推送 `runtime.delta` → 微信收到分块文本
- [ ] 微信发图片 → zai 收到并解密 → agent 处理 → 微信收到回复
- [ ] agent 触发 `send_image` 工具 → 微信收到 native image
- [ ] 重启 zai 实例,adapter 从磁盘恢复 syncBuf / contextToken,无消息丢失
- [ ] 同时跑两个 zai 实例(同 token),第二个启动时 `AccountLock` 报错并退出

### 安全

- [ ] SSRF 防护:`assertSafeCdnUrl('https://evil.example.com/foo')` 抛 `Error`
- [ ] 账号锁文件 mode 0600(windows 跳过)
- [ ] token 不写入 `~/.zai/settings.json`,仅存 `~/.zai/weixin/accounts/<id>.json` 并 0600
- [ ] 启动日志不打印 token / 完整 accountId(_safe_id 截断到 8 字符)

### 性能

- [ ] long-poll 35s,无消息时 CPU 占用 < 1%
- [ ] 文本 debounce 3s 静默期,连发 5 条合并为 1 个 prompt.ask
- [ ] 限流 `-2` 1 次触发后 30s 冷却,期间 send 立即失败而非堆积
- [ ] 4000 字符以上长回复自动分块,chunk 间 1.5s,WeChat 限流不触发

### 可靠性

- [ ] `errcode=-14` session 过期:暂停 10 分钟 + 自动续期(剥 token 重试)
- [ ] 网络断 5s → AbortController 触发 → 重连后无消息丢失
- [ ] zai 进程 SIGTERM → adapter 优雅 disconnect(in-flight fetch abort,锁释放)
- [ ] iLink Bot 启动警告日志:WARN about group policy 通常不生效(明示 iLink 限制)

### 测试覆盖

- [ ] `iLinkClient.test.ts` ≥ 6 个 case(每个端点至少 1 个 success + 1 个 error)
- [ ] `MediaCrypto.test.ts` ≥ 4 个 case(round-trip + 非法 key + SSRF 拒绝)
- [ ] `WeixinAdapter.inbound.test.ts` ≥ 5 个 case(dedup / access policy / debounce / media)
- [ ] `WeixinAdapter.outbound.test.ts` ≥ 5 个 case(分块 / 重试 / 限流熔断 / CDN 上传)
- [ ] `WeixinBotManager.test.ts` ≥ 4 个 case(启动 / 停止 / 订阅 / 失败容忍)
- [ ] `routes/weixin.test.ts` ≥ 4 个 case(supertest)
- [ ] `WeixinBotPanel.test.tsx` ≥ 3 个 case(渲染 / QR 流程 / 表单)
- [ ] `pnpm -r exec tsc --noEmit` 通过
- [ ] 全部 Vitest 通过(`pnpm --filter @zn-ai/zai test test/server/weixinBot/ test/server/routes/weixin.test.ts`)

### 文档

- [ ] `docs/superpowers/plans/2026-08-16-zai-weixin-bot-platform.md` 本文件落地
- [ ] `packages/zai/AGENTS.md` 增 weixin-bot 章节
- [ ] `docs/DEVELOPMENT_REFERENCE.md` 增 weixin-bot 概览(章节 15)
- [ ] `website/docs/...` 若有外部文档站,跟随同步(运行规范)

---

## 已知风险与权衡

1. **iLink Bot 身份限制**:QR 登录后是 `...@im.bot` 身份,通常无法被加进普通微信群,group policy 失效。文档与启动日志必须显式说明,避免用户以为 Hermes 的 group policy 行为会复制过来。**trade-off**:没有 enterprise 微信 (WeCom) 的权限,但保持 zero-cost(无备案)。
2. **微信不接受消息编辑**:WeChat 客户端不暴露 edit API,导致 iLink 也不支持。**后果**:zai 的流式输出 (`runtime.delta` 多次)只能做 send-final-only 或 send-many-chunks;前置 SSE 仍然流给 Web UI(原用户体验保留),微信侧只看到最终分块结果。**trade-off**:牺牲微信侧"打字机"体验,换来协议兼容性。
3. **同进程 vs 子进程**:选择同进程启动 `WeixinBotManager`,简单 + 共享 Runtime + 共享 eventBus。**风险**:WeixinBot 长跑 task 阻塞(`_pollLoop` CPU 0%)但内存占用 ~10-20MB,集成在 zai 进程内可接受;若未来要拆出去(独立部署),需要补 IPC 通信(SSE 跨进程 / Unix socket)。**何时回头**:B7 真实验证后,若发现微信适配的长跑失败会拖垮 zai 主进程,改成独立子进程 + 通过 HTTP 复用主进程 eventBus。
4. **CDN 白名单**:仅 7 个 host 硬编码,不能下载用户在微信里直接发的 URL(因为 iLink 总会给 `encrypted_query_param` + `aes_key` 走内部 CDN)。**例外**:已被未来微信更新加入新 CDN(如 `imgwx.qq.com`)时,白名单要扩。**何时回头**:任何"图片下载失败"用户报告都先看是不是白名单漏了。
5. **协议细节与 hermes 同步**:本 plan 翻译自 hermes-agent 2026-07-04 版本,如果上游 iLink 协议升级(端点 URL、字段名、错误码),zai 适配器需要同步升级。**缓解**:B0 阶段把 iLink 协议 zod schema 全部集中在 `iLinkTypes.ts`,升级时只改这一处。
6. **Agent loop 风险**:把微信入站当普通 prompt 派发到 agent runtime,意味着 agent 可能因微信消息中的恶意内容执行工具调用(读文件 / 写文件)。**缓解**:zai 现有 `permissionMode` 体系 (`oss/localdev/sandboxed/...`) 已经覆盖;微信入口默认走 `permissionMode=localdev` (与 Web UI 入口一致),与 Web UI 同样的安全保证。**何时回头**:B7 真实验证时检查 `~/.zai/permissions.log` 是否有"微信源"的可疑工具调用。

---

## 关联文档

- `docs/DEVELOPMENT_REFERENCE.md` — zai 总体架构(章节 1-3)、SSE 事件通道(章节 5)、RPC 类型化 stub(章节 14)
- `docs/superpowers/specs/2026-08-16-rpc-type-safe-client-stubs.md` — `apiRpc` 客户端 stub 规范
- `docs/superpowers/specs/2026-08-16-command-lifecycle-events.md` — `command.run` / `command.done` 事件埋点
- `docs/superpowers/plans/2026-07-15-zai-agent-core-plugin-runtime.md` — 插件 runtime 计划,层叠参考
- `docs/superpowers/specs/2026-07-19-sse-state-push-design.md` — SSE 状态推送设计
- 上游参考实现:`~/code/hermes-agent/gateway/platforms/weixin.py` (2379 行) + `gateway/platforms/base.py` + `gateway/run.py` (8422 接入)
