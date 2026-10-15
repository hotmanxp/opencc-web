# AA Integration Handoff — zai ↔ Agents Anywhere (web.agents-anywhere.com)

> 起点:opencc-web repo 的 13 个 commit 已经把 AA 集成打到可工作状态。本文档
> 是新会话的入场引导 — 把现状、已知 bug、手动验证步骤、关键源码位置一次性讲清,
> 不需要重新调研架构。
>
> **⚠️ 先读 §13 再动手。** 本文档 §5 的"已知 bug"大部分结论已被证伪 ——
> 真正的根因是**通知类型名和 payload envelope 全部写错了,AA Web 把每一条
> 都静默丢弃**。§13 是本次会话(2026-09-27 晚)从 AA Web 自己的 JS bundle
> 里挖出的真实协议契约,照着它做才对。
>
> **最新状态(2026-09-27):** 对话链路本身(AA → WS → zai → child → LLM →
> transcript 落盘)是通的,回合完整跑完。但 **AA Web 时间线一直显示
> "暂无活动"**,根因已定位并修复(`1dc12915`),浏览器侧复验尚未完成。

---

## 0. TL;DR — 你进新会话应该做什么

1. **打开终端**:`tail -30 /tmp/zai-aa.log | grep -v weixin` 看 zai 进程当前状态
2. **打开浏览器**:https://web.agents-anywhere.com → 我的设备 → 应该有 `zai` (CLI 类型)
3. **跑下面手动测试**:
   ```bash
   TOKEN=$(grep "start token:" /tmp/zai-aa.log | tail -1 | awk '{print $3}')
   echo "$TOKEN" > /tmp/zai-token
   # 检查 AA 状态
   curl -s -H "X-Zai-Token: $TOKEN" http://127.0.0.1:9398/api/aa/status | python3 -m json.tool
   # 启动 instance (没启动的话)
   INST_ID="inst_24da77a7"
   curl -s -X POST -H "X-Zai-Token: $TOKEN" -H "Content-Type: application/json" -d '{"port":9430}' \
     http://127.0.0.1:9398/api/instances/$INST_ID/start
   # 触发 discover (AA Web "刷新" 按钮等价)
   ```
4. **验证对话能开始**:从 AA Web 创建新 session,看 child 是不是收到 prompt,turn 是不是完成

如果有问题,从「已知 bug」一节查;从「关键源码」一节读相关代码。

---

## 1. 架构(一句话 + 数据流)

zai 通过 `--aa` flag 启用 AA 桥。运行模型:

```
[你的 Mac]
└── zai root (port 9398, --aa flag) ← 单 AA WebSocket 连接 (到 AA Cloud)
    ├── InstanceSupervisor (管 N 个 child)
    │   └── child (port 9400+, 也带 --aa, 但只装 childEventReporter)
    │       └── zai agent runtime (一个 zai 实例 = 一个 AA "runtime instance")
    └── AA Client (10 个新文件 ~3000 行)
        ├── WS 心跳 / 重连 / offline buffer
        ├── RuntimeRegistry (监听 instance.changed 广播 capability)
        ├── SessionMap (zai ↔ AA session id 映射)
        ├── EventAdapter (zai eventBus → AA notification)
        ├── ReverseDispatch (AA RPC → forwardToChild HTTP)
        ├── OfflineBuffer (outbox-{port}.jsonl)
        └── ConnectionState / Pairing / Config

[AA Cloud]
└── WebSocket RPC: 每条消息 = JSON {type, id, method, params}
    - 心跳: heartbeat / auth / runtime.discover
    - 调用: runtime.start, session.create, session.send_message 等
    - 通知: timeline.itemUpsert, session.state.updated, notice.upserted

[AA Web/Mobile UI]
└── 看到你的 runtime instance + session + timeline
```

**关键约束**:每个 connector 一个 WS 连接。child 端必须转发给 root,不能直连。
zai 端通过 `ZAI_AA_PARENT_URL` env var 把 root URL 告诉 child(`instanceSupervisor.ts:296-298`)。

---

## 2. 当前进程状态(假设 zai 还在跑)

| 端口 | 用途 | 备注 |
|---|---|---|
| 9398 | zai root | 配对 + AA WS + 路由 |
| 9400+ | child instance | agent runtime + eventBus |
| ~/.zai/aa/config.json | cxt_xxx token | chmod 0600 |

环境变量:
- `ZAI_AA_ENABLED=1` — `cli/index.ts` 自动设置(从 `--aa` flag)
- `ZAI_AA_PARENT_URL=http://127.0.0.1:<rootPort>` — child 用,supervisor 自动传
- `ZAI_INSTANCE_PORT=<port>` — child 用,supervisor 自动传
- `ZAI_TOKEN=<token>` — root 和 child 共享,loopback fetch 时 `X-Zai-Token` 用

启动命令:
```bash
ZAI_DATA_DIR=/tmp/zai-aa-test pnpm start --aa --port 9398 --no-open
```

---

## 3. 关键源码(11 个文件,3000 行)

```
packages/zai/src/server/services/aaClient/
├── config.ts             zod schema + atomic write + chmod 0600
├── pairing.ts            startPairing / pollPairing / finalizePairing
├── protocol.ts           AA frame zod schemas + method whitelists
├── connection.ts         WS lifecycle + auth + heartbeat + reconnect
├── init.ts               initAaClient() — root path + child path
├── rpc.ts                typed outbound methods
├── runtimeRegistry.ts    hooks InstanceSupervisor (rti_<instanceId> format)
├── sessionMap.ts         per-port JSON persistence
├── eventAdapter.ts       zai eventBus → AA notifications
├── reverseDispatch.ts    AA RPC → child HTTP forward (核心)
├── offlineBuffer.ts      outbox-{port}.jsonl + size cap + drain
├── childEventReporter.ts child → root event forward (POST /api/internal/child-event)

packages/zai/src/server/routes/
├── aa/pairing.ts         /api/aa/pairing/* (5 endpoints, 自门禁 isAaEnabled)
├── aa/status.ts          /api/aa/status (single GET)
├── internal/childEvent.ts root receives child events
└── internal/pushAction.ts root forwards actions to child (主要逻辑)

packages/zai/src/web/src/
├── lib/aaApi.ts          TypeScript client (Result<T> 包装)
└── pages/AASettings.tsx  /manage → AA 桥 tab

packages/zn-agent-core/src/compat/runtime/
└── legacyTranscriptStore.ts  create() 接受 optional sessionId
```

`reverseDispatch.ts` 是最复杂的:
- 7 个 AA RPC handler (`runtime.discover`, `runtime.start`, `runtime.stop`,
  `session.create`, `session.send_message`, `session.steer`,
  `session.interrupt`, `interaction.respond`)
- 4 个 fs.* RPC handler (`fs.readDir`, `fs.readText`, `fs.read`,
  `fs.writeFile`)
- `portFromRuntime()` 决定 child port — 实时 TCP 探测过滤死端口
- 错误全部用 AA Pydantic 兼容 shape (`{detail: {code, message}}`)

`pushAction.ts` 是端到端对话的关键:
- `sessionCreate` case **链式调用**:`POST /api/agent/sessions` 创建
  transcript → 然后 `POST /api/agent/prompt` 入队第一条 turn — 不能只
  调第一个,否则对话挂着不动
- 字段名:`sessionId` 在顶层(不是 payload 里),`action` 用 zod enum 验证

---

## 4. 已修复的 bug(11 个,都是 schema / wire 格式)

| # | bug | 修复位置 |
|---|---|---|
| 1 | PairPollResponse schema flat vs nested | `pairing.ts:PairPollResponseSchema` 改嵌套 |
| 2 | connectorId regex 不接受 dash | `config.ts:AaConfigSchema` regex 加 `_-` |
| 3 | schema mismatch 路由 crash | `routes/aa/*.ts` try/catch + `config_error` |
| 4 | `__current__` 误判为 child | `init.ts` 用 `ZAI_INSTANCE_ID.startsWith('inst_')` |
| 5 | `ZAI_AA_PARENT_URL` 用 child port | supervisor 改用 `opts.env.ZAI_PORT` |
| 6 | capability payload 含多余字段 | `rpc.ts:announceRuntimeInventory` 只发 `{revision, capabilities}` |
| 7 | `reason` 必填 ≥1 字符 | `reverseDispatch.ts:runtimeDescriptors` 总是非空字符串 |
| 8 | `configSchema=null` 被前端过滤 | 改发 minimal JSON Schema `{type: 'object', properties: {}}` |
| 9 | `maxInstances=1` (single 必填) | 改为字面 `1` |
| 10 | `runtime.start` 用嵌套 scope | 改用 flat `{runtime, runtimeId, name, ...}` |
| 11 | `isPortListening` 在 bun 下 `require` 不可用 | 改用 dynamic `import('node:net')` |

每个 bug 都是真实 E2E 测出来的(没看 doc 推断)。**新会话不该再重新踩这些**。

---

## 5. 已知 bug / 未完成功能

### 5.1 "设备未连接" 在 AA Web 端

截图里 AA Web 显示 "zai 的 Mac mini 1 分钟前未连接"。但 zai 端
`status: connected`。原因:AA server 看到 zai WS 连上了,但 instance 没启动,
所以 `present` 字段是 false,UI 标"未连接"。

**修复**:刷新页面 + 启动 instance + 等 5 秒(zai 端 broadcast capability)。

### 5.2 "无加载运行时能力"

`runtimeTypeDescriptor.configSchema` AA 严格校验。schema 必须是合法
JSON Schema Draft 2020-12。空 `{}` 被拒,必须有 `type: 'object'` 等。

**当前状态**:已修(`reverseDispatch.ts:runtimeDescriptors` 发 minimal
schema)。AA 测过能 accept,但 zai 端没持续重发 capability,UI 可能 stale。

### 5.3 session-create-and-start 链式调用

**已修但没完整 E2E 验证**。`pushAction.ts:case 'sessionCreate'`:
1. POST /api/agent/sessions 创建 transcript(用 AA sessionId)
2. POST /api/agent/prompt 入队 first turn

如果只跑第一步,session 不会 turn,UI 挂着不动。

### 5.4 turn 完成 → event 上报 AA

`eventAdapter.ts` 把 zai eventBus 翻译成 AA notifications:
- `session.created` → `session.meta.upsert`
- `agent_task.changed` → `session.state.updated`
- `prompt.ask/approve/permission` → `notice.upserted`

**未完整 E2E**:有 turn 完成时,AA 端 timeline 是否更新需要手动测。

### 5.5 mobile send → zai receive

`session.send_message` RPC 已有 handler(`reverseDispatch.ts`),但没真触发过。
流程:mobile app 在 AA 端发消息 → AA WebSocket 推到 zai root →
reverseDispatch.handleSendMessage → forwardToChild → child `/api/agent/prompt`。
需要 user 在 AA mobile app 真发一次消息验证。

### 5.6 interactive.respond

`interactive.respond` RPC(approve/deny/input)已有 handler。但 pushAction.ts 的
`approve` 和 `inputResponse` 用了 legacy `zaiSessionId` 字段名 — 应该用
新的 `sessionId`(顶层)。**没测过**,可能有问题。

---

## 6. 手动 E2E 测试流程(下次会话第一件事)

```bash
# 1. 启动 zai (假设还没跑)
ZAI_DATA_DIR=/tmp/zai-aa-test pnpm start --aa --port 9398 --no-open &
sleep 10

# 2. 取 token + 检查 AA 状态
TOKEN=$(grep "start token:" /tmp/zai-aa.log | tail -1 | awk '{print $3}')
echo "$TOKEN" > /tmp/zai-token
curl -s -H "X-Zai-Token: $TOKEN" http://127.0.0.1:9398/api/aa/status | python3 -m json.tool

# 3. 启动 instance (create 一次就够了, 之后只 start)
curl -s -X POST -H "X-Zai-Token: $TOKEN" -H "Content-Type: application/json" -d '{}' \
  http://127.0.0.1:9398/api/instances | python3 -m json.tool | head -20
# 应该看到 AA Test Project

INST_ID="inst_24da77a7"  # 已有这个 instance
curl -s -X POST -H "X-Zai-Token: $TOKEN" -H "Content-Type: application/json" -d '{"port":9500}' \
  http://127.0.0.1:9398/api/instances/$INST_ID/start
sleep 6

# 4. 浏览器走端到端
# - AA Web 刷新
# - 我的设备 → 应该看到 zai CLI 设备 "在线"
# - 进入设备 → AGENT RUNTIME → 应该看到 "AA Test Project"
# - "可添加" 没东西(我们没有其他 runtime 类型,正常)
# - 已知 session 列表(我们的 9400 端口跑的)

# 5. 测 session.create
ego-browser nodejs -e '
const task = await taskSpace(9);
const page = task.page("p1");
await page.waitForTimeout(2000);
const r = await page.evaluate(async () => {
  const session = JSON.parse(localStorage.getItem("aa.session.v1") || "{}");
  await fetch("/api/v2/connectors/conn_I_7ObXlReW5h-w/runtime-types/discover", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.accessToken}` },
  });
  const resp = await fetch("/api/v2/sessions/create-and-start", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.accessToken}` },
    body: JSON.stringify({
      connectorId: "conn_I_7ObXlReW5h-w",
      projectId: "proj_eNwpaogtoyuw9g",
      runtime: "codex",
      content: "Hello from AA Web!",
      cwd: "/tmp/aa-test-cwd",
      runtimeOptions: { name: "AA Test Project" },
    }),
  });
  return { status: resp.status, body: (await resp.text()).slice(0, 4000) };
});
console.log(JSON.stringify(r, null, 2));
'
```

期望:返回 status 200,session 创建成功,child 收到 prompt 入队。

---

## 7. git 历史

```
0b5d333f fix(zai): preserve AA session id in sessionMap (avoid clobber)  ← 本次会话
b58be7c1 fix(zai): AA push-action wire format + followup sessionId         ← 本次会话
36aa3264 fix(zai): session-create-and-start chain + port liveness filter   ← 上次会话位置
ef47f7c8 feat(zai): session.create RPC + child sessionId injection
6f130583 feat(zai): hide cwd path in Files tree header; widen search input
7e759acf feat(zai): 3-state view mode (preview/source/edit) for .md and .html
243b7e4e feat(zai): fs.* RPC handlers — AA Web/Mobile "Files" panel works
49403b11 fix(zai): remove circular self-import in LazyMonacoCodeView
9b95ac6c fix(zai): runtime.start / runtime.stop handlers — accept flat params shape
6ebb61cc fix(zai): MonacoCodeView host div defaults to h-full w-full
a4e6f6d6 ... earlier non-AA commits
bc54abae feat(zai): add Agents Anywhere (AA) integration — opt-in via --aa flag ← 起点
```

---

## 8. 配套文档

- `docs/2026-09-27-zai-aa-integration.md` — 原始 plan(15 task 状态, 已全部完成)
- `docs/aa-ops-runbook.md` — 用户面向的 ops 文档(状态徽章解读、故障排查)
- `docs/aa-e2e-checklist.md` — 12-section 手工 E2E 检查清单

---

## 9. 调试技巧

```bash
# 看 AA WS 连接状态(实时)
TOKEN=$(grep "start token:" /tmp/zai-aa.log | tail -1 | awk '{print $3}')
while true; do
  curl -s -H "X-Zai-Token: $TOKEN" http://127.0.0.1:9398/api/aa/status | \
    python3 -c "import sys,json;d=json.load(sys.stdin);print(d['status'], 'rc=', d['connection']['reconnectAttempts'])"
  sleep 5
done

# 看哪个 instance 跑了
curl -s -H "X-Zai-Token: $TOKEN" http://127.0.0.1:9398/api/instances | python3 -m json.tool

# 看 runtime mapping
cat /tmp/zai-aa-test/aa/runtime-map.json

# 看 session mapping
ls /tmp/zai-aa-test/aa/session-map-*.json
cat /tmp/zai-aa-test/aa/session-map-9410.json  # 替换实际 port

# 直连 child 调 push-action(绕过 portFromRuntime 限制)
curl -s -m 5 -X POST -H "X-Zai-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"sessionCreate","idempotencyKey":"test1","sessionId":"sess-debug","payload":{"content":"hi","runtimeId":"codex","runtimeType":"codex","title":"","cwd":""}}' \
  http://127.0.0.1:9410/api/internal/push-action | python3 -m json.tool

# 端到端(走 AA → zai → child)
ego-browser nodejs -e '...'
```

---

## 10. 不要做的事

- **不要重命名 `cxt_xxx` token 的 redis/table 名** — AA 严格校验 `^cxt_[A-Za-z0-9_-]+$`
- **不要把 instance 的 cwd 设到 `/nope/xyz`** — weixin.instance 启动会失败
- **不要改 `runtime-map.json` schema**(没有 schema,但根 key 必须是 port string)
- **不要在同一进程内同时配对多次** — 会 409 `pairing_in_progress`
- **不要在 bun 下用 `require()`** — 用 dynamic `import('node:net')`

---

## 11. 待办(优先级)

1. **[HIGH]** 端到端验证 session.create + turn 完成
2. **[HIGH]** mobile send → zai receive 链路
3. **[MED]** `interactive.respond` 的 `sessionId` 字段名修正
4. **[MED]** push 到 origin(`git push` 13 commit)
5. **[LOW]** 移除 zai debug log(`console.error('[push-action] error:'...`)

---

## 12. 本次会话修复记录

> 续接上一会话。从 handoff §0 进场 — zai 进程已挂(`port=[object Promise]`),
> 取 token、检查 AA 状态均失败。诊断 + 修复 + 端到端验证全部跑通,共 2 commit。

### 12.1 修复 #1 — `b58be7c1 fix(zai): AA push-action wire format + followup sessionId`

3 个 wire-format / id-binding bug,任一条都会让 AA → zai 整条链路 500:

**Bug A. push-action 字段被 zod 默认 `strip` 静默丢弃。**
`reverseDispatch.forwardToChild` 把 per-action 字段平铺到请求 body 顶层,
但 `pushAction.PushActionSchema` 是 zod `z.object(...)` 默认 strip 模式,会丢
掉所有不在 schema 里的 key。结果:`sessionCreate` / `send_message` / `steer` /
`interrupt` / `approve` / `inputResponse` / `command` 全部走到 child 时 payload
变 `{}`,per-action schema 报 "content: Required" → 500。

Fix:wrap 到 `payload` envelope,并把 sessionId 同时放到顶层 `sessionId` 和
`zaiSessionId` 两个 key(用不到的那一个 zod 自动 strip)。

**Bug B. handleRuntimeStart log 显示 `port=[object Promise]`。**
`portFromRuntime` 是 async,但调用点缺 `await`。端口虽然只用在 log 里,但误导
极强(看起来像 runtime 真在用 Promise 做 port)。改成 `await`,并把"找不到 live
port" 降级为显式 `warn`(直接告诉操作员 "session.create will 404")。

**Bug C. pushAction followup 用 AA 原始 id,导致 session 入队第一条 turn 失败。**
legacyTranscriptStore.create 会自动加 `sess-` 前缀(AA 传的 `aa-sess-xxx` 变
`sess-aa-sess-xxx`),但 pushAction 的 followup /api/agent/prompt 用 AA 原始 id
命中不到 prefixed session,日志里看到
`[legacyTranscriptStore] patch: session not found: aa-sess-debug-1`(silent no-op)。
Fix:从 `/api/agent/sessions` 响应里取真实 sessionId,用那个做 followup。

验证:直接 curl child `/api/internal/push-action` — sessionCreate 返回 200
(`sess-aa-sess-debug-2`),user 消息 + assistant 回合"Hi! Ready when you are."都
落到 transcript。后续 send_message 同 session 也通。

### 12.2 修复 #2 — `0b5d333f fix(zai): preserve AA session id in sessionMap (avoid clobber)`

修了 #1 之后又发现 §5.5 mobile send 路径的两个交互 bug。

**Bug D. reverseDispatch.handleSessionCreate 把 AA 的原始 id 当 zaiSessionId 存。**
sessionMap.put 写 `zaiSessionId: p.sessionId`(AA 的 raw id,无前缀),但 child
实际存的 session 是 prefixed 的(`sess-<raw>`)。后续 `getZaiSessionId(port, aaId)`
返回 raw id → forwardToChild 用 raw id 调 `/api/agent/prompt` → 404。

Fix:从 childResp.zaiBody.sessionId 拿真正的 prefixed id,用它做 sessionMap 写。

**Bug E. eventAdapter.handleSessionCreated 反向覆盖 reverseDispatch 写好的映射。**
eventAdapter 把 zai 的 `session.created` event 当成 "zai sid == AA sid",用 event
里的 sessionId 同时写 aaSessionId 和 zaiSessionId。Event 携带的是 prefixed zai
id,所以覆盖了 #D 修复后的正确 mapping,反而让 bug 更严重。

Fix:eventAdapter 不写 sessionMap。sessionMap 是 reverseDispatch 在 RPC 入口
权威写入(它知道两个 id);eventAdapter 只负责发 AA notification(`upsertSessionMeta`)。

**附带:** 加了 `resolveZaiSessionId(port, aaSessionId)` helper,handleSendMessage /
handleSteer / handleInterrupt / handleInteractionRespond 都用它把 AA id 翻译成
zai id 再 forward。body 里也去掉了冗余的 `zaiSessionId` 字段(3rd positional arg
已经带了)。

**验证:** 浏览器打开 https://web.agents-anywhere.com,登录后在 "AA Test Project"
项目里点 "新会话",发"Hello from AA Web browser test..."。Log 显示:

```
[aa.reverseDispatch] portFromRuntime lookup rti_nJK4nB_g0dapspAZ mappings: [
  { rid: "rti_inst_24da77a7", port: 9423 },
]
[aa.reverseDispatch] portFromRuntime: live ports [ 9423 ]
[aa.reverseDispatch] session.create: sess_QfKBB5X1JN2jSg → zai=sess-sess_QfKBB5X1JN2jSg on port=9423
```

sessionMap-9423.json:
```json
{
  "sess-sess_QfKBB5X1JN2jSg": {
    "aaSessionId": "sess_QfKBB5X1JN2jSg",
    "runtimeId": "rti_nJK4nB_g0dapspAZ",
    "zaiSessionId": "sess-sess_QfKBB5X1JN2jSg",
    ...
  }
}
```

Assistant 回合成功落地 "Hello! Session is active and responding..."。

### 12.3 当前真实状态(假设新会话继续)

- zai 在跑(root 9398, child 9423 / `inst_24da77a7`),`AA Test Project` project
  已配置。AA WS 健康(`status: connected`, `reconnectAttempts: 0`)。
- AA Web → zai 整条对话链路已通:AA Web 创建新会话 → child 创建 transcript +
  第一条 turn 入队 → assistant 回合落地。
- 三个会话来测试都没问题(浏览器测试,我自己 curl 测试,以及原始 handoff 的
  端到端 sessionCreate → send_message 多轮)。

### 12.4 仍可改进(下一会话)

- `legacyTranscriptStore.create` 的 `sess-` 前缀逻辑可以去掉:直接用 AA id 作为
  zai id,只要 shape 校验通过(zod string + 合理字符)。这样 vendor 和
  legacyTranscriptStore 用同一个 id,不再分裂成两份 JSONL 文件。但需要确认 03 层
  vendor 没有自己的 id 假设。当前修复让 wire 层总是传 prefixed id 给 vendor,
  所以分裂存在但不致命。
- sessionMap 持久化 key 排序 / 文件格式 cleanup(stale session-map-{oldport}.json
  还在 `~/.zai/aa/` 目录里)。
- AA runtimeId 派生:本地用 `rti_<instanceId>`,AA server 用 `rti_<random>`。当前靠
  `portFromRuntime` fallback("任意 live port")work around,应该让 AA 用我们的 id。
  这需要 AA server 配合 — 估计在 AA 那边是 product decision。
6. **[LOW]** 写个 zai-side integration test(mock AA server)

---

**总结一句话**:架构 + 数据流已经全通,UI 端到端对话卡在两件事上 — (1) zai 没
持续 broadcast capability 给 AA(导致 UI 显示未连接/无能力),(2) session 创建
后 child 没立刻入队第一条 turn。这两个修一下,对话就完全跑通。

---

## 13. 真实 AA 协议契约(2026-09-27 从 AA Web 自己的 JS bundle 里挖出来的)

> **本节优先于 §5。** §5 的结论是在"猜"的前提下得出的,大部分是错的。
> 下面这份契约是把 web.agents-anywhere.com 的 18 个 `_next/static/chunks/*.js`
> 拉下来(`curl` 首页 → 解析 chunk 路径 → 逐个下载 → grep)反推出来的,
> 配合 `connection.ts` 里新加的 `[aa.inbound]` / `[aa.outbound]` 双向 trace
> 实测确认。**不要再靠猜协议名。**

### 13.1 AA Web 只会主动发这 5 个 session RPC

从客户端 bundle 里 grep 出的全部 `"session.*"` 字面量:

```
session.interrupt
session.refetch_required
session.send_message
session.steer
session.subscribed
```

**它从不调用 `session.discover`,也不调用 `session.sync`。**
所以 §12 里"实现 session.discover/sync 就能修好 UI"是**错的**——
时间线只能靠 zai 主动 push 通知到达。这也解释了为什么补了 5 个读 RPC
之后 UI 依然是"暂无活动"。

`session.subscribed` 是**服务端 → 客户端**的通知(告诉客户端"这个会话你已订阅"),
不是请求。

### 13.2 通知信封

```
{ protocolVersion, eventId, sequence, cursor, type, sessionId, emittedAt, payload }
```

数据都在 `payload` 里,不是平铺的。

### 13.3 zai→AA 通知类型名对照表(错的一律被丢弃)

| zai 原来发的 | AA Web 实际监听 | 修复 |
|---|---|---|
| `timeline.itemUpsert` | `timeline.item_created` / `timeline.item_updated` / `timeline.snapshot` | ✅ 已改 |
| `session.meta.upsert` | `session.meta.updated` | ✅ 已改 |
| `session.state.updated` | `runtime.state.updated` | ✅ 已改 |
| `notice.upserted` | `runtime.notice.updated` / `runtime.notice.snapshot` | ✅ 已改 |
| `session.turnEnded` | (无) | ✅ 已移除 |
| `session.inventory.begin/complete` | (无) | ✅ 已移除 |
| `protocol.capabilitiesUpdated` | (无) | ✅ 已移除 |
| `runtime.capability.updated` | ✅ 本来就对 | 保持 |

客户端 reducer 的原始判断逻辑(反推自 bundle,原文):

```js
let l = "session.meta.updated"    === t.type ? eu(t.payload.session) : null
let d = "runtime.state.updated"   === t.type ? eu(t.payload.state)   : null
let u = ("timeline.item_created"===t.type||"timeline.item_updated"===t.type)
                                    ? eu(t.payload.item) : null
let c = "timeline.snapshot"===t.type && Array.isArray(t.payload.items)
                                    ? t.payload.items.filter(ec) : null
let f = "runtime.notice.updated"  === t.type ? eu(t.payload.notice)  : null
```

**注意类型名是 `runtime.*` 而不是 `session.*` 的那几个** —— session 状态和
notice 都挂在 runtime 命名空间下。

### 13.4 TimelineItem 的字段

客户端在 `payload.item` 上读这些字段(按出现频次):
`id` / `type` / `content` / `status` / `title` / `toolName` / `sessionId` / `createdAt`

**之前 zai 发的是 `itemId` / `kind` / `text` —— 三个关键字段全错。**

`type` 取值来自 AA 的枚举(从 bundle 提取):
`system_user`、`system_time`、`assistant_activity`、`agent_call`、
`file_change`、`error_description`,外加单词的 `tool` / `context` / `hunk` / `reconnect` / `message`。

> 语义映射是推断的,还没在浏览器里逐个验过:
> - 助手正文/思考 → `assistant_activity`
> - 工具调用/结果 → `agent_call`
> - 错误 → `error_description`
> - 用户发言 → `system_user`(**这个还没接**,见 §13.6)

### 13.5 流式必须按 id 合并

`runtime.delta` / `runtime.thinking` 每来一片碎片就发一次通知,AA 端按
`payload.item.id` 合并。所以**同一个 (session, turnIndex, channel) 的所有碎片
必须共用一个稳定 id**:第一次 `timeline.item_created`,之后全部
`timeline.item_updated`(内容累加),`runtime.done` 时补一发 `status:"done"`。

踩过的坑:早期给每片碎片一个唯一 eventId → 一句话被拆成 19 个气泡。
修完又踩第二个坑:在每个 `runtime.started` 上清空累加缓冲 —— 但 zai 一个 turn
里会发多次 `runtime.started`(每个 message_start 一次),清空后下一片碎片又被当成
新流,同一个 id 发了两次 `item_created`,一条消息被劈成两半。**别清。**
buffer key 里已经含 sessionId + turnIndex,不会撞。

### 13.6 还没做的

- **用户消息没 push**。`runtime.*` 只覆盖 assistant 侧;用户发言要靠
  `system_user` 类型(或在 push-action 里主动补一条),当前 UI 里用户那半边
  可能是空的。
- `timeline.snapshot` 没实现 —— 现在全靠实时 push,刷新页面/重连后历史
  timeline 拿不回来(AA Web 也没有 `session.sync` 可调)。
- 13.4 的 type 枚举映射和 `status` 字符串("streaming"/"done"/"thinking")
  是从 bundle 推断的,需要一次真实浏览器复验。
- `runtime.capabilities` handler(`reverseDispatch.ts`)返回的 capability
  字段名同样是猜的,浏览器里 "可添加" 面板是否真的出内容待验。

---

## 14. 测试环境陷阱(踩了两次,别再踩)

**Bash 工具的 shell 是从一个 zai child 进程里派生的**,所以环境里天然带着:

```
ZAI_INSTANCE_ID=inst_915b5414
ZAI_SUPERVISOR_PID=7547
ZAI_PORT=9987
ZAI_TOKEN=...
ZAI_IS_ROOT_INSTANCE=1
```

后果:任何 `pnpm start` 起来的进程都**自认为 child**,于是
`/api/instances` 返回 `instance management not available on child`,
`pushAction` 里的 `process.env.ZAI_PORT` 也指向别的端口。

**起 zai 必须剥掉这些变量**:

```bash
cd /Users/ethan/code/opencc-web/packages/zai   # pnpm start 只在子包里有
env -u ZAI_INSTANCE_ID -u ZAI_SUPERVISOR_PID -u ZAI_PORT -u ZAI_TOKEN \
    -u ZAI_PROCESS_TITLE -u ZAI_IS_ROOT_INSTANCE \
    -u ZAI_INSTANCE_HEARTBEAT_MS -u ZAI_HEAP_RESTARTED \
    ZAI_DATA_DIR=/tmp/zai-aa-test nohup pnpm start --aa --port 9398 --no-open \
    >/tmp/zai-aa.log 2>&1 &
```

另外:重排 child 端口 → `runtime-map.json` 跟着变,但 `session-map-{port}.json`
按端口分文件,旧端口的映射就"失联"了(已用跨端口扫描兜住,见 §12.2)。
调试时**别反复重启** —— 每重启一次端口就变一次,任何已经打开的 AA Web 页面
拿到的都是过期状态。之前有一整轮排查是在跟这个幻影打架。

---

## 15. 第二轮契约修复(2026-09-27 晚 ~ 09-28 凌晨,读 AA 源码而非猜)

§13 的契约表是**从 AA Web 的 JS bundle 反推**的,方向错了好几处。下面 7 条
是直接读 `server/agent_server/**` 与 `android/**` 源码得到的,每条都对应一个
"客户端表现异常但服务端不报错"的症状。**先读服务端白名单和官方参考实现,
再动手** —— §16 记了为什么。

| # | 症状 | 真实契约 | 位置 |
|---|------|---------|------|
| 1 | 回复冻结在空气泡 | connector→server 只收 `timeline.itemUpsert`;发 `item_created/updated` 不落库 → `updatedSeq` 不分配 → 客户端 `incomingTimelineItemCanReplace` 判 `undefined >= undefined` 为 false,首推后所有流式更新被拒 | `services/connector_notifications.py:750` |
| 2 | 卡片选项与「提交」全灰 | `session.capabilities` 响应被过滤成只剩 session scope 三项,丢掉 runtime scope 的 `session.interaction.approval`;服务端 `read_session_capability_facts` 拿这份响应做准入 → `SessionRunConflictError` | `services/effective_capabilities.py`、`services/session_run.py::_require_session_capability` |
| 3 | 提交后卡片里冒出 zod 报错 JSON | handler 按真实形状实现,`install()` 入口却仍用一张臆造的 `{toolUseId, decision}` schema parse;AA 从不下发这两个字段 | `api/sessions.py::respond_interaction` |
| 4 | 目录标题显示 `~/~/code` | `displayRemotePath` 把不以 `/` 开头的路径渲染成 `"$root/$path"`,回显 `~/code` 就多一层。**但不能改成 root 相对** —— 选择器把返回值直接当已解析工作目录(`result.path` → `homePath`),`.` 会让目录不可选。只能回绝对路径 | `android/feature/files/RemoteFileNavigation.kt:112`、`ui/screens/home/NewSessionScreen.kt:453` |
| 5 | 同一目录在工作目录列表裂成两条 | `/tmp` → `/private/tmp` 符号链接;选择器给用户点的写法,child 回报 `process.cwd()` 给真实路径,两种都存进 sessionMap。写入前 `realpath` 归一 | — |
| 6 | 模型没收到图片 | `session.send_message` 的附件只带元数据 + `downloadUrl`,字节要 connector 用 bearer token 自己去取;而子进程 `pushAction` 的 `SendMessagePayloadSchema` 没有 `attachments` 字段,zod 默认 strip 直接丢掉 | `api/connector_ingress.py:449` |
| 7 | 自定义 provider 的模型看不见 | `capabilities` 只是每模型元数据,用户配的模型写在 profile 的 `model` 字段(逗号分隔)。只枚举 `capabilities` 会漏掉全部"配了但没进能力表"的模型;`findProviderIdForModel` 同样只查 `capabilities` → 选中时算不出 `providerId` | `~/.zai.json` 的 `providerProfiles` |

**回归锁**:`packages/zai/test/aaClient/protocolContract.test.ts` 逐条覆盖,
每条都验证过"换回旧写法会红"。样式类改动不适用这条(见 AGENTS.md)。

### 15.1 模型切换:已生效,但模型自报身份是旧值(仅记录,未修)

在 AA 里改模型后,会话 meta 与后续 assistant 消息的 `model` 字段都已是新值
(`MiniMax-M3.1-Flash-Preview`,`providerId` 也带上了),**实际调用确实换了**。
但模型回答"我的系统身份标注为 MiniMax-M3" —— 它引用的是系统提示词里那行
身份文案,那行在会话创建时定死,不会随 `PATCH /api/agent/sessions/:id` 刷新。

判断依据(下次排查直接用,别再猜):

```bash
TOK=$(grep -o 'start token: [a-f0-9]*' /tmp/zai-aa.log | tail -1 | awk '{print $3}')
curl -s -H "X-Zai-Token: $TOK" \
  "http://127.0.0.1:9451/api/agent/sessions/sess-sess_XXXX" \
  | python3 -c "import sys,json; d=json.load(sys.stdin)['transcript']; \
      print(d.get('meta',{}).get('model'), d.get('meta',{}).get('providerId'))"
```

`meta.model` 是权威值。**注意 `meta.model` 对不代表调用对了**:`modelCaller`
的诊断行(`[zai.modelCaller] call model=… providerId=…`)是 `logHttp(..., 'debug')`,
默认不输出,想看要开 debug 日志级别。

要修的话是改 zai 自身的身份文案注入(不是 AA 适配层),本轮决定先不动。

### 15.2 已知死代码:`portForRuntime` 里的 startInstance 兜底

`f34ae402` 加的"端口没人监听就 `supervisor.startInstance`"在当前拓扑下
**注定失败**:AA 的 RPC 跑在受管子进程里,`getInstanceSupervisor()` 报
`instanceSupervisor not initialized`(supervisor 只存在于父进程 root)。
它只会打 warn,拉不起实例。想自愈得设计一条 child→root 的"请 root 拉起实例"
通路,属于新工作。

### 15.3 harness 的进程拓扑(与 AGENTS.md 记的不完全一致)

`pnpm start --aa --port 9398` 起来的是**两级**:`bun run dist/cli/index.js start`
(root,不监听端口)+ 它 spawn 的 `zai[zai]:9398 … --managed-child`(持 9398 端口、
持 AA WS 连接、持 runtime registry)。**AA 侧的 RPC 全部由这个 child 应答。**

"AA Test Project" 实例(9451)本该由 root 的 supervisor 拉起,但
`instances.json.statuses` 为空时它不会自动起。本轮是照
`instanceSupervisor.ts::doStart` 的 spawn 配方手工拉起的,关键是:

```bash
ZAI_INSTANCE_ID=inst_24da77a7 ZAI_SUPERVISOR_PID=<root pid> \
ZAI_AA_PARENT_URL=http://127.0.0.1:9398 ZAI_AA_PARENT_PORT=9398 \
ZAI_DATA_DIR=/tmp/zai-aa-test ZAI_TOKEN=<token> \
cd /Users/ethan/code/opencc-web && nohup bun \
  /Users/ethan/code/opencc-web/packages/zai/dist/cli/index.js start \
  --managed-child --port 9451 --no-open --aa >>/tmp/zai-aa.log 2>&1 &
```

`ZAI_AA_PARENT_URL` 指向**持 AA 连接的 9398**,不是 child 自己,否则事件会
绕回自己的 Express(那里没有 registry)。手工拉起的进程 PPID=1,是已知
harness 产物,不是故障。
