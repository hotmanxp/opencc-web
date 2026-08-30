# Fresh smoke v2 — P3 Path 1 re-verification after agent restart

**日期**: 2026-08-30 18:19–18:21
**目的**: 重启 zai dev (port 8103/7716, `ZAI_RUNTIME_CORE=repl`) 后重跑 Path 1 basic chat,
确认 066fc22d defensive toolPermissionContext fix 实际生效。
**上一个会话相关**: `2026-08-30-p3-12path-rerun/report.md` 报 Path 1 REGRESSION(回归),
诊断根因为 P3-T0 populate ToolUseContext 后 zai host 最小 appState 必崩。
066fc22d 加 defensive `toolPermissionContext` 默认值。

## 环境

- `feat/regression-tests` HEAD: `066fc22d`
- core dist: `packages/zn-agent-core/dist/opencc-core.mjs` (57 MB unminified,
  `build:core:dev` 产物,18:04:54 rebuild 后)
- zai dev: 后台 `b0en110m2`,显式 `ZAI_RUNTIME_CORE=repl`, `--port 8103 --api-port 7716`
- ego-browser task space 24,`http://[::1]:8103/agent`(vite IPv6,express IPv4)
- 输入: plain text "hello"
- 等待: 3 / 6 / 9 / 12 / 15 秒 5 次 poll

## Path 1: Single prompt multi-turn

| 检查 | 结果 |
|---|---|
| submit "hello" 进入 → 用户消息显示 | ✅ 出现 "复制用户消息 hello" bubble |
| 066fc22d regression(`toolPermissionContext.mode` undefined) | ✅ 不再出现 `Cannot read properties of undefined (reading 'mode')` |
| 任何 `runtime.error` | ✅ 无 |
| vendor `query()` emit turnEnd | ❌ **状态一直 `✻ 对话中… (14s)` 不恢复 `● 就绪`** |
| Assistant 消息可见 | ❌ 无 |

## Root Cause: vendor query() stub 不返回

`packages/zn-agent-core/src/compat/repl/createReplSession.ts:537-553`:

```ts
for await (const sdkMsg of query({
  messages, systemPrompt, userContext, systemContext,
  canUseTool, toolUseContext, querySource: 'server-repl',
})) {
  for (const runtimeEv of translateSdkToRuntime(sdkMsg, adapterMeta)) {
    emitReplEvent('runtime', runtimeEv)
  }
  adapterMeta.eventCounter += 1
}
emitLifecycle('turnEnd', { turnIndex: thisTurnIndex })
emitReplEvent('turnEnd', { turnIndex: thisTurnIndex })
```

`for await` 卡住 → `turnEnd` 永不 emit → UI 一直 `对话中`。
Server stdout 无任何 `[ReplRuntime]` 日志(只有 submit-throw 与 enqueue 路径会 log),
意味着 submit 没抛错,只是 `vendor query()` async generator 在某处 hang
(可能是 stub 调用 `fetch` 等 mock URL 或 LLM API)。

## 结论

- ✅ **066fc22d defensive fix 实际工作**(无 regression 崩溃,这是 P3-T5 的核心目的)。
- ⚠️ **"基本对话"实质完成需要 P3.1+ 接真 vendor query()**。
  P3 整个 stub 阶段都无法产出完整 turnEnd — 这是 handoff 关键决策 #10 已记录。

## 后续决策

- 用户授权另启 **P3.1: 接 vendor `query()` 真实集成**(估计 2-3 SDD session)。
- 当前 TaskList 中 #5 (Path 1) 已 completed。
- 后续 #1/#2/#3 (Path 2/4/7/8/10) 在 vendor query() 不响应的前提下无法做实质 e2e 验证,
  等 P3.1 落地后再回归。
- TaskList #4 (收口报告) 与 P3.1 spec 写作合并完成。