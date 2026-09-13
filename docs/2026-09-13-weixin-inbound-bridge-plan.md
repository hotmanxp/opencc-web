# opencc-web 微信消息本地通信打通方案

> **目标**:让 opencc-web (zai) 能通过微信私聊消息驱动本地 agent runtime —— 用户在微信里发消息,zai agent 在本机执行(读文件 / 跑 bash / 调工具),回复回到微信。
>
> **前置事实**:`weixinBot` 模块的**协议层已完整实现**(iLink 长轮询、媒体解密、去重、出站分块、QR 登录、REST 路由、Web 面板),但**入站消息从未接入 agent 运行时**。原实施 Plan 的 B3 阶段(双向桥)只做到 `eventBus.emit`,后续无人消费。
>
> **调研基线**:`opencc-web` HEAD (`main`, 2026-09-13)、`hermes-agent` (Nous Research, Python 参考实现)。
>
> **路径规范**:除另注,所有 `path:line` 相对 `/Users/ethan/code/opencc-web/`。

---

## 1. 结论摘要

### 1.1 两个独立断点

| 症状 | 根因 | 证据 |
|---|---|---|
| **"收不到"** | `initAgentRuntime` 里的 `weixinBotManager.start()` **被整段注释掉**。进程启动后 adapter 不会自动 connect;只有手动 `POST /api/weixin/connect` 或 QR 确认后才启动 | `packages/zai/src/server/services/agentRuntime.ts:797-810` |
| **"处理不了"** | 即便 adapter 已连接、消息已解析,`_onInbound` **只做一件事** —— `eventBus.emit({type:'weixin.inbound'})`。全仓库**无任何生产代码订阅此事件**,也没写进 `SessionInbox` / `commandQueue` / runtime | `WeixinBotManager.ts:354-375`;`grep -r 'weixin.inbound' src/` 仅命中测试与 Web 面板 |

**次生断点**:

- `DEFAULT_DEPS.getSettings: () => null`(`WeixinBotManager.ts:60-73`)—— 生产从未把 `zaiSettings.weixinBot` 读进来,导致 `settings.json` 里的 `dmPolicy` / `allowFrom` / `groupPolicy` 在生产**完全不生效**,只能靠 `accounts/<id>.json` 兜底启动。
- **出站是死代码路径**:`_subscribeOutbound` 订阅 `runtime.delta/done/started` 并按 `weixin:<acct>:` 前缀过滤(`WeixinBotManager.ts:379-419`),但**没有任何 turn 会以该 sessionId 运行**,事件永不产生。
- **群消息默认全丢**:`groupPolicy` 默认 `disabled`(`shared/weixin.ts:21`),群消息在 `accessPolicy.ts:66-78` 直接拒收。
- **重启不恢复**:`lastConfirmedCreds` 是内存态(`WeixinBotManager.ts:99`),自动 start 又已注释。
- **schema 不一致**:`shared/settings.ts:170-186` 的 `weixinBot` 段缺 `ilinkUserId`,而 `shared/weixin.ts:32` 有 —— 该字段是 iLink session 鉴权必需项(缺了会 `ret=0 msgs=0` 假象成功,见 `WeixinBotManager.ts:204-214` 注释)。

### 1.2 方案骨架

**核心判断:不要新造注入通道。** zai 已经有一条成熟的「外部事件 → agent turn」通路,`SubagentNotifier`(子 agent 完成)、cron fire、dsh bridge 都走它:

```
外部消息 → getSessionInbox(sid).followup(sid, msg) → wake → runNextInQueue → runQueryLoop → vendor query()
```

微信入站只需要接进这条通路,并补三件现有通路没覆盖的事:**配对鉴权**、**消息不丢**、**失败回执**。

```
微信用户
  │
  ▼
iLink getUpdates (35s 长轮询)                    WeixinAdapter.ts:301-381  ✅ 已实现
  │
  ▼
WeixinAdapter._processMessage                      ✅ 已实现
  ├─ messageId 去重 / 内容指纹二次去重              WeixinAdapter.ts:419,461-465
  ├─ evaluateAccessPolicy (DM/群 策略)              WeixinAdapter.ts:425-435
  ├─ 媒体下载 + AES-128-ECB 解密落盘                 WeixinAdapter.ts:526
  └─ debounce(3s/5s) → _emit                       WeixinAdapter.ts:483-505
  │
  ▼
WeixinBotManager._onInbound                        ⚠️ 只 emit，需扩展
  ├─ eventBus.emit('weixin.inbound')  ──SSE──► Web 面板   （保留，观测用）
  └─ 【新增】WeixinInboundBridge.deliver(msg)
        ├─ 【新增】配对鉴权 (WeixinPairingStore)          P1
        ├─ 【新增】conversationKey → zai sessionId 映射   P0
        ├─ 【新增】CwdStore.set(sid, getServerCwd())
        ├─ 【新增】消息落盘 pending（崩溃重放）            P2
        └─ getSessionInbox(sid).followup(sid, msg)        P0  ★ 注入点
              │
              ▼  (idle) nextTurn + wake        (busy) nextStep
              ▼
        runNextInQueue → runQueryLoop → vendor query()       agent.ts:963,1092
              │
              ▼
        runtime.started / delta / done  ──eventBus──►
              │
              ▼
        WeixinBotManager._subscribeOutbound（改为按映射表反查 chatId）  P0
              ├─ started → sendTyping('start')
              ├─ delta   → 累积 buffer
              ├─ done    → sendText(buffer) + sendTyping('stop')
              └─ 【新增】error/aborted → 回执错误文案                P0
              │
              ▼
        WeixinAdapter.sendText → iLink sendmessage                ✅ 已实现
              │
              ▼
          微信用户看到回复
```

---

## 2. 关键设计决策

### D1. conversationKey → zai sessionId 用**持久化映射表**,不要把 `weixin:...` 直接当 sessionId

**现状 intent**:`_onInbound` 生成 `sessionId = weixin:<accountId>:<chatType>:<chatId>`(`WeixinBotManager.ts:356`),注释也按这个设计。

**问题**:zai 全仓库对 sessionId 的隐含契约是 `sess-<uuid>` / 字符集 `[a-z0-9-]`,且有代码显式依赖:

| 依赖点 | 证据 |
|---|---|
| transcript 文件名直接拼 sessionId | `legacyTranscriptStore.ts:75` `filePathFor` → `${sessionId}.jsonl` |
| sanitize 假设字符集已是 `[a-z0-9-]` | `compat/taskListStore.ts:59` 注释明写 |
| 前端 session 列表 / URL / 各种 sanitize | 全链路 |

带 `:` 的 sessionId 会一路漏到文件名、URL、前端 key。**取舍**:引入映射表换正确性。

**设计**:

```ts
// 新增 services/weixinBot/WeixinSessionMap.ts
// 持久化 ~/.zai/weixin/sessions.json  (mode 0600)
interface WeixinSessionBinding {
  conversationKey: string   // `${accountId}:${chatType}:${chatId}`
  sessionId: string         // `sess-${randomUUID()}`
  cwd: string               // 绑定的 project cwd
  accountId: string
  chatType: 'dm' | 'group'
  chatId: string
  senderId: string          // 最近一次发送者（用于展示）
  createdAt: number
  lastActiveAt: number
}

class WeixinSessionMap {
  resolveOrCreate(msg: InternalWeixinMessage, cwd: string): WeixinSessionBinding
  lookupByConversationKey(key: string): WeixinSessionBinding | null
  lookupBySessionId(sessionId: string): WeixinSessionBinding | null   // 出站反查
  touch(sessionId: string): void
}
```

**收益**:
- sessionId 符合全仓库约定,transcript / Web UI / 前端零特判。
- **出站反查是 O(1) 精确匹配**,替换掉现在 `sid.split(':').slice(3).join(':')` 的脆弱 hack(`WeixinBotManager.ts:390`)。
- 「这个微信对话绑定到哪个 project cwd」有了显式落点 —— 直接决定 Web UI 里能不能看到这个对话。
- 重启后同一微信用户继续同一个 session(对话历史延续),而不是每次重启新开。

### D2. 注入用 `followup` + `form: 'message'`,**绝对不要用 `form: 'steer'`**

`SessionInbox` 的双车道语义(`sessionInbox.ts:90-115`):

| 方法 | idle 行为 | busy 行为 |
|---|---|---|
| `followup` | 入 `nextTurn` + wake → 起新 turn ✅ | 入 `nextStep`,不 wake |
| `steer` | 入 `nextStep` + wake | 入 `nextStep`,不 wake |
| `inject` | 入 `nextStep`,不 wake | 同 |

**关键陷阱**:`promoteNextStepToNextTurn(sid, {skipSteer: true})`(`busyFlush.ts:66-79` / `sessionInbox.ts:159-184`)是 turn 结束时的兜底提升,但它**显式跳过 steer 消息**:

> `sessionInbox.ts:166-170` —— "steer 的设计意图是 '等下次 user prompt 时让 LLM 看到',不应被 promote 触发立即新 turn"

这条语义对 `routes/agent.ts:2251` 的 `/queue/steer` endpoint 是对的(用户已经在线,下条 prompt 自然会带上)。**但对微信用户是致命的**:微信用户发完消息就等回复,如果他这条消息落在 busy 窗口且 turn 恰好 end_turn,消息会卡在 `nextStep` **直到该用户下次主动发消息** —— 表现为「消息石沉大海」。

**结论**:微信入站消息用 `source = { kind: 'user', form: 'message' }`,非 steer。这样:
- idle → `nextTurn` + wake → 立刻起 turn ✅
- busy → `nextStep` → vendor 下次 API call 的 `drainInboxReminder` prepend(agent 在当轮就能看到)✅
- busy 且 turn 随即结束 → `runQueryLoop` finally 的 `flushSessionInboxNextStep`(`agent.ts:1839`)提升到 `nextTurn` + wake → 起新 turn ✅

**必须配套改渲染器**:`inboxReminder.ts:126-151` 的 `renderBullet` 对未识别 `kind` 走兜底 `- ${kind} / ${form}: ${truncate(content, 200)}` —— 200 字截断 + "system events occurred" 语气。用户消息被这么处理是不可接受的。需加 `kind === 'user'` 分支,渲染成高显著度块(参照 `renderSteerBlock` 的 `<user-steer>` 措辞强度)。

### D3. Web UI 可见性:复用 `displayText` 机制,**不改 runQueryLoop**

当前 inbox 注入的 prompt 以 `isMeta: true` 落盘(`agent.ts:1216` `cmd.displayText || cmd.fromInbox ? {isMeta:true} : undefined`),前端 `loadTranscriptMessages` 按 isMeta 跳过 —— **微信用户的话在 Web UI 里会完全看不见**,只看到 assistant 的回复。

**解法(零核心改动)**:`runQueryLoop` 对 slash 命令的双消息形态已经解决了这个问题(`agent.ts:1204-1216`):

```ts
if (cmd.displayText) await appendVisibleUserMessage(store, sessionId, cmd.displayText, ctx)  // 可见行
await appendUserMessageV2(store, sessionId, userContent, 0, null, ctx, { isMeta: true })      // 完整内容 meta
```

只要在 `InboxMessage` 加可选 `displayText`,并让 `inboxToPendingPrompt`(`agent.ts:1012-1022`)把它透传进 `PendingPrompt.displayText`:
- **可见行** = 微信用户原始文本 → Web UI 正常显示为用户消息 ✅
- **meta 行** = 渲染后的完整 prompt(含发送者头、媒体路径)→ LLM 看到结构化上下文 ✅

改动量:`InboxMessage` +1 可选字段、`inboxToPendingPrompt` +1 行。

### D4. 出站必须补 `runtime.error` / `runtime.aborted` 回执

现状 `_subscribeOutbound` 只处理 `started` / `delta` / `done`(`WeixinBotManager.ts:385-418`)。**agent 出错或被中断时,微信用户永远收不到任何反馈**,只能干等。

需补:
- `runtime.error` → `sendText(chatId, renderErrorForWeixin(event))`,按 `error.category` 给不同文案(`rate_limit` / `auth` / `internal`),不透传原始堆栈(泄露本机路径/密钥风险)。
- `runtime.aborted` → 回「已中断」。
- `runtime.done` 但 buffer 为空且未发过任何内容 → 回一条兜底提示,避免静默。

### D5. 配对鉴权是**前置阻断**,不是可选优化

现状 `accessPolicy.ts:53-55`:`dmPolicy: 'pairing'` 直接 `return { allowed: true }` —— 注释写的是「首次扫码后接受所有 DM」。**没有配对码、没有持久化配对表、没有待批准流程**。

而 `dmPolicy` 默认值就是 `'pairing'`(`shared/weixin.ts`)。

**风险等级:高。** 个人微信号 bot 一旦被任何人加好友,对方就能驱动本机 agent 执行 `bash` / 读写文件。这不是「用户体验问题」,是远程代码执行面。

**必须做**:

```ts
// 新增 services/weixinBot/WeixinPairingStore.ts
// 持久化 ~/.zai/weixin/pairings.json (mode 0600)
interface PairingState {
  allowed: Array<{ senderId: string; displayName?: string; pairedAt: number }>
  pending: Array<{ senderId: string; code: string; requestedAt: number; expiresAt: number }>
}
```

流程:
1. 未配对用户发消息 → **不注入 agent**,回一条配对码提示:
   > 未授权。配对码 `428193`,请在 zai Web 面板「微信机器人」中确认。
2. Web 面板(`WeixinBotPanel.tsx`)显示待批准列表 + 批准/拒绝。
3. 批准 → 写入 `allowed` → 后续消息正常注入。
4. `dmPolicy: 'allowlist'` 与 pairing 的 `allowed` **合并成有效白名单**(静态配置 + 动态批准取并集)。
5. `dmPolicy: 'disabled'` 时 pairing store 不生效(硬拒)。

配对码要**限次 + 限时**(建议 10 分钟 TTL、单 senderId 最多 3 次尝试),避免被暴力枚举。

### D6. 消息不丢:落盘 pending + 幂等重放

现状 `_pollLoop` 在**派发之前**就推进游标(`WeixinAdapter.ts:363-367`),派发是 fire-and-forget(`:378`)：

```ts
const newBuf = response.get_updates_buf
if (newBuf) { syncBuf = newBuf; await this.syncStore.save(...) }   // ← 先推进
for (const m of msgs) this._processMessageSafe(m).catch(...)        // ← 再派发，不等
```

进程在派发与注入之间崩溃 → 消息永久丢。`MessageDeduplicator` 是内存 TTL(`stores/MessageDeduplicator.ts`),重启即失忆。

**设计**:
- `_processMessage` 通过鉴权后、注入前,把 `{messageId, conversationKey, text, mediaPaths, receivedAt}` 原子写入 `~/.zai/weixin/inbox-pending/<messageId>.json`。
- `followup` 返回后删除该文件。
- 启动时(adapter connect 后)扫描 `inbox-pending/`,按 `receivedAt` 顺序重放 —— 重放走注入层自身的幂等键(`id: weixin-<messageId>`),配合持久化的已处理 `messageId` 集合(可用 `inbox-pending` 的同级 `processed.json`,或直接依赖 pending 文件的删除状态)防重。
- **不要**改成「处理完再推进游标」:iLink 的 `get_updates_buf` 是服务端续读游标,推迟太久会导致下次 `getUpdates` 重复拉取大批历史。

### D7. 生产 settings 必须接线

`DEFAULT_DEPS.getSettings: () => null` 必须替换。已有同步缓存可直接用:

```ts
import { getCachedZaiSettingsSync } from '../zaiSettingsCache.js'   // zaiSettingsCache.ts:218
const DEFAULT_DEPS: WeixinBotManagerDeps = {
  getSettings: () => getCachedZaiSettingsSync().weixinBot ?? null,
  createAdapter: (settings) => new WeixinAdapter({ ... }),
}
```

同时补 `shared/settings.ts:170-186` 缺失的 `ilinkUserId` 字段(与 `shared/weixin.ts:32` 对齐)。

**注意**:`WeixinBotSettingsSchema` 的 `enabled` 默认是 **`false`**(`shared/weixin.ts:15`),所以 settings 接线后仍需用户在配置里显式 `enabled: true` 才会自动启动 —— 这是符合预期的 opt-in,不要为了方便把它改成默认 `true`。

**注意**:`token` 仍以 `~/.zai/weixin/accounts/<accountId>.json`(0600)为准,`settings.json` 里的 `token` 只是 mirror —— 不要因为 `getSettings` 接线而让过期的 settings token 覆盖 QR confirmed 的新凭据。现有 `start()` 里的无条件覆盖逻辑(`WeixinBotManager.ts:170-185`)是对的,保留。

---

## 3. 实施阶段

### P0 — 打通最小闭环(核心,必做)

**目标**:微信发消息 → agent 执行 → 回复到微信。端到端可用。

| # | 改动 | 文件 | 说明 |
|---|---|---|---|
| P0-1 | 新增 `WeixinSessionMap` | `services/weixinBot/WeixinSessionMap.ts` (新) | D1 的映射表 + 持久化 |
| P0-2 | 新增 `WeixinInboundBridge` | `services/weixinBot/weixinInboundBridge.ts` (新) | `deliver(msg)`: 查/建 sessionId → `CwdStore.set(sid, getServerCwd())` → `followup` |
| P0-3 | 扩展 `_onInbound` | `WeixinBotManager.ts:354-375` | 保留 `eventBus.emit`;追加 `bridge.deliver(msg)`;`deliver` 抛错只 warn,不影响 poll loop |
| P0-4 | 新增 `renderWeixinPrompt` | `weixinInboundBridge.ts` | 渲染发送者头 + 文本 + 媒体路径,供 LLM 消费 |
| P0-5 | 重写 `_subscribeOutbound` | `WeixinBotManager.ts:379-419` | 前缀 hack → `sessionMap.lookupBySessionId(sid)` 精确反查;补 `runtime.error` / `runtime.aborted` 回执(D4) |
| P0-6 | `InboxMessage` 加 `displayText` | `sessionInbox.ts:45-56` | D3 |
| P0-7 | `inboxToPendingPrompt` 透传 `displayText` | `routes/agent.ts:1012-1022` | D3 |
| P0-8 | `renderBullet` 加 `kind === 'user'` 分支 | `services/inboxReminder.ts:126-151` | D2 |
| P0-9 | `getSettings` 生产接线 | `WeixinBotManager.ts:60-73` | D7 |
| P0-10 | 恢复自动 start | `agentRuntime.ts:797-810` | 取消注释,改为读 settings 判 `enabled` |
| P0-11 | `settings.ts` 补 `ilinkUserId` | `shared/settings.ts:170-186` | 与 `shared/weixin.ts:32` 对齐 |

**关键代码骨架**(P0-2/P0-3):

```ts
// services/weixinBot/weixinInboundBridge.ts
import { getSessionInbox, type InboxMessage } from '../sessionInbox.js'
import { CwdStore } from '@zn-ai/zn-agent-core'
import { getServerCwd } from '../agentRuntime.js'
import { getWeixinSessionMap } from './WeixinSessionMap.js'
import { eventBus } from '../eventBus.js'

export function deliverWeixinInbound(msg: InternalWeixinMessage): void {
  const cwd = getServerCwd()
  const binding = getWeixinSessionMap().resolveOrCreate(msg, cwd)
  CwdStore.set(binding.sessionId, cwd)

  const content = renderWeixinPrompt(msg)            // LLM 看到的：带发送者头的完整上下文
  const inboxMsg: InboxMessage = {
    id: `weixin-${msg.messageId}`,                   // 幂等键：重放时同一 messageId 不重复注入
    source: {
      kind: 'user',
      form: 'message',                               // ★ 非 steer (D2)
      platform: 'weixin',
      senderId: msg.senderId,
      chatType: msg.chatType,
    },
    content,
    displayText: msg.text,                           // ★ Web UI 可见行 (D3)
    createdAt: Date.now(),
  } as InboxMessage

  // 入站回执：立刻 typing，让用户知道消息到了
  eventBus.emit({ type: 'weixin.inbound', ... } as any)   // 原有观测事件（P0-3 保留）

  getSessionInbox(binding.sessionId).followup(binding.sessionId, inboxMsg)
}

function renderWeixinPrompt(msg: InternalWeixinMessage): string {
  const lines: string[] = []
  lines.push(`<weixin-message chat-type="${msg.chatType}" sender="${esc(msg.senderId)}">`)
  lines.push(msg.text || '(empty text)')
  if (msg.mediaPaths.length > 0) {
    lines.push('')
    lines.push('Attached media (local paths):')
    // 媒体镜像到项目可读目录后给出路径，参考 P3-1
    for (let i = 0; i < msg.mediaPaths.length; i++) {
      lines.push(`- [${msg.mediaTypes[i] ?? 'file'}] ${msg.mediaPaths[i]}`)
    }
  }
  lines.push('</weixin-message>')
  return lines.join('\n')
}
```

**P0 验收**:
1. `ZAI_DEBUG=1` 启动,`~/.zai/settings.json` 配好 `weixinBot`(或先跑 QR 登录)。日志出现 `[weixin.manager] state=connected`。
2. 日志出现 `[weixin.adapter] getUpdates response: ret=0 errcode=0 msgs=N` 且 N > 0(这是关键 —— 见 §5 风险 R1)。
3. 微信发「列出当前目录文件」→ 微信收到 agent 回复。
4. 服务端日志出现 `[zai.agent.prompt] start sid=sess-<uuid>`,且 `sid` 与 `~/.zai/weixin/sessions.json` 里该会话的绑定一致。
5. 打开 Web UI,能在这个 project 的 session 列表里看到该对话,**且用户那条消息可见**(P0-6/P0-7 生效)。
6. agent 执行 `bash` 报错时,微信收到错误回执,不是静默(P0-5 生效)。
7. `pnpm --filter @zn-ai/zai run test` 全绿(现有 `test/server/weixinBot/*` 26 个测试不能回归)。

---

### P1 — 配对鉴权(安全,必做)

| # | 改动 | 文件 |
|---|---|---|
| P1-1 | 新增 `WeixinPairingStore` | `services/weixinBot/WeixinPairingStore.ts` (新) |
| P1-2 | `deliver` 前插入鉴权阻断 | `weixinInboundBridge.ts` |
| P1-3 | 未授权自动回配对码提示 | `weixinInboundBridge.ts` + `WeixinBotManager.ts` |
| P1-4 | REST: `GET /api/weixin/pairings` / `POST /api/weixin/pairings/approve` / `POST /api/weixin/pairings/reject` | `routes/weixin.ts` |
| P1-5 | Web 面板待批准列表 | `web/src/components/WeixinBotPanel.tsx` |
| P1-6 | `accessPolicy` 与 pairing 白名单合并 | `accessPolicy.ts` / `weixinInboundBridge.ts` |

**验收**:陌生微信号发消息 → 收到配对码、**agent 不被触发**(验证方式:该消息不产生 `sess-` session 的 turn);Web 面板批准后 → 同一用户再发消息正常驱动 agent。

---

### P2 — 可靠性(崩溃不丢消息)

| # | 改动 | 文件 |
|---|---|---|
| P2-1 | `pending` 落盘 + 注入后删除 | `WeixinAdapter.ts` / `weixinInboundBridge.ts` |
| P2-2 | 启动重放 `inbox-pending/` | `WeixinBotManager.ts:start()` |
| P2-3 | 持久化已处理 `messageId`(防重放重复注入) | 复用 `WeixinSessionMap` 或新增 `processedStore` |

**验收**:注入前 `kill -9` 服务 → 重启 → 该消息被重放且只注入一次。

---

### P3 — 体验增强

| # | 改动 |
|---|---|
| P3-1 | 入站媒体落地到项目可读目录(如 `<project>/.zai/weixin-media/`),并把路径写进 prompt,让 agent 能用 Read 工具读图 |
| P3-2 | `InboxMessage` 加可选 `contentBlocks`,`inboxToPendingPrompt` 透传 → 走多模态路径(`agent.ts:1171-1174` 已支持 content-block array),图片直接进 LLM 视觉输入 |
| P3-3 | 首字延迟 > N 秒时发「正在处理…」占位消息 |
| P3-4 | 长任务进度回执(agent 进入 tool 调用时更新 typing 文案) |

---

### P4 — 观测与清理

| # | 改动 |
|---|---|
| P4-1 | `WeixinAdapter.ts:302,313-319,370-374` / `iLinkClient.ts:130-134` 的 diag `console.warn` 降级为 `ZAI_DEBUG=1` 门控(现在每轮长轮询都打,生产日志会爆) |
| P4-2 | `WeixinBotManager.ts:513-522,530,564,567` 的 pollSetup diag 同样门控 |
| P4-3 | Web 面板加:会话绑定列表、最近错误、入站/出站计数 |

---

### P5 — 全局单实例锁(硬约束,必做)

**目标**:一台电脑同时只能有**一个**助手实例接收/处理/发送微信消息、与用户对接。其余实例进入 `standby`,不抢 iLink 长轮询。

> 为什么不能只靠已有的 `AccountLock`:`AccountLock` 是 **per-token**(`WeixinAdapter.ts:247`)——它保证同一 token 不被两个进程同时长轮询,但**不阻止**两台/多个实例用不同 token 或不同 `ZAI_DATA_DIR` 各收一份消息。用户要的是**机器级**唯一性,与 token/data-dir 无关。

| # | 改动 | 文件 | 说明 |
|---|---|---|---|
| P5-1 | 新增 `WeixinOwnerLock` | `services/weixinBot/WeixinOwnerLock.ts` (新) | `proper-lockfile`,锁目录固定在 **`~/.zai/weixin/locks/owner.lock`**,**不随 `ZAI_DATA_DIR` 漂移**(可用 `ZAI_WEIXIN_OWNER_LOCK_DIR` 覆盖,仅测试用) |
| P5-2 | 锁旁落 owner 元数据 | `WeixinOwnerLock.ts` | `owner.json`: `instanceId / pid / supervisorPid / port / cwd / accountId / hostname / startedAt`;`read()` 返回快照 + `live`(pid 存活性判定) |
| P5-3 | 抢锁失败 → `standby` | `WeixinBotManager.ts:start()` | acquire 失败不报错,状态置 `standby`,记 `ownerInfo`,**不启动 adapter** |
| P5-4 | 失联接管 | `WeixinOwnerLock.forceTakeover()` | 仅当持有者 `live === false` 才允许清除(防误杀活跃实例) |

**语义**:`standby` 不是错误,是**正常的第二实例待命态**——Web 面板显式区分(橙色 Tag + 持有者信息)。

**验收**:同一台机器起两个 zai 实例 → 只有一个 `state=connected`,`~/.zai/weixin/locks/owner.lock` 唯一;另一个 `state=standby` 且 `ownerInfo.pid` 指向第一个;`kill -9` 持有者后,`standby` 实例 `POST /api/weixin/owner/takeover` 能接管。

---

### P6 — supervisor 独占拉起(硬约束,必做)

**目标**:微信通道**只由 supervisor 拉起的子进程**启动,裸 `dev` / 直连进程一律拒绝。

| # | 改动 | 文件 | 说明 |
|---|---|---|---|
| P6-1 | 新增 `maybeAutoStartWeixinBot()` | `services/weixinBot/weixinRuntimeBoot.ts` (新) | `!isManagedChild()` → 返回 `supervisor_required`,**不 start** |
| P6-2 | 替换注释掉的自动启动 | `agentRuntime.ts` | 改调 `maybeAutoStartWeixinBot()` + `setWeixinServerCwdProvider(() => getServerCwd())` |
| P6-3 | 变更类 REST 全部门控 | `routes/weixin.ts` | `supervisorBlocked()`:非受管子进程 → **409** |

**判定依据**:现有 supervisor 注入的 `ZAI_SUPERVISOR_PID`(`cli/managedChild.ts` 的 `isManagedChild()`)。**复用而非新造**,`cli/supervisor.ts` 与 `instanceSupervisor.ts` 两条路径都已注入该 env。

**验收**:裸跑 `zai dev` → 面板显示 `supervisor_required`,连接受阻(409);经 `zai start`(supervisor 托管)→ 正常。

---

### P7 — owner 可观测与接管(可观测性)

| # | 改动 | 文件 |
|---|---|---|
| P7-1 | `status()` 返回 `owner` / `ownerInfo` / `metrics` | `WeixinBotManager.ts`、`shared/weixin.ts`(schema 扩展) |
| P7-2 | `GET /api/weixin/owner`、`POST /api/weixin/owner/takeover` | `routes/weixin.ts` |
| P7-3 | `GET /api/weixin/diagnostics`(会话绑定 + 计数) | `routes/weixin.ts` |
| P7-4 | 面板:持有者区块 / 待配对列表 / 诊断区块 | `web/src/components/WeixinBotPanel.tsx` |

---

## 4. 参考资料对照(hermes-agent 设计取舍)

`hermes-agent`(Python 参考实现)有同类通道,关键对照:

| 维度 | hermes 做法 | 本方案取舍 |
|---|---|---|
| 消息交给谁 | runner 注册回调 `set_message_handler`;adapter 只产 `MessageEvent` (`gateway/platforms/base.py:2768`) | 同样解耦:adapter → manager → bridge,不反向依赖 runtime |
| session key | `ns:platform:chat_type:chat_id[:thread][:participant]` (`gateway/session.py:822`) | 需要 namespace 前缀隔离,但落点改为**映射表**而非直接当 id(D1) |
| busy 分流 | `interrupt`(默认) / `queue` / `steer` 三态 (`gateway/run.py:5049,5234-5278`) | 复用 zai 现成的 `nextTurn`/`nextStep` 双车道,不引入 interrupt(会打断正在跑的 tool) |
| 崩溃恢复 | 游标先推进 + `resume_pending` + 启动重放队列 (`gateway/run.py:6218-6273`) | 沿用其 `resume_pending` 思路,但**游标推进时机不改**(D6) |
| 双层防抖 | adapter 层 3s/5s + base 层 busy 0.35s (`weixin.py:1520-1568`) | 已有 adapter 层 debounce(`debounce.ts`),busy 层 zai 的 wakeBudget 已覆盖 |
| 去重 | 内存 TTL + 文本指纹,不持久化 (`weixin.py:1412-1419`) | 同样两层,但**加持久化**(D6)—— hermes 这里是未解决的缺口 |
| 长回复切分 | `MAX_MESSAGE_LENGTH=2000` + adapter `_split_text` | 已有(`outbound.ts:splitText` + `MAX_MESSAGE_LENGTH`) |

**hermes 的已知缺口不要照抄**:其游标在派发前推进且去重表不持久化,崩溃窗口内消息会丢 —— 本方案 D6 针对性修复。

---

## 5. 风险与未验证假设

| # | 风险 / 假设 | 影响 | 处置 |
|---|---|---|---|
| **R1** | **iLink 可能要求 bot 先 outbound 一次才会路由入站消息**。代码里留了这条诊断假设:`WeixinAdapter.ts:260-270` 的 `WEIXIN_TEST_GREET=1` 就是为验证它 | 若成立,单纯启动 adapter 收不到任何消息,整个方案卡在第一步 | **P0 之前先做**:`WEIXIN_TEST_GREET=1` 启动,确认微信能收到 greet 且后续 `msgs > 0`。若成立,把 greet 固化为 connect 后的握手 |
| **R2** | `ilinkUserId` 缺失导致 `ret=0 msgs=0` 假象成功(`WeixinBotManager.ts:204-214` 注释) | 表现为「connected 但永远收不到」 | P0-11 补 schema;`start()` 已有从 `accounts/` 兜底逻辑,验证其生效 |
| **R3** | 群消息默认全丢(`groupPolicy: 'disabled'`) | 微信群聊场景不可用 | 若需要,先确认 iLink Bot 身份能否拿到群事件(`accessPolicy.ts:16` 注释本身存疑),再改 `groupPolicy` |
| **R4** | 多实例并发:同 token 两个 zai 实例 | `AccountLock` 已防(`WeixinAdapter.ts:247`) | **已由 P5 强化**:`AccountLock` 只保 token 级,挡不住「不同 token / 不同 `ZAI_DATA_DIR` 各收一份」。P5 `WeixinOwnerLock` 用固定机器级锁路径(`~/.zai/weixin/locks/owner.lock`,不随 `ZAI_DATA_DIR` 漂移)兜住「一台机器唯一持有者」 |
| **R5** | 微信消息进 agent = **远程代码执行面** | 高危 | P1 已落地(pairing 前置阻断 + 动态 allowlist),不再是「P0 上线前必须卸载 pairing」的状态。生产仍建议 `dmPolicy: 'allowlist'` 打底、pairing 仅作补充入口 |
| **R6** | 单条微信消息起一个完整 turn,`wakeBudget=3/turn` 会限流(`sessionInbox.ts:67`) | 用户连发 4 条时第 4 条不触发**额外**唤醒 | **实测判定为良性,不需要 `resetWakeBudget`**:连发时 1 条走 `nextTurn` + 唤醒,其余落在 busy/`nextStep`;即使同一 tick 内多条都进 `nextTurn`,预算耗尽只是不再多发唤醒,消息仍在 `nextTurn` 队列里,被已唤醒的 `runNextInQueue` 一并 drain。turn 结束 `clearRunning` 重置预算后,`busyFlush` 提升 `nextStep` 会再次成功唤醒 —— **无丢消息路径** |
| **R7** | Web UI transcript 可见性改动(P0-6/7)影响所有 inbox 注入路径 | subagent 通知 / cron 消息可能意外变成可见 | `displayText` 是**可选字段**,只有微信桥会传;其它调用方行为不变。`inboxReminder` 对 `<user-message>` 的独立渲染同样以 `kind==='user' && form==='message'` 为条件,subagent 通知不受影响 |

**新增硬约束(用户追加,已并入 P5/P6/P7)**:

- **机器级唯一实例**:一台电脑只能有一个助手实例接收/处理/发送微信消息 → P5。
- **仅 supervisor 拉起**:微信通道只允许由 supervisor 拉起的子进程启动,裸进程 409 → P6。

---

## 6. 测试计划

**新增单测**(`packages/zai/test/server/weixinBot/`)—— 全部已落地:

| 测试 | 覆盖 | 状态 |
|---|---|---|
| `WeixinSessionMap.test.ts` | 同 conversationKey 重复 resolve → 同 sessionId;持久化 + 重启恢复;`lookupBySessionId` 双向一致 | ✅ |
| `weixinInboundBridge.test.ts` | `deliver` → `SessionInbox.followup` 被调用且 `source.form === 'message'`(非 steer);`displayText` 透传;`CwdStore` 被设置;配对阻断 + 放行;pending 落盘/重放幂等 | ✅ |
| `WeixinPairingStore.test.ts` | 未配对 → 阻断 + 回配对码;批准后放行;码 TTL 过期;请求频率上限;revoke | ✅ |
| `WeixinPendingStore.test.ts` | `save/list/remove` 排序;`processed.json` 幂等 + TTL | ✅ |
| `WeixinOwnerLock.test.ts` | 抢锁唯一性;`standby` 元数据读取;非 live 才允许 `forceTakeover` | ✅ |
| `WeixinBotManager.test.ts` / `WeixinBotManager.setup.test.ts`(扩展) | `supervisor_required` 分支;owner 持有 → `standby`;出站 chatId 精确反查;`runtime.error/aborted` 回执 | ✅ |
| `test/server/routes/weixin.test.ts`(扩展) | pairing 路由、owner/takeover、diagnostics;非受管进程变更类接口 → **409** | ✅ |

**回归**:现有 `test/server/weixinBot/*` 与 `test/server/routes/weixin.test.ts` 全绿。

**测试隔离要点**(机器级持久化带来的坑,已解决):
- `ZAI_WEIXIN_OWNER_LOCK_DIR` 定向锁目录(否则跨测试串锁);`beforeEach` `forceTakeover()` 清残留 owner。
- 存储类测试各自 `ZAI_DATA_DIR` 指向临时目录,并在 `afterEach` `await store.flush()` —— 否则 fire-and-forget 的落盘会写进**下一个测试**的目录。
- 路由测试需 `process.env.ZAI_SUPERVISOR_PID = String(process.pid)` 才有权调变更类接口,并单测一条 409。
- 所有存储写入经 `writeChain` 串行化 + 每次唯一 tmp 文件名,消除 `.tmp` rename 竞态。

**全量实跑结果**(2026-09-13,worktree `feat/weixin-inbound-bridge`):
`pnpm --filter @zn-ai/zai run test` → **2816 passed / 9 failed / 31 skipped**。
9 条 failed 全部来自 `ContextTokenStore.test.ts` / `SyncBufStore.test.ts`,原因是这两个**存量**测试直写真实 `~/.zai/weixin/...`,整轮运行累计 delete 数(72)触发沙箱 `safe-delete` 批量阈值(50),**非代码回归** —— 单独重跑这两个文件 **9/9 全绿**。
`pnpm --filter @zn-ai/zai run typecheck`(server + cli + shared)**零错误**。

**端到端**(手动,P0 验收 7 条 + P5/P6 验收)。

---

## 7. 相关代码索引

| 主题 | 路径 |
|---|---|
| **入站桥(新增,注入核心)** | `packages/zai/src/server/services/weixinBot/weixinInboundBridge.ts` |
| **会话映射(新增)** | `services/weixinBot/WeixinSessionMap.ts` |
| **配对鉴权(新增)** | `services/weixinBot/WeixinPairingStore.ts` |
| **pending 落盘 + 幂等(新增)** | `services/weixinBot/WeixinPendingStore.ts` |
| **机器级唯一锁(新增)** | `services/weixinBot/WeixinOwnerLock.ts` |
| **supervisor 门控启动(新增)** | `services/weixinBot/weixinRuntimeBoot.ts` |
| **诊断日志门控(新增)** | `services/weixinBot/debug.ts` |
| 入站派发(P0 后接入 bridge) | `packages/zai/src/server/services/weixinBot/WeixinBotManager.ts:354-375` |
| 出站订阅(P0 重写) | `WeixinBotManager.ts:379-419` |
| manager 依赖注入 | `WeixinBotManager.ts:53-73` |
| 自动启动(P6 接管) | `packages/zai/src/server/services/agentRuntime.ts:797-810` |
| supervisor 判定 | `packages/zai/src/cli/managedChild.ts`(`isManagedChild` / `ZAI_SUPERVISOR_PID`) |
| 长轮询主循环 | `WeixinAdapter.ts:301-381` |
| 单条消息处理 | `WeixinAdapter.ts:414-499` |
| 准入策略 | `services/weixinBot/accessPolicy.ts` |
| 消息配置 schema | `packages/zai/src/shared/weixin.ts:14-33` |
| settings schema(缺 ilinkUserId) | `packages/zai/src/shared/settings.ts:170-186` |
| 持久化路径 | `services/paths.ts:41-64` |
| REST 路由 | `services/../routes/weixin.ts` |
| Web 面板 | `packages/zai/src/web/src/components/WeixinBotPanel.tsx` |
| **注入 API** | `services/sessionInbox.ts:323`(`getSessionInbox`)`:90`(`followup`)`:107`(`steer`)`:159`(`promoteNextStepToNextTurn`) |
| **注入参考实现** | `services/subagentNotifier.ts:82` |
| 唤醒处理器注册 | `routes/agent.ts:1083-1085` |
| 队列消费 + turn 启动 | `routes/agent.ts:963-1002`(`runNextInQueue`)`:1092`(`runQueryLoop`) |
| inbox → prompt 转换 | `routes/agent.ts:1012-1022` |
| turn 结束兜底提升 | `routes/agent.ts:1839` → `services/busyFlush.ts:66-79` |
| reminder 渲染 | `services/inboxReminder.ts:55,75,126` |
| CwdStore | `packages/zn-agent-core/src/compat/cwdStore.ts` |
| transcript 落盘(可见/meta 双行) | `packages/zn-agent-core/src/compat/transcript/persistence.ts:188` |
| 原实施 Plan | `docs/superpowers/plans/2026-08-16-zai-weixin-bot-platform.md`(B3 未完成) |
| vendor 消息体系总览 | `docs/2026-09-06-vendor-message-system.md` |

---

## 8. 文档元信息

- **编写日期**:2026-09-13
- **调研方法**:2 个独立 Explore agent 并行深读 + 主 agent 逐文件交叉验证关键结论(agentRuntime / sessionInbox / WeixinBotManager / WeixinAdapter / routes/agent / busyFlush / inboxReminder / legacyTranscriptStore),每个结论均可追到 `file:line`
- **实施状态**:P0–P7 **全部落地**于 worktree `/Users/ethan/code/opencc-web-weixin-inbound`(分支 `feat/weixin-inbound-bridge`,基线 `main@1e48f959`)。P5/P6/P7 为用户追加的硬约束(机器级单实例 + supervisor 独占拉起 + owner 可观测)
- **未覆盖**:未运行 iLink 真实链路(故 R1 **仍未验证** —— 上线前必须先用 `WEIXIN_TEST_GREET=1` 确认);Web 层 `src/web` 未纳入 `tsc` 构建(仓库既有状态),本次改动经临时 tsconfig 单独校验 `WeixinBotPanel.tsx` **零新增类型错误**
- **维护建议**:`sessionInbox.ts` / `routes/agent.ts` 的 `runQueryLoop` / `WeixinAdapter.ts` / `WeixinBotManager.start()` 大改时需复核 §2 的 D1–D7 与 §3 的 P5/P6 锁语义
