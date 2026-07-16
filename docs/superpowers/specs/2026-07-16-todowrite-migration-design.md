# 迁移 opencc 上游 TodoWriteTool 到 zai-agent-core + zai-web

日期：2026-07-16
状态：设计中

## 背景与目标

zai-agent-core 已经有 TaskCreate / TaskList / TaskGet / TaskUpdate 这一套**持久化任务**工具（写入 `~/.zai/tasks.json`，与后台 agent runtime 完全独立），但它和 opencc 上游的 `TodoWriteTool`（**会话内 in-memory todo 列表**）语义不同。后者有一个专用 UI —— TUI 顶部的 "8 tasks (1 done, 1 in progress, 6 open)" 状态面板，带 checkbox 状态图标，zai-web 完全没有。

本次迁移只补齐上游 `TodoWriteTool` 那一条线，**不动**现有 TaskCreate 系列。两个体系并存，各管各的：

- **TaskCreate 系列**：跨会话 / 重启保留的任务清单，zai 私有。
- **TodoWrite（本次新增）**：纯会话内 todo 列表，行为对齐上游。

## 范围

### In-scope

1. 在 `packages/zai-agent-core/src/tools/TodoWriteTool/` 注册 `TodoWriteTool`（`name='TodoWrite'`）。
2. zai-web 在对话区上方新增 `TodoZone` 组件，渲染当前 session 的 todo 列表。
3. zai-web store 新增 `todosBySession`，并把 TodoWrite 的 tool_use 排除出 messages 列表。
4. transcript loadTranscript 时从历史 assistant 消息里提取最后一条 TodoWrite 的 `input.todos` 还原当前 todo。

### Out-of-scope

- 持久化 TodoWrite 列表（不写 `tasks.json`、不写 transcript 之外的本地文件）。
- 改造现有 TaskCreate 系列工具。
- verification nudge（上游 3+ 任务完成时追加提醒跑 verification agent，zai 没有 AgentTool 子代理概念，省略）。
- TodoRead 工具（上游本身没有）。
- `isTodoV2Enabled` 这类开关。
- `shouldDefer` 标志（zai-agent-core 的工具执行模型未必支持，先不引入）。

## 设计

### 1. agent-core：工具目录结构

```
packages/zai-agent-core/src/tools/TodoWriteTool/
  constants.ts     TODO_WRITE_TOOL_NAME = 'TodoWrite'
  types.ts         TodoItemSchema / TodoListSchema (zod lazySchema)
  schema.ts        inputSchema = lazySchema(() => z.strictObject({ todos: TodoListSchema() }))
  prompt.ts        DESCRIPTION / PROMPT（照搬上游文本）
  TodoWriteTool.ts buildTool({...})
```

`TodoWriteTool.ts` 关键形态：

```ts
export const TodoWriteTool = buildTool({
  name: TODO_WRITE_TOOL_NAME,
  strict: true,
  userFacingName: () => '',
  isEnabled: () => true,
  renderToolUseMessage: () => null,    // 工具结果不进 TUI transcript 显示
  async description() { return DESCRIPTION },
  async prompt() { return PROMPT },
  get inputSchema() { return inputSchema() },
  get outputSchema() { return outputSchema() },
  async checkPermissions(input) { return { behavior: 'allow', updatedInput: input } },
  toAutoClassifierInput(input) { return `${input.todos.length} items` },
  async call({ todos }, context) {
    const appState = context.getAppState()
    const todoKey = context.agentId ?? getSessionId()
    const oldTodos = appState.todos?.[todoKey] ?? []
    const allDone = todos.length > 0 && todos.every(t => t.status === 'completed')
    const newTodos = allDone ? [] : todos
    context.setAppState(prev => ({
      ...prev,
      todos: { ...(prev.todos ?? {}), [todoKey]: newTodos },
    }))
    return { data: { oldTodos, newTodos, verificationNudgeNeeded: false } }
  },
  mapToolResultToToolResultBlockParam({ verificationNudgeNeeded }, toolUseID) {
    const base = 'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable'
    // 不带 nudge 文案，verificationNudgeNeeded 永远为 false
    return { tool_use_id: toolUseID, type: 'tool_result', content: base }
  },
} satisfies ToolDef<InputSchema, Output>)
```

注册：在 `packages/zai-agent-core/src/tools.ts`（或同等注册入口）append `TodoWriteTool`，与 TaskCreate / TaskList / TaskGet / TaskUpdate 并列。

### 2. agent-core：output schema

照搬上游 `z.object({ oldTodos: TodoListSchema, newTodos: TodoListSchema, verificationNudgeNeeded: z.boolean().optional() })`。zai-web 不消费这个 schema，只是为了与上游 wire 形态一致，便于未来 sync 上游。

### 3. zai-web：store

`packages/zai/src/web/src/store/useAgentStore.ts` 新增：

```ts
type TodoItem = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string }

interface AgentState {
  // ... 现有字段 ...
  todosBySession: Record<string /* sessionId */, TodoItem[]>
  setTodos: (sessionId: string, todos: TodoItem[]) => void
}
```

行为：
- `setCurrentSession(sid)` 不清空旧 sid 的 todo（用户切回能恢复）。
- `clearMessages()` 仅清空当前 sid 条目。
- `createNewSession()` 触发后清空当前 sid 条目（旧 sid 仍保留）。
- `loadTranscript(sid)` 末尾调用 `extractTodosFromTranscript` 把 TodoWrite 还原进 `todosBySession[sid]`。

**TodoWrite 工具结果不进 messages**：
- `upsertToolCall` 检测到 `name === 'TodoWrite'` 时**跳过**push 进 `messages`，但**不**触发 `textSegmentRev++`（不算工具边界，避免文本分段错位）。`segmentedToolUseIds` 仍要登记，避免后续重复 start 触发误 bump。
- 实时刷新：tool_use:done 到达时，解析 `input.todos` → `setTodos(sid, parsed)`。若解析失败，**静默忽略**。

### 4. zai-web：UI 组件

新增 `packages/zai/src/web/src/components/TodoZone.tsx`：

```tsx
type Props = { todos: TodoItem[] }

export function TodoZone({ todos }: Props) {
  if (todos.length === 0) return null
  const done = todos.filter(t => t.status === 'completed').length
  const inProgress = todos.filter(t => t.status === 'in_progress').length
  const open = todos.length - done - inProgress
  return (
    <div className="todo-zone">
      <div className="todo-zone__header">
        {todos.length} tasks ({done} done, {inProgress} in progress, {open} open)
      </div>
      <ul className="todo-zone__list">
        {todos.map((t, i) => (
          <li key={i} className={`todo-zone__item todo-zone__item--${t.status}`}>
            <span className="todo-zone__icon">
              {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '■' : '☐'}
            </span>
            <span className="todo-zone__content">{t.content}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

挂载位置：`pages/Agent.tsx` 在 `<MessageList />` **上方**插入 `<TodoZone todos={todosForCurrentSession} />`，用 `todosBySession[sessionId] ?? []` 作为输入。

### 5. 实时 vs transcript 双路径

```
实时（SSE）：
  tool_use:start name='TodoWrite'
    └─ upsertToolCall: 跳过 messages push, 不 bump segment
  tool_use:done toolUseId=T
    └─ 取 msg.input.todos, schema parse → setTodos(sid, list)
    └─ (parse 失败静默忽略)

Transcript 重载：
  loadTranscript(sid)
    └─ extractTodosFromTranscript(rawMessages, 'TodoWrite')
         ├─ findLast assistant msg 含 tool_use name='TodoWrite'
         ├─ 取 input.todos, safeParse
         └─ setTodos(sid, parsed)
```

### 6. 持久化与作用域

- **会话级、内存**：todo 列表不写文件，仅在 `todosBySession` 中按 sessionId 索引。
- transcript 中保留 TodoWrite 的完整 `tool_use + tool_result` 块（zai 现有持久化机制），但**渲染时**TodoWrite tool_use 不显示在 messages 列表里。
- 重启 / 刷新后从 transcript 还原（依赖 LLM 后续可能再调一次 TodoWrite 重新覆盖；用户视觉上看到的"当前 todo"以 transcript 中**最后一次** TodoWrite 为准）。

## 错误处理与边界

| 场景 | 处理 |
|---|---|
| `todos` 字段缺失 / 类型错（call 层） | zod strictObject 拦在 schema 校验前；tool_result 返回 error block |
| `todos` 单条 content / activeForm 为空 | `TodoItemSchema.min(1)` 拦截；LLM 看到 schema 错误 |
| `todos` 是空数组 | `allDone` 对空数组为 true（用 `length > 0 && every(...)` 修正上游这里的小坑：`todos.every(...)` 对 `[]` 返回 true，但语义上"空数组不算 done"）；空数组 → `newTodos = []`，等价 reset |
| transcript 还原时 TodoWrite input 损坏 | safeParse 失败 → 静默忽略，保留 `[]` |
| 同一 session 多次 TodoWrite | 以最后一次为准；transcript 中保留全部历史 |
| 实时 tool_use:done input 损坏 | 静默忽略，不抛错 |
| TodoWrite 与其他工具并发 | 同一 session 内 model 串行调用工具，无并发；跨 session 各自 key 互不影响 |

## 测试

### agent-core

**新建** `packages/zai-agent-core/test/tools/TodoWriteTool/TodoWriteTool.test.ts`：
- name === 'TodoWrite'。
- input schema 拒绝：缺 todos / 空 content / 空 activeForm / 非法 status。
- input schema 接受：合法 todos 数组（pending / in_progress / completed 混合）。
- call 行为：首次调用 oldTodos 为 `[]`；后续调用 oldTodos 为上一次写入值。
- allDone reset：todos 全部 completed → newTodos = `[]`。
- 空数组：newTodos = `[]`（不报错）。
- mapToolResultToToolResultBlockParam 返回 `{ type: 'tool_result', content: ... }`，不带 verification nudge 文案。

### zai-web

**新建** `packages/zai/test/web/TodoZone.test.tsx`：
- 空 todos → render null。
- 3 项 todos → render 标题 `3 tasks (X done, Y in progress, Z open)` + checkbox 列表。
- 状态图标：completed=✓ / in_progress=■ / pending=☐。

**新建** `packages/zai/test/web/useAgentStore.todo.test.ts`：
- setTodos 写入。
- 实时：tool_use:start name='TodoWrite' **不**push 进 messages。
- 实时：tool_use:done name='TodoWrite' 触发 setTodos。
- transcript 还原：findLast TodoWrite tool_use，提取 input.todos 写入 store。
- clearMessages 清当前 sid，其他 sid 保留。
- setCurrentSession 不清其他 sid。
- TodoWrite input 损坏（parse 失败）静默忽略。

### 手工验证（dev server）

1. 启动 zai-web，让模型调用 TodoWrite → 对话上方立刻出现 todo 区。
2. TodoWrite 把全部项标 completed → todo 区消失。
3. 切到其他 session → todo 区清空；切回 → todo 区恢复。
4. 刷新页面 → todo 区从 transcript 还原（依赖最近一次 TodoWrite）。
5. 模型并行调 TodoWrite + BashTool → TodoZone 正常更新，BashTool 卡片正常显示在 messages 流。
6. `bun typecheck`、`bun run build`、`bun test` 全部通过。

## 实施顺序

1. agent-core 新增 `TodoWriteTool/`（5 文件）+ 注册到 `tools.ts` + 单测。
2. agent-core `bun typecheck && bun test` 跑通。
3. zai-web store：`todosBySession` + `setTodos` + `extractTodosFromTranscript` + store 单测。
4. zai-web `TodoZone.tsx` 组件 + 单测 + 挂到 `pages/Agent.tsx`。
5. zai-web `upsertToolCall` 改造（TodoWrite 不进 messages）+ 配套单测。
6. `bun typecheck && bun run build && bun test` 全过。
7. 手工 dev server 跑通 6 项验证。

## 不做的事（明确删除项）

- **不**把 todo 写到 `tasks.json`。
- **不**重写 / 修改现有 TaskCreate 系列。
- **不**实现 TodoRead。
- **不**引入 verification nudge / `isTodoV2Enabled` / `shouldDefer`。
- **不**让 TodoWrite tool_use 出现在 messages 流（不显示 ToolCallBlock）。
- **不**写 README / 文档（除非后续用户要求）。