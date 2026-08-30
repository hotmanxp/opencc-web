# Repl 模式工具调用验证报告

**日期**: 2026-08-30
**环境**: zai dev on port 8102, ZAI_RUNTIME_CORE=repl (explicit)
**API keys**: (无 API key 配置 — dev 模式本地运行)

## Summary
- Scenarios tested: 1/1 (Scenario A 仅测)
- Tool calls work: 0/1
- Tool calls broken: 1/1

## Per-scenario 结果

### Scenario A: Bash tool (shell command)
- **Status**: FAIL
- **Tool calls observed**: 无 (LLM 无法调用工具)
- **Tool results observed**: 无
- **Final answer**: `runtime.error (internal)` — 请求在处理过程中失败
- **Evidence**: UI 显示 "runtime.error (internal)"，与 Path 1 验证结果一致
- **Notes**: 
  - 页面已就绪 (bypass on, MiniMax-M3)
  - 提交 "List the files in /tmp directory using bash ls command" 后出现 `runtime.error (internal)`
  - UI 状态: "对话中… (7s)" → `runtime.error (internal)`

## Findings

### 根因确认: `toolUseContext: {}` (空对象)

在 `packages/zn-agent-core/src/compat/repl/createReplSession.ts` 第 393 行：

```typescript
for await (const sdkMsg of query({
  messages: messages as any,
  systemPrompt: [] as any,
  userContext: {},
  systemContext: {},
  canUseTool: opts.canUseTool ?? (async () => ({ behavior: 'allow' as const })),
  toolUseContext: {} as any,  // ← 根因: 空对象 = 无可用工具
  querySource: 'server-repl',
})) {
```

代码注释明确说明 (第 365-368 行):
> "P0 minimal params — full ToolUseContext population lands in P1 once a real REPL-style AppState is plumbed through zai web."

**P0 阶段 `toolUseContext` 硬编码为空对象**，vendor 的 `query()` 虽然收到了 `canUseTool` 回调(默认 allow)，但因为 `toolUseContext` 为空，vendor 判断没有任何工具可用，因此 LLM 无法生成 tool_use。

### `agentRuntime.repl.ts` 的 `onEvent` 适配层未处理 tool_call

即使 vendor 发出 `runtime.tool_call` / `runtime.tool_result` 事件，`ReplRuntime.onEvent()` 也只转发:
- `turnEnd` → `runtime.done`
- `sessionCrash` → `runtime.error`  
- `notification` → 透传

完全不处理 `runtime.tool_call` / `runtime.tool_result`，这些事件会被丢弃。

### 次要问题: `sessionCrash` vs `runtime.error`

当前 `runtime.error (internal)` 的 UI 错误来自 vendor query 抛出异常被 `sessionCrash` 捕获，而不是来自 toolUseContext 问题。两者都会导致相同的用户可见错误。

## Verdict
**BLOCKED** — P0 design gap，tool calling 未实现是预期行为。

## Recommendation
1. **P1 优先**: 在 `createReplSession` 中从 `opts` 或 `getAppState()` 提取真实 `toolUseContext`，而不是空对象
2. **`onEvent` 适配**: 在 `agentRuntime.repl.ts` 的 `onEvent` handler 中增加 `runtime.tool_call` / `runtime.tool_result` 的转发逻辑
3. **验证路径**: 修复后重跑本验证，确保 `runtime.tool_call` 和 `runtime.tool_result` 事件正确出现在 SSE 流中
