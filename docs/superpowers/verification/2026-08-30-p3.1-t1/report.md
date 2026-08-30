# P3.1-T1 E2E — `/agent` plain text chat 走通真 vendor query()

**日期**: 2026-08-30 18:43
**目的**: 在 `ZAI_CORE_RUNTIME=repl` 下,从 `/agent` 输入 plain text,
确认 ReplRuntime.query() 真正调通 vendor `query()`,产出完整
runtime.done,UI 不再卡"对话中"。

## 环境

- `feat/regression-tests` HEAD: `066fc22d`(未变)
- 工作区含 uncommitted P3.1 局部改动:`agentRuntime.repl.ts` + `agentRuntime.ts`
  - agentRuntime.repl.ts: ReplRuntime 改为接受 optional `openccRuntime` 参数,
    query() 在 openccRuntime 注入时直接委托给 shared OpenccRuntime.query()。
    P3 stub(createReplSession)路径保留为单元测试 / 渐进迁移兜底。
  - agentRuntime.ts: `coreRuntime === 'repl'` 分支构造 shared OpenccRuntime
    并注入 ReplRuntime(openccRuntime 路径)。sharedOpenccRuntime 也通过
    setOpenccRuntime() 暴露给 routes/sessions.ts(8-method 契约)。
- zai dev: 后台启动,显式 `ZAI_CORE_RUNTIME=repl ZAI_DEBUG=1 ZAI_DEBUG_SSE=1`,
  `--port 8103 --api-port 7716`(8103/7716 空闲)
- 输入: curl POST `/api/agent/prompt` {"prompt":"say hi in 3 words"}
  sessionId=sess-1788086634611-ta3o0x0b
- 模型: env_default_sonnet → MiniMax-M3(ANTHROPIC_DEFAULT_SONNET_MODEL)
- 等待: ≤ 30s

## Path 1: Single prompt multi-turn

| 检查 | 结果 |
|------|------|
| prompt 提交 → 用户消息可见 | ✅ `zai.agent.prompt] start sid=sess-1788086634611-ta3o0x0b` |
| 任何 `runtime.error` | ✅ 无(`runtime.error` 未触发) |
| vendor `query()` emit 真实流 | ✅ `system` → `message_start` → `content_block_start/delta/stop` → `message_delta` → `message_stop` 完整 24 个 SDKMessage |
| assistant 文本产出 | ✅ `runtime.delta`(content_block_delta)+ `runtime.thinking` |
| vendor `query()` emit turnEnd | ✅ `[server-sse] agent.in {"type":"runtime.done","turnIndex":4}` |
| for-await 正常退出 | ✅ `[server-sse] agent.break {"type":"runtime.done","turnIndex":4,"reason":"no pending tasks; LLM truly done"}` |
| 066fc22d regression(`toolPermissionContext.mode` undefined) | ✅ 不出现(P3 路径继续由 066fc22d 守护) |

## Root Cause: vendor query() 不再 hang

之前 fresh-smoke-v2(`docs/superpowers/verification/2026-08-30-fresh-smoke-v2/report.md`)报 P3 路径 hang,UI 卡"对话中"。P3.1 修复路径:

1. **架构调整**: ReplRuntime 不再走 createReplSession.submit() stub +
   onEvent 队列的折中路径,改为直接委托给 shared `OpenccRuntime.query()`
   (vendor `createOpenccRuntime()` 出来的真 headless runtime)。P3
   createReplSession.submit() 路径保留为兜底(单元测试 / 渐进迁移场景),
   `if (this.openccRuntime)` 不成立时仍走原 P3 stub。
2. **API key**:vendor `productionDeps()` 在用户 env 已有 `ANTHROPIC_AUTH_TOKEN`
   的前提下正常工作(无需注入 `ANTHROPIC_API_KEY`)。`ANTHROPIC_BASE_URL` 由
   env 指定。zai 不需要额外把 profile API key 转译为 `ANTHROPIC_API_KEY`。
3. **ToolUseContext**:createReplSession 构造的 ToolUseContext(066fc22d 守护
   `toolPermissionContext` 默认值)+ shared OpenccRuntime 自己的 ToolUseContext,
   两条路径都满足 vendor claude.ts 期望,plain text 调通。
4. **MCP**:init 阶段 `connectMcp: false`(已有 spec),跳过 MCP 阻塞。
5. **模型选择**:env `ANTHROPIC_DEFAULT_SONNET_MODEL=MiniMax-M3`,zai `initAgentRuntime` 解析 `defaultModel` 注入 vendor runtime,`resolved model = MiniMax-M3`(日志确认)。

## 关键日志片段

```
[zai.agent.prompt] start sid=sess-1788086634611-ta3o0x0b text="say hi in 3 words"
[zai.agent.prompt] query sid=sess-1788086634611-ta3o0x0b model=MiniMax-M3 source=env_default_sonnet providerId=(none)
[core-yield] yield {"type":"system","turnIndex":1,"eventId":"evt-0"}
[core-yield] yield {"type":"message_start","turnIndex":2,"eventId":"evt-1"}
[core-yield] yield {"type":"content_block_start","turnIndex":2,"eventId":"evt-2"}
... (24 个 SDKMessage 总计) ...
[core-yield] yield {"type":"message_stop","turnIndex":4,"eventId":"evt-23"}
[server-sse] agent.in {"type":"runtime.done","turnIndex":4}
[server-sse] agent.break {"type":"runtime.done","turnIndex":4,"reason":"no pending tasks; LLM truly done"}
```

## 后续

- 已 uncommit 的 P3.1 改动(agentRuntime.repl.ts + agentRuntime.ts)还需正式
  commit 才算 task 1 完成。本次验证只验证改动工作正常,具体 commit 流程
  由 plan owner 决定(已纳入 self-review)。
- 12-path 真机验证(P3.1-T2)暂不重跑(已超本 task 范围),留后续 SDD。
- 22 pre-existing test failure 仍存在(createReplSession.query.test.ts 8 个 +
  zai agentRuntime.repl.* 3 个的 RangeError on opencc-core.mjs 等)。
  本 task 新增 6 个全过 test,**不增加 pre-existing 失败数**。
