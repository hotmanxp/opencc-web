# Task 1 Brief

## Task 1: 工具调用降级文案 — 消灭"裸 unknown"



**Files:**
- Modify: `packages/zai/src/web/src/pages/Agent.tsx:515`

**Interfaces:**
- Consumes: 现有 `msg.name: string | undefined`
- Produces: 渲染层看到 `toolName.replace(/^unknown$/, '未知工具')` 之类的友好降级；同时把 toolUseId 后 8 位拼进 label 方便诊断

- [ ] **Step 1: 在 Agent.tsx:515 修 ToolCallBlock 名字解析**

`packages/zai/src/web/src/pages/Agent.tsx:515` 当前是：

```tsx
const name = (msg.name as string) || 'unknown'
```

替换为：

```tsx
const rawName = (msg.name as string | undefined)?.trim() || ''
const shortId = (msg.toolUseId as string | undefined)?.slice(-8) ?? '????????'
// 兜底: 模型 SSE 流里有个别时刻 toolName 没带过来(已知 race condition,
// tool_use:start 与 content_block_start 都在抢),显示 "未知工具 (id:xxxxxxxx)"
// 比 "unknown" 强,user 至少能根据 id 复制去后端日志 grep
const name = rawName || `未知工具 (id:${shortId})`
```

- [ ] **Step 2: 同步在 useAgentStore 里把 unknown 名字的数据进 console.warn**

`packages/zai/src/web/src/store/useAgentStore.ts` 在 `upsertToolCall` 内部，`if (idx === -1)` 新建记录的分支里（约第 469–494 行），紧跟在 `name: incomingName || (msg.name as string) || 'unknown'` 那行**之后**追加：

```ts
if (!incomingName && !(msg.name as string | undefined)) {
  // 数据收集: 流式阶段 server 漏传 toolName 的次数 + 上下文 toolUseId,
  // 排查 Bug A (实时流式期间显示 "unknown") 的现场统计.
  if (typeof console !== 'undefined') {
    console.warn('[tool_unknown] runtime.tool_call 漏传 toolName', {
      toolUseId,
      sessionId: msg.sessionId,
      turnIndex: msg.turnIndex,
      ts: msg.ts,
      input: msg.input,
    })
  }
}
```

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @zn-ai/zai typecheck`
Expected: pass

- [ ] **Step 4: Commit**

```bash
git add packages/zai/src/web/src/pages/Agent.tsx packages/zai/src/web/src/store/useAgentStore.ts
git commit -m "fix(zai-web): degrade unknown tool name to readable label + diagnose warn"
```

---
