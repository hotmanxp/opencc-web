# AA Integration Handoff — zai ↔ Agents Anywhere (web.agents-anywhere.com)

> 起点:opencc-web repo 的 13 个 commit 已经把 AA 集成打到可工作状态。本文档
> 是新会话的入场引导 — 把现状、已知 bug、手动验证步骤、关键源码位置一次性讲清,
> 不需要重新调研架构。
>
> **最新状态(2026-09-27):** AA Web → zai 端到端对话已验证可用。详见 §12。
> 本次会话修了 wire-format + sessionMap 两个关键 bug(`b58be7c1` +
> `0b5d333f`),browser-agent 在 https://web.agents-anywhere.com 创建会话后
> assistant 回合成功落地。新会话进来从 §0 走,如果 zai 还活着就能直接验证。

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
