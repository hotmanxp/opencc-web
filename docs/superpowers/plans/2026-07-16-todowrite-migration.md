# TodoWrite 迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 opencc 上游的 TodoWriteTool 迁移到 zai-agent-core（含注册），zai-web 在对话区上方渲染 TodoZone UI，TodoWrite 工具结果不进 messages 流。

**Architecture:** zai-agent-core 注册 `TodoWriteTool`（`LegacyTool<typeof Schema, string>` 形态，与 TaskCreateTool 同风格）。zai-web store 新增 `todosBySession: Record<sid, TodoItem[]>` 与 `setTodos(sid, list)`；`upsertToolCall` 检测到 name='TodoWrite' 时跳过 push messages 且在 done 时回写 store；`loadTranscriptMessages` 在 assistant tool_use 分支过滤 TodoWrite；`loadTranscript` 末尾调 `extractTodosFromTranscript` 还原 todo。新增 `TodoZone.tsx` 组件，挂到 `pages/Agent.tsx` MessageList 上方。

**Tech Stack:** TypeScript / Bun / zod / vitest / React + Zustand。

**Spec:** `docs/superpowers/specs/2026-07-16-todowrite-migration-design.md`

## Global Constraints

- 不重写 / 不改 TaskCreate 系列工具。
- 不持久化 todo 列表（仅 `todosBySession` 内存 + transcript 兜底）。
- TodoWrite tool_use / tool_result 不进 messages 列表（渲染时过滤）。
- 所有改动必须通过 `bun typecheck`、`bun run build`、`bun test`。
- 不引入 verification nudge / TodoRead / `shouldDefer` / `isTodoV2Enabled`。
- 工作目录：`/Users/ethan/code/opencc-web`。
- 命名：常量用 `TODO_WRITE_TOOL_NAME`；函数/字段用 camelCase。

---

## File Structure

| 文件 | 操作 | 职责 |
|---|---|---|
| `packages/zai-agent-core/src/tools/TodoWriteTool/constants.ts` | 新建 | 导出 `TODO_WRITE_TOOL_NAME = 'TodoWrite'` |
| `packages/zai-agent-core/src/tools/TodoWriteTool/schema.ts` | 新建 | `TodoItemSchema` / `TodoWriteInputSchema` / `TodoWriteInput` |
| `packages/zai-agent-core/src/tools/TodoWriteTool/prompt.ts` | 新建 | `renderTodoWritePrompt()` |
| `packages/zai-agent-core/src/tools/TodoWriteTool/TodoWriteTool.ts` | 新建 | `TodoWriteTool: LegacyTool<typeof Schema, string>` |
| `packages/zai-agent-core/src/tools/TodoWriteTool/index.ts` | 新建 | re-export |
| `packages/zai-agent-core/src/tools/index.ts` | 修改 | append `wrapAsOpenccTool(TodoWriteTool)` |
| `packages/zai-agent-core/test/tools/TodoWriteTool/schema.test.ts` | 新建 | schema 校验单测 |
| `packages/zai-agent-core/test/tools/TodoWriteTool/TodoWriteTool.test.ts` | 新建 | call 行为单测 |
| `packages/zai/src/web/src/store/useAgentStore.ts` | 修改 | 新增类型/字段/reducer + 守卫 |
| `packages/zai/src/web/src/components/TodoZone.tsx` | 新建 | UI 组件 |
| `packages/zai/src/web/src/pages/Agent.tsx` | 修改 | 挂载 TodoZone |
| `packages/zai/test/web/useAgentStore.todo.test.ts` | 新建 | store todo 行为单测 |
| `packages/zai/test/web/TodoZone.test.tsx` | 新建 | UI 单测 |

---

## Task 1: agent-core TodoWriteTool/constants.ts + schema.ts + prompt.ts

**Files:**
- Create: `packages/zai-agent-core/src/tools/TodoWriteTool/constants.ts`
- Create: `packages/zai-agent-core/src/tools/TodoWriteTool/schema.ts`
- Create: `packages/zai-agent-core/src/tools/TodoWriteTool/prompt.ts`

**Interfaces:**
- Consumes: zod（已是 agent-core 依赖）。
- Produces:
  - `TODO_WRITE_TOOL_NAME: 'TodoWrite'`
  - `TodoItemSchema: z.ZodObject<{ content, status, activeForm }>`
  - `TodoWriteInputSchema: z.ZodObject<{ todos }>`
  - `TodoWriteInput = z.infer<typeof TodoWriteInputSchema>`
  - `TodoWriteItem = z.infer<typeof TodoItemSchema>`
  - `renderTodoWritePrompt(): string`

- [ ] **Step 1: 写 constants.ts**

```ts
// packages/zai-agent-core/src/tools/TodoWriteTool/constants.ts
export const TODO_WRITE_TOOL_NAME = 'TodoWrite'
```

- [ ] **Step 2: 写 schema.ts**

```ts
// packages/zai-agent-core/src/tools/TodoWriteTool/schema.ts
import { z } from 'zod'

export const TodoItemSchema = z.object({
  content: z.string().min(1, 'content 不能为空'),
  status: z.enum(['pending', 'in_progress', 'completed']),
  activeForm: z.string().min(1, 'activeForm 不能为空'),
})

export const TodoWriteInputSchema = z.object({
  todos: z.array(TodoItemSchema),
})

export type TodoWriteItem = z.infer<typeof TodoItemSchema>
export type TodoWriteInput = z.infer<typeof TodoWriteInputSchema>
```

- [ ] **Step 3: 写 prompt.ts**

```ts
// packages/zai-agent-core/src/tools/TodoWriteTool/prompt.ts
export function renderTodoWritePrompt(): string {
  return [
    '创建一个会话内的 todo 列表,用于追踪多步骤工作进度。',
    '与 TaskCreate 不同:TodoWrite 的 todo 仅在本会话内有效,不持久化,',
    '也不会被任何 agent 执行 — 只是给用户和模型提供一个可见的进度面板。',
    '',
    '参数:',
    '- todos: 完整 todo 列表(每次调用覆盖整个列表)',
    '  - content: 简短描述(必填,非空)',
    '  - status: pending / in_progress / completed 之一',
    '  - activeForm: 进行中的现在时短语,如"实现 X"(必填,非空)',
    '',
    '使用约定:',
    '- 任意时刻 todo 列表里最多只有一项 status=in_progress。',
    '- 全部 completed 后,下次调用传空数组即可重置。',
  ].join('\n')
}
```

- [ ] **Step 4: 校验**

Run: `cd /Users/ethan/code/opencc-web/packages/zai-agent-core && bun tsc --noEmit`
Expected: exit 0, 无报错。

- [ ] **Step 5: Commit**

```bash
git add packages/zai-agent-core/src/tools/TodoWriteTool/constants.ts \
        packages/zai-agent-core/src/tools/TodoWriteTool/schema.ts \
        packages/zai-agent-core/src/tools/TodoWriteTool/prompt.ts
git commit -m "feat(zai-agent-core): TodoWriteTool 工具定义骨架"
```

---

## Task 2: agent-core TodoWriteTool.ts + index.ts + 注册到 tools/index.ts

**Files:**
- Create: `packages/zai-agent-core/src/tools/TodoWriteTool/TodoWriteTool.ts`
- Create: `packages/zai-agent-core/src/tools/TodoWriteTool/index.ts`
- Modify: `packages/zai-agent-core/src/tools/index.ts:18-50`

**Interfaces:**
- Consumes: 上一个任务的 exports。
- Produces:
  - `TodoWriteTool: LegacyTool<typeof TodoWriteInputSchema, string>`
  - `getZaiRuntimeTools()` 数组中包含 `wrapAsOpenccTool(TodoWriteTool)`。

- [ ] **Step 1: 写 TodoWriteTool.ts**

```ts
// packages/zai-agent-core/src/tools/TodoWriteTool/TodoWriteTool.ts
import type { LegacyTool } from '../Tool.js'
import { TodoWriteInputSchema, type TodoWriteInput } from './schema.js'
import { renderTodoWritePrompt } from './prompt.js'
import { TODO_WRITE_TOOL_NAME } from './constants.js'

export const TodoWriteTool: LegacyTool<typeof TodoWriteInputSchema, string> = {
  name: TODO_WRITE_TOOL_NAME,
  description: renderTodoWritePrompt(),
  inputSchema: TodoWriteInputSchema,
  isConcurrencySafe: () => true,
  isReadOnly: () => false,
  isDestructive: () => false,

  async call(rawInput) {
    const input = rawInput as TodoWriteInput
    // 与上游语义一致: 全部 completed 或空数组都重置为空。
    // 状态不写入 agent-core appState — zai-web 通过 SSE tool_use:done
    // 自己把 input.todos 解析进 todosBySession。
    const allDone =
      input.todos.length > 0 &&
      input.todos.every((t) => t.status === 'completed')
    const newTodos = allDone || input.todos.length === 0 ? [] : input.todos
    const payload = {
      todoCount: newTodos.length,
      firstItem: newTodos[0]?.content ?? null,
    }
    return {
      output: JSON.stringify(payload, null, 2),
      isError: false,
    }
  },
}
```

- [ ] **Step 2: 写 index.ts**

```ts
// packages/zai-agent-core/src/tools/TodoWriteTool/index.ts
export { TodoWriteTool, TODO_WRITE_TOOL_NAME } from './TodoWriteTool.js'
export { TodoWriteInputSchema, TodoItemSchema } from './schema.js'
export type { TodoWriteInput, TodoWriteItem } from './schema.js'
```

- [ ] **Step 3: 注册到 tools/index.ts**

修改 `packages/zai-agent-core/src/tools/index.ts:18-50` —— 在 `TaskCreateTool` import 行后插入 `TodoWriteTool` 的 import；在 `getZaiRuntimeTools()` 数组中紧跟 `wrapAsOpenccTool(TaskCreateTool)` 之后插入 `wrapAsOpenccTool(TodoWriteTool)`。

修改后的 import 段（line 18 起）：

```ts
import { TaskCreateTool } from './TaskCreateTool/TaskCreateTool.js'
import { TodoWriteTool } from './TodoWriteTool/TodoWriteTool.js'
```

修改后的 `getZaiRuntimeTools` 数组（line 30 起），在 `wrapAsOpenccTool(TaskCreateTool),` 之后插入一行：

```ts
    wrapAsOpenccTool(TaskCreateTool),
    wrapAsOpenccTool(TodoWriteTool),
```

完整更新后的 `getZaiRuntimeTools` 内容（line 30-50）：

```ts
  return [
    wrapAsOpenccTool(BashTool),
    wrapAsOpenccTool(AgentTool),
    wrapAsOpenccTool(FileReadTool),
    wrapAsOpenccTool(FileWriteTool),
    wrapAsOpenccTool(FileEditTool),
    wrapAsOpenccTool(GlobTool),
    wrapAsOpenccTool(GrepTool),
    wrapAsOpenccTool(AskUserQuestionTool),
    wrapAsOpenccTool(ListMcpResourcesTool),
    wrapAsOpenccTool(ReadMcpResourceTool),
    wrapAsOpenccTool(BackgroundAgentTool),
    wrapAsOpenccTool(BackgroundAgentResultTool),
    wrapAsOpenccTool(TaskCreateTool),
    wrapAsOpenccTool(TodoWriteTool),
    wrapAsOpenccTool(TaskListTool),
    wrapAsOpenccTool(TaskGetTool),
    wrapAsOpenccTool(TaskUpdateTool),
    wrapAsOpenccTool(TaskOutputTool),
    wrapAsOpenccTool(TaskStopTool),
  ]
```

- [ ] **Step 4: 校验**

Run: `cd /Users/ethan/code/opencc-web/packages/zai-agent-core && bun tsc --noEmit`
Expected: exit 0。

- [ ] **Step 5: Commit**

```bash
git add packages/zai-agent-core/src/tools/TodoWriteTool/TodoWriteTool.ts \
        packages/zai-agent-core/src/tools/TodoWriteTool/index.ts \
        packages/zai-agent-core/src/tools/index.ts
git commit -m "feat(zai-agent-core): 注册 TodoWriteTool,与会话级 todo 列表对齐"
```

---

## Task 3: agent-core TodoWriteTool 单测

**Files:**
- Create: `packages/zai-agent-core/test/tools/TodoWriteTool/schema.test.ts`
- Create: `packages/zai-agent-core/test/tools/TodoWriteTool/TodoWriteTool.test.ts`

**Interfaces:**
- Consumes: Task 1/2 的 exports。
- Produces: 跑通的 vitest 测试。

- [ ] **Step 1: 写 schema.test.ts（先红）**

```ts
// packages/zai-agent-core/test/tools/TodoWriteTool/schema.test.ts
import { describe, expect, test } from 'vitest'
import { TodoWriteInputSchema, TodoItemSchema } from '../../../src/tools/TodoWriteTool/schema.js'

describe('TodoWriteInputSchema', () => {
  test('最小可用: 一项 in_progress todo', () => {
    const r = TodoWriteInputSchema.safeParse({
      todos: [{ content: '写 spec', status: 'in_progress', activeForm: '正在写 spec' }],
    })
    expect(r.success).toBe(true)
  })

  test('缺 todos 字段 → fail', () => {
    const r = TodoWriteInputSchema.safeParse({})
    expect(r.success).toBe(false)
  })

  test('todos 是空数组 → success (合法)', () => {
    const r = TodoWriteInputSchema.safeParse({ todos: [] })
    expect(r.success).toBe(true)
  })

  test('content 为空字符串 → fail', () => {
    const r = TodoItemSchema.safeParse({
      content: '',
      status: 'pending',
      activeForm: 'x',
    })
    expect(r.success).toBe(false)
  })

  test('activeForm 为空字符串 → fail', () => {
    const r = TodoItemSchema.safeParse({
      content: 'x',
      status: 'pending',
      activeForm: '',
    })
    expect(r.success).toBe(false)
  })

  test('非法 status → fail', () => {
    const r = TodoItemSchema.safeParse({
      content: 'x',
      status: 'done',  // 必须是 pending/in_progress/completed
      activeForm: 'y',
    })
    expect(r.success).toBe(false)
  })

  test('pending/in_progress/completed 三种 status 都能通过', () => {
    for (const status of ['pending', 'in_progress', 'completed'] as const) {
      const r = TodoItemSchema.safeParse({ content: 'x', status, activeForm: 'y' })
      expect(r.success).toBe(true)
    }
  })
})
```

- [ ] **Step 2: 跑 schema 测试（确认绿）**

Run: `cd /Users/ethan/code/opencc-web/packages/zai-agent-core && bun vitest run test/tools/TodoWriteTool/schema.test.ts`
Expected: 7 个 test 全部 PASS。

- [ ] **Step 3: 写 TodoWriteTool.test.ts**

```ts
// packages/zai-agent-core/test/tools/TodoWriteTool/TodoWriteTool.test.ts
import { describe, expect, test } from 'vitest'
import { TodoWriteTool } from '../../../src/tools/TodoWriteTool/TodoWriteTool.js'

describe('TodoWriteTool', () => {
  test('name === "TodoWrite"', () => {
    expect(TodoWriteTool.name).toBe('TodoWrite')
  })

  test('inputSchema 是 zod schema', () => {
    expect(TodoWriteTool.inputSchema.safeParse({ todos: [] }).success).toBe(true)
  })

  test('isConcurrencySafe === true', () => {
    expect(TodoWriteTool.isConcurrencySafe()).toBe(true)
  })

  test('isReadOnly === false', () => {
    expect(TodoWriteTool.isReadOnly()).toBe(false)
  })

  test('call: 全部 completed → 返回空列表的 payload (todoCount=0)', async () => {
    const result = await TodoWriteTool.call({
      todos: [
        { content: 'a', status: 'completed', activeForm: 'A' },
        { content: 'b', status: 'completed', activeForm: 'B' },
      ],
    } as never)
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.output as string).todoCount).toBe(0)
  })

  test('call: 混合状态 → payload.todoCount === 非 completed 项数', async () => {
    const result = await TodoWriteTool.call({
      todos: [
        { content: 'a', status: 'completed', activeForm: 'A' },
        { content: 'b', status: 'in_progress', activeForm: 'B' },
        { content: 'c', status: 'pending', activeForm: 'C' },
      ],
    } as never)
    expect(result.isError).toBe(false)
    const payload = JSON.parse(result.output as string)
    expect(payload.todoCount).toBe(2)
    expect(payload.firstItem).toBe('b')
  })

  test('call: 空数组 → payload.todoCount === 0 (reset 路径)', async () => {
    const result = await TodoWriteTool.call({ todos: [] } as never)
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.output as string).todoCount).toBe(0)
  })

  test('call: 只有 in_progress (无 completed) → payload.todoCount 等于输入长度', async () => {
    const result = await TodoWriteTool.call({
      todos: [
        { content: 'a', status: 'in_progress', activeForm: 'A' },
        { content: 'b', status: 'pending', activeForm: 'B' },
      ],
    } as never)
    const payload = JSON.parse(result.output as string)
    expect(payload.todoCount).toBe(2)
  })
})
```

- [ ] **Step 4: 跑工具测试**

Run: `cd /Users/ethan/code/opencc-web/packages/zai-agent-core && bun vitest run test/tools/TodoWriteTool/`
Expected: 全部 PASS。

- [ ] **Step 5: 跑完整 agent-core 测试确认无回归**

Run: `cd /Users/ethan/code/opencc-web/packages/zai-agent-core && bun vitest run`
Expected: 全部 PASS（包括原 BashTool / TaskCreate 等）。

- [ ] **Step 6: Commit**

```bash
git add packages/zai-agent-core/test/tools/TodoWriteTool/
git commit -m "test(zai-agent-core): TodoWriteTool schema + call 行为单测"
```

---

## Task 4: zai-web store 新增 todosBySession 字段 + 类型

**Files:**
- Modify: `packages/zai/src/web/src/store/useAgentStore.ts:1-122`

**Interfaces:**
- Consumes: 现有 `useAgentStore`。
- Produces:
  - `TodoItem` 类型导出：`{ content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string }`
  - `AgentState` 新增字段 `todosBySession: Record<string, TodoItem[]>`、`setTodos: (sid, list) => void`
  - 初始值 `todosBySession: {}`

- [ ] **Step 1: 在 `useAgentStore.ts:1-122` 加类型与字段**

在文件顶部（`import { create } from 'zustand'` 之后，第 7 行前）插入类型定义：

```ts
// 与 agent-core TodoWriteInputSchema 的 zod 形态一致 (web 不直接 import zod schema,
// 避免循环依赖; 字段类型用本地 type 即可, 实时流拿到的 input.todos 由本文件内的
// safeParse 兜底, 失败时静默忽略).
export type TodoItem = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm: string
}
```

在 `AgentState` interface 内（line 76-89, `textSegmentRev` 字段附近）插入新字段：

```ts
  // 会话级 todo 列表 (按 sessionId 索引). 不持久化, 切换会话时保留旧 sid 的
  // todo, 刷新页面由 loadTranscript 走 extractTodosFromTranscript 还原.
  todosBySession: Record<string, TodoItem[]>
  setTodos: (sessionId: string, todos: TodoItem[]) => void
```

- [ ] **Step 2: 初始化字段**

在 `useAgentStore` create 函数体（line 252 起）的初始状态对象里，在 `sendSeq: 0`（line 263）后插入：

```ts
  todosBySession: {},
```

- [ ] **Step 3: 跑 typecheck 确认接口声明 OK**

Run: `cd /Users/ethan/code/opencc-web && bun tsc --noEmit -p packages/zai/tsconfig.json`
Expected: 报错"setTodos 尚未实现"（这是预期的，TypeScript 严格模式）。**先不补实现**，留到 Task 5。

- [ ] **Step 4: Commit**

```bash
git add packages/zai/src/web/src/store/useAgentStore.ts
git commit -m "feat(zai-web): useAgentStore 新增 todosBySession 字段"
```

---

## Task 5: zai-web store 实现 setTodos + 三个 reducer 清理

**Files:**
- Modify: `packages/zai/src/web/src/store/useAgentStore.ts:252-461`（create 体内 setTodos + clearMessages + setCurrentSession + createNewSession）

**Interfaces:**
- Consumes: 上一个任务的类型/字段。
- Produces:
  - `setTodos(sid, list)`：把 `todosBySession[sid] = list`。
  - `clearMessages` 不清 todosBySession（按 spec，只清当前 sid；实现为：取当前 `sessionId`，删该 sid 的 todo 条目）。
  - `setCurrentSession(sid)` 不清其他 sid，仅设置 `sessionId`，不清 todos。
  - `createNewSession` 流程改为：先清当前 sid 的 todo 条目（如果有），再走原有逻辑。

- [ ] **Step 1: 写 setTodos 实现**

在 `useAgentStore` create 函数体里，紧接 `todosBySession: {},`（Task 4 加的位置）之后插入：

```ts
  setTodos: (sessionId: string, todos: TodoItem[]) =>
    set((s) => ({
      todosBySession: { ...s.todosBySession, [sessionId]: todos },
    })),
```

- [ ] **Step 2: clearMessages 仅清当前 sid 的 todo**

修改 `clearMessages` (line 452-461)，原内容：

```ts
  clearMessages: () =>
    set({
      messages: [],
      status: 'idle',
      // 重置 stream block 状态: 切会话/清屏 后, 工具边界计数器也得回到 0,
      // 否则新会话的 text 段会被旧会话遗留的 textSegmentRev 错位归并.
      textSegmentRev: 0,
      segmentedToolUseIds: {},
      sendSeq: 0,
    }),
```

改为：

```ts
  clearMessages: () =>
    set((s) => {
      // 仅清空当前 sid 的 todo, 其他 sid 保留以便切回.
      const sid = s.sessionId
      const { [sid as string]: _drop, ...rest } = (s.todosBySession ?? {}) as Record<string, TodoItem[]>
      void _drop
      return {
        messages: [],
        status: 'idle',
        // 重置 stream block 状态: 切会话/清屏 后, 工具边界计数器也得回到 0,
        // 否则新会话的 text 段会被旧会话遗留的 textSegmentRev 错位归并.
        textSegmentRev: 0,
        segmentedToolUseIds: {},
        sendSeq: 0,
        todosBySession: sid ? rest : s.todosBySession,
      }
    }),
```

- [ ] **Step 3: setCurrentSession 不动 todosBySession**

`setCurrentSession` (line 487-489) 保持原样：

```ts
  setCurrentSession: (sessionId: string) => {
    set({ sessionId, messages: [], textSegmentRev: 0, segmentedToolUseIds: {}, sendSeq: 0 })
  },
```

（spec 承诺"切到任意旧 sid 立刻看到该 sid 的 todo"——保留所有 sid 条目即可，无需改动。）

- [ ] **Step 4: createNewSession 清当前 sid 的 todo**

修改 `createNewSession` (line 491-519) 中 `set({ sessionId: null, ... messages: [], ...})` 这块 set 调用，在 `sendSeq: 0,` 后插入：

```ts
      // 清掉当前 sid 的 todo (旧 sid 保留).
      ...(state.sessionId
        ? { todosBySession: Object.fromEntries(
            Object.entries(state.todosBySession).filter(([k]) => k !== state.sessionId),
          ) as Record<string, TodoItem[]> }
        : {}),
```

注意：`createNewSession` 当前用的是裸 `set({...})`（不是 `set((s) => ...)`）。需要把它改成函数式 set 才能拿 `state.sessionId`。最终代码（替换整段 `createNewSession` 函数体 line 491-519）：

```ts
  createNewSession: async () => {
    // 立即清空当前 UI 态, 让用户感觉"切到了新会话"
    set((state) => {
      const sid = state.sessionId
      const nextTodos = sid
        ? Object.fromEntries(
            Object.entries(state.todosBySession).filter(([k]) => k !== sid),
          )
        : state.todosBySession
      return {
        sessionId: null,
        activeSessionId: null,
        messages: [],
        status: 'idle' as AgentStatus,
        textSegmentRev: 0,
        segmentedToolUseIds: {},
        sendSeq: 0,
        todosBySession: nextTodos,
      }
    })
    // 同步在 server 端建一条空 transcript, 让 sidebar 立即多一条
    // '新会话' 占位条目 (而不是等第一条消息发出去才出现).
    try {
      const token = localStorage.getItem('zai-token') || ''
      const res = await fetch('/api/agent/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Zai-Token': token },
        body: JSON.stringify({}),
      })
      if (!res.ok) return
      const data = (await res.json()) as { sessionId: string }
      // 把新 sessionId 设上 + 刷新 sidebar 列表
      set({ sessionId: data.sessionId })
      await get().loadSessions()
    } catch {
      // 静默失败: 用户还能继续在本地空态发消息, server 端会按旧路径新建
    }
  },
```

- [ ] **Step 5: typecheck**

Run: `cd /Users/ethan/code/opencc-web && bun tsc --noEmit -p packages/zai/tsconfig.json`
Expected: exit 0。

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/web/src/store/useAgentStore.ts
git commit -m "feat(zai-web): setTodos 实现 + 三个 reducer 清当前 sid todo"
```

---

## Task 6: zai-web store upsertToolCall 守卫（TodoWrite 不进 messages + done 时回写）

**Files:**
- Modify: `packages/zai/src/web/src/store/useAgentStore.ts:275-411`（`upsertToolCall` 整个 set 回调）

**Interfaces:**
- Consumes: `setTodos`（Task 5）；`TODO_WRITE_TOOL_NAME = 'TodoWrite'`（硬编码即可，避免循环 import）。
- Produces:
  - 检测到 `msg.name === 'TodoWrite'` 时，跳过 push messages、不 bump segment、不动 segmentedToolUseIds。
  - 在 done/error 阶段，解析 `msg.input.todos`，safeParse 失败时静默忽略；通过则 `setTodos(sid, list)`。

- [ ] **Step 1: 写守卫**

修改 `upsertToolCall`（line 275-411）的 set 函数体。在 `set((s) => { ... })` 内部，紧跟 `const t = msg.type as string`（line 277）之后插入守卫：

```ts
      // TodoWrite 的 tool_use/tool_result 全部不进 messages 流 (按 spec:
      // TodoWrite 不显示 ToolCallBlock, 它的可见状态由 todosBySession 渲染).
      if ((msg.name as string) === 'TodoWrite') {
        // done / error 阶段: 解析 input.todos 写回 todosBySession. 失败静默忽略.
        const t2 = t as string
        if (t2 === 'tool_use:done' || t2 === 'tool_use:error') {
          const input = (msg.input as { todos?: unknown }) ?? {}
          const rawTodos = input.todos
          if (Array.isArray(rawTodos)) {
            const parsed: TodoItem[] = []
            let ok = true
            for (const raw of rawTodos) {
              if (
                !raw || typeof raw !== 'object' ||
                typeof (raw as { content?: unknown }).content !== 'string' ||
                typeof (raw as { activeForm?: unknown }).activeForm !== 'string'
              ) {
                ok = false
                break
              }
              const s0 = (raw as { status?: unknown }).status
              if (s0 !== 'pending' && s0 !== 'in_progress' && s0 !== 'completed') {
                ok = false
                break
              }
              parsed.push({
                content: (raw as { content: string }).content,
                status: s0,
                activeForm: (raw as { activeForm: string }).activeForm,
              })
            }
            if (ok) {
              const sid = (msg.sessionId as string | undefined) ?? s.sessionId
              if (sid) {
                return {
                  todosBySession: { ...s.todosBySession, [sid]: parsed },
                }
              }
            }
            // parse 失败: 静默忽略, 不 push messages, 不 bump segment.
            return {}
          }
        }
        // start 阶段 或 parse 后 sid 缺失: 直接吞掉, 不动 messages.
        return {}
      }
```

- [ ] **Step 2: typecheck**

Run: `cd /Users/ethan/code/opencc-web && bun tsc --noEmit -p packages/zai/tsconfig.json`
Expected: exit 0。

- [ ] **Step 3: Commit**

```bash
git add packages/zai/src/web/src/store/useAgentStore.ts
git commit -m "feat(zai-web): upsertToolCall TodoWrite 守卫 - 不进 messages + done 回写 store"
```

---

## Task 7: zai-web store extractTodosFromTranscript + loadTranscriptMessages 过滤

**Files:**
- Modify: `packages/zai/src/web/src/store/useAgentStore.ts:129-250`（`loadTranscriptMessages`）+ line 592-615（`loadTranscript`）

**Interfaces:**
- Consumes: 现有 `loadTranscriptMessages` 函数；`setTodos`。
- Produces:
  - `loadTranscriptMessages` 在 `msg.type === 'assistant'` 的 tool_use 分支（line 236-245）过滤：`b.name === 'TodoWrite'` 时不 push。
  - `extractTodosFromTranscript(rawMessages): TodoItem[] | null` 顶层函数 —— findLast assistant msg 含 TodoWrite tool_use，提取 input.todos，safeParse，失败返回 null。
  - `loadTranscript` 末尾调 `extractTodosFromTranscript` 并 `setTodos(sid, parsed ?? [])`。

- [ ] **Step 1: 在 loadTranscriptMessages 顶部加 TodoWrite 过滤**

修改 line 236 附近 `else if (b.type === 'tool_use')` 分支（line 236-245）：

```ts
        } else if (b.type === 'tool_use') {
          // TodoWrite tool_use 不进 messages 流; 它对应的状态由 TodoZone 渲染.
          if ((b.name as string) === 'TodoWrite') continue
          out.push({
            ...baseFields,
            eventId: msg.uuid ?? `tool-${b.id}`,
            type: 'tool_use:start',
            toolUseId: b.id as string,
            name: b.name as string,
            input: b.input as Record<string, unknown>,
          })
        }
```

- [ ] **Step 2: 加 extractTodosFromTranscript 顶层函数**

在 `loadTranscriptMessages` 函数定义结束后（line 250 后）、`useAgentStore = create<AgentState>(...)`（line 252）之前插入：

```ts
// 从 transcript 历史里提取最近一次 TodoWrite 的 todos. 返回 null 表示没找到
// 或解析失败. zai-web 用这个函数在 loadTranscript 末尾回填 todosBySession.
export function extractTodosFromTranscript(
  rawMessages: any[],
): TodoItem[] | null {
  // 倒序找最后一条 assistant message 含 TodoWrite tool_use 块.
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const msg = rawMessages[i]
    if (!msg || msg.type !== 'assistant') continue
    const content = msg.message?.content
    if (!Array.isArray(content)) continue
    const blocks = content as Array<Record<string, unknown>>
    for (const b of blocks) {
      if (b.type !== 'tool_use') continue
      if ((b.name as string) !== 'TodoWrite') continue
      const input = b.input as { todos?: unknown } | undefined
      const rawTodos = input?.todos
      if (!Array.isArray(rawTodos)) return null
      const parsed: TodoItem[] = []
      for (const raw of rawTodos) {
        if (
          !raw || typeof raw !== 'object' ||
          typeof (raw as { content?: unknown }).content !== 'string' ||
          typeof (raw as { activeForm?: unknown }).activeForm !== 'string'
        ) {
          return null
        }
        const s0 = (raw as { status?: unknown }).status
        if (s0 !== 'pending' && s0 !== 'in_progress' && s0 !== 'completed') {
          return null
        }
        parsed.push({
          content: (raw as { content: string }).content,
          status: s0,
          activeForm: (raw as { activeForm: string }).activeForm,
        })
      }
      return parsed
    }
  }
  return null
}
```

- [ ] **Step 3: loadTranscript 末尾调用 extractTodosFromTranscript**

修改 `loadTranscript` (line 592-615)，在 `set({ messages, sessionId, ... })` 调用**之后**插入：

```ts
      // 还原 transcript 中最后一次 TodoWrite 的 todos. 失败静默.
      const todos = extractTodosFromTranscript((transcript.messages ?? []) as any[])
      if (todos !== null) {
        set((s) => ({
          todosBySession: { ...s.todosBySession, [sessionId]: todos },
        }))
      } else {
        // 没找到 TodoWrite 或解析失败: 不动 store 已有 todo (若有).
        // 这里 "不动" 比 "清空" 安全 — 用户从历史切回时不应无故丢 todo.
      }
```

修改后的 `loadTranscript` 完整函数体（替换 line 592-615）：

```ts
  loadTranscript: async (sessionId: string) => {
    try {
      const token = localStorage.getItem('zai-token') || ''
      const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}`, {
        headers: { 'X-Zai-Token': token },
      })
      const data = await res.json()
      const transcript = data.transcript
      if (!transcript) return
      // 把 transcript messages 转换成 AgentMessage 格式 (v2 ContentBlock[] + v1 旧 fallback)
      const messages = loadTranscriptMessages(sessionId, (transcript.messages ?? []) as any[])
      set({
        messages,
        sessionId,
        // transcript 回放没有流式事件, 工具边界计数器无需保留;
        // 重置防止后续 turn 用过期的 textSegmentRev 错位归并.
        textSegmentRev: 0,
        segmentedToolUseIds: {},
        sendSeq: 0,
      })
      // 还原 transcript 中最后一次 TodoWrite 的 todos. 失败静默 — 不清空 store 已有 todo.
      const todos = extractTodosFromTranscript((transcript.messages ?? []) as any[])
      if (todos !== null) {
        set((s) => ({
          todosBySession: { ...s.todosBySession, [sessionId]: todos },
        }))
      }
    } catch {
      // ignore
    }
  },
```

- [ ] **Step 4: typecheck**

Run: `cd /Users/ethan/code/opencc-web && bun tsc --noEmit -p packages/zai/tsconfig.json`
Expected: exit 0。

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/store/useAgentStore.ts
git commit -m "feat(zai-web): extractTodosFromTranscript + loadTranscript 还原 + loadTranscriptMessages 过滤"
```

---

## Task 8: zai-web TodoZone 组件

**Files:**
- Create: `packages/zai/src/web/src/components/TodoZone.tsx`

**Interfaces:**
- Consumes: `TodoItem`（从 `useAgentStore` import）。
- Produces: `<TodoZone todos={TodoItem[]} />` React 组件，todos 为空时 render null。

- [ ] **Step 1: 写组件**

```tsx
// packages/zai/src/web/src/components/TodoZone.tsx
import type { TodoItem } from '../store/useAgentStore.js'

type Props = { todos: TodoItem[] }

// 样式与 zai-web 现有暗色主题靠齐. padding / 字号 / 行高按 zai-web 现有
// MessageBubble 的视觉密度取近似值, 不引入新 design tokens.
const styles: Record<string, React.CSSProperties> = {
  wrap: {
    margin: '8px 0',
    padding: '8px 12px',
    borderRadius: 6,
    background: '#1a1a1a',
    color: '#d0d0d0',
    fontSize: 12,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    border: '1px solid #2a2a2a',
  },
  header: { marginBottom: 6, color: '#999' },
  list: { listStyle: 'none', padding: 0, margin: 0 },
  item: { display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' },
  icon: { width: 14, display: 'inline-block', textAlign: 'center' },
  content: { flex: 1 },
}

function statusIcon(status: TodoItem['status']): string {
  if (status === 'completed') return '✓'
  if (status === 'in_progress') return '■'
  return '☐'
}

export default function TodoZone({ todos }: Props) {
  if (todos.length === 0) return null
  const done = todos.filter((t) => t.status === 'completed').length
  const inProgress = todos.filter((t) => t.status === 'in_progress').length
  const open = todos.length - done - inProgress
  return (
    <div style={styles.wrap} data-testid="todo-zone">
      <div style={styles.header}>
        {todos.length} tasks ({done} done, {inProgress} in progress, {open} open)
      </div>
      <ul style={styles.list}>
        {todos.map((t, i) => (
          <li
            key={i}
            style={styles.item}
            data-testid={`todo-item-${t.status}`}
          >
            <span style={styles.icon}>{statusIcon(t.status)}</span>
            <span style={styles.content}>{t.content}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 2: typecheck**

Run: `cd /Users/ethan/code/opencc-web && bun tsc --noEmit -p packages/zai/tsconfig.json`
Expected: exit 0。

- [ ] **Step 3: Commit**

```bash
git add packages/zai/src/web/src/components/TodoZone.tsx
git commit -m "feat(zai-web): TodoZone 组件 - 对话上方 todo 区"
```

---

## Task 9: zai-web pages/Agent.tsx 挂载 TodoZone

**Files:**
- Modify: `packages/zai/src/web/src/pages/Agent.tsx:33-37`（import 段）+ `pages/Agent.tsx:1727`（messages.map 之前）

**Interfaces:**
- Consumes: `TodoZone` 组件（Task 8）；`todosBySession`、`sessionId` 从 `useAgentStore`。
- Produces: `<TodoZone todos={todosForCurrentSession} />` 渲染在空态提示 div 之后、`messages.map` 之前。

- [ ] **Step 1: 加 import**

修改 `pages/Agent.tsx:33-37`：

```tsx
import {
  useAgentStore,
  type AgentMessage,
  type AgentStatus,
  type TodoItem,
} from "../store/useAgentStore";
```

下方新增：

```tsx
import TodoZone from "../components/TodoZone.jsx";
```

- [ ] **Step 2: 取 todosForCurrentSession**

在 `Agent` 组件函数体里，与 `messages` 取值（line 959 `messages,`）同一段解构中加：

```tsx
    todosBySession,
```

并在 `useAgentStore()` 解构后附近计算：

```tsx
  const todosForCurrentSession: TodoItem[] =
    sessionId != null ? (todosBySession[sessionId] ?? []) : []
```

`sessionId` 在第 959 行已经解构出，无需重复。

- [ ] **Step 3: 挂载 TodoZone**

修改 `pages/Agent.tsx:1707-1727` 之间的渲染结构。原内容（line 1707-1727）：

```tsx
        >
          {messages.length === 0 && (
            <div
              style={{
                textAlign: "center",
                marginTop: 80,
                color: "#999",
              }}
            >
              ...
            </div>
          )}
          {messages.map((msg: AgentMessage, idx: number) => {
```

改为（在 `</div>` 后、`messages.map` 前插入 `<TodoZone ... />`）：

```tsx
        >
          {messages.length === 0 && (
            <div
              style={{
                textAlign: "center",
                marginTop: 80,
                color: "#999",
              }}
            >
              ...
            </div>
          )}
          <TodoZone todos={todosForCurrentSession} />
          {messages.map((msg: AgentMessage, idx: number) => {
```

- [ ] **Step 4: typecheck + build**

Run: `cd /Users/ethan/code/opencc-web && bun tsc --noEmit -p packages/zai/tsconfig.json`
Expected: exit 0。

Run: `cd /Users/ethan/code/opencc-web && bun run build`
Expected: exit 0。

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/pages/Agent.tsx
git commit -m "feat(zai-web): pages/Agent.tsx 在 MessageList 上方挂载 TodoZone"
```

---

## Task 10: zai-web useAgentStore.todo.test.ts 单测

**Files:**
- Create: `packages/zai/test/web/useAgentStore.todo.test.ts`

**Interfaces:**
- Consumes: `useAgentStore`、`TodoItem`、`extractTodosFromTranscript`。
- Produces: 7 个 vitest 测试覆盖 setTodos、reducer 清理、upsertToolCall 守卫、extractTodosFromTranscript。

- [ ] **Step 1: 写测试**

```ts
// packages/zai/test/web/useAgentStore.todo.test.ts
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  useAgentStore,
  extractTodosFromTranscript,
  type TodoItem,
} from '../../src/web/src/store/useAgentStore.js'

const sampleTodos: TodoItem[] = [
  { content: 'A', status: 'in_progress', activeForm: 'A' },
  { content: 'B', status: 'pending', activeForm: 'B' },
]

beforeEach(() => {
  // 重置 store 到隔离初态, 不污染其他 test 文件
  useAgentStore.setState({
    sessionId: 'sess-1',
    messages: [],
    textSegmentRev: 0,
    segmentedToolUseIds: {},
    sendSeq: 0,
    todosBySession: {},
  })
})

describe('useAgentStore — todosBySession', () => {
  it('setTodos 写入并保留其他 sid', () => {
    const { setTodos } = useAgentStore.getState()
    setTodos('sess-1', sampleTodos)
    setTodos('sess-2', [])
    const s = useAgentStore.getState()
    expect(s.todosBySession['sess-1']).toEqual(sampleTodos)
    expect(s.todosBySession['sess-2']).toEqual([])
  })

  it('clearMessages 仅清当前 sid, 其他 sid 保留', () => {
    const { setTodos } = useAgentStore.getState()
    setTodos('sess-1', sampleTodos)
    setTodos('sess-2', [{ content: 'C', status: 'completed', activeForm: 'C' }])
    useAgentStore.getState().clearMessages()
    const s = useAgentStore.getState()
    expect(s.todosBySession['sess-1']).toBeUndefined()
    expect(s.todosBySession['sess-2']).toHaveLength(1)
  })

  it('upsertToolCall TodoWrite start 不进 messages, 不 bump segment', () => {
    useAgentStore.getState().upsertToolCall({
      eventId: 'start',
      sessionId: 'sess-1',
      ts: 1,
      turnIndex: 0,
      type: 'tool_use:start',
      toolUseId: 'toolu_todo_1',
      name: 'TodoWrite',
      input: { todos: sampleTodos },
    } as any)
    const s = useAgentStore.getState()
    expect(s.messages).toHaveLength(0)
    expect(s.textSegmentRev).toBe(0)
    expect(s.segmentedToolUseIds['toolu_todo_1']).toBeUndefined()
  })

  it('upsertToolCall TodoWrite done 触发 setTodos, 不进 messages', () => {
    useAgentStore.getState().upsertToolCall({
      eventId: 'done',
      sessionId: 'sess-1',
      ts: 1,
      turnIndex: 0,
      type: 'tool_use:done',
      toolUseId: 'toolu_todo_1',
      name: 'TodoWrite',
      input: { todos: sampleTodos },
    } as any)
    const s = useAgentStore.getState()
    expect(s.todosBySession['sess-1']).toEqual(sampleTodos)
    expect(s.messages).toHaveLength(0)
  })

  it('upsertToolCall TodoWrite done + 损坏 input → 静默忽略', () => {
    useAgentStore.getState().upsertToolCall({
      eventId: 'done-bad',
      sessionId: 'sess-1',
      ts: 1,
      turnIndex: 0,
      type: 'tool_use:done',
      toolUseId: 'toolu_todo_2',
      name: 'TodoWrite',
      input: { todos: [{ content: '', status: 'pending', activeForm: '' }] },
    } as any)
    const s = useAgentStore.getState()
    // 静默: 不 push messages, 不写 todosBySession
    expect(s.messages).toHaveLength(0)
    expect(s.todosBySession['sess-1']).toBeUndefined()
  })

  it('upsertToolCall 非 TodoWrite 工具正常 upsert', () => {
    useAgentStore.getState().upsertToolCall({
      eventId: 'start-bash',
      sessionId: 'sess-1',
      ts: 1,
      turnIndex: 0,
      type: 'tool_use:start',
      toolUseId: 'toolu_bash_1',
      name: 'Bash',
      input: { command: 'ls' },
    } as any)
    const s = useAgentStore.getState()
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]!.name).toBe('Bash')
    expect(s.textSegmentRev).toBe(1)
    expect(s.segmentedToolUseIds['toolu_bash_1']).toBe(true)
  })
})

describe('extractTodosFromTranscript', () => {
  it('提取最近一次 TodoWrite tool_use 的 todos', () => {
    const raw = [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'old', name: 'TodoWrite', input: { todos: [
              { content: 'old', status: 'pending', activeForm: 'old' },
            ]}},
          ],
        },
      },
      { type: 'user', message: { content: '继续' } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: '好的' },
            { type: 'tool_use', id: 'new', name: 'TodoWrite', input: { todos: sampleTodos } },
          ],
        },
      },
    ]
    expect(extractTodosFromTranscript(raw)).toEqual(sampleTodos)
  })

  it('没有 TodoWrite 时返回 null', () => {
    const raw = [{ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }]
    expect(extractTodosFromTranscript(raw)).toBeNull()
  })

  it('最近 TodoWrite 损坏时返回 null', () => {
    const raw = [{
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'x', name: 'TodoWrite', input: { todos: 'not-array' } },
        ],
      },
    }]
    expect(extractTodosFromTranscript(raw)).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试**

Run: `cd /Users/ethan/code/opencc-web/packages/zai && bun vitest run test/web/useAgentStore.todo.test.ts`
Expected: 9 个 test 全部 PASS。

- [ ] **Step 3: Commit**

```bash
git add packages/zai/test/web/useAgentStore.todo.test.ts
git commit -m "test(zai-web): useAgentStore todosBySession + extractTodosFromTranscript 单测"
```

---

## Task 11: zai-web TodoZone.test.tsx 单测

**Files:**
- Create: `packages/zai/test/web/TodoZone.test.tsx`

**Interfaces:**
- Consumes: `TodoZone` 组件、`TodoItem`。
- Produces: 4 个 vitest + @testing-library/react 测试覆盖渲染、计数、状态图标。

- [ ] **Step 1: 写测试**

```tsx
// packages/zai/test/web/TodoZone.test.tsx
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import TodoZone from '../../src/web/src/components/TodoZone.jsx'
import type { TodoItem } from '../../src/web/src/store/useAgentStore.js'

describe('TodoZone', () => {
  it('空 todos → render null', () => {
    const { container } = render(<TodoZone todos={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('3 项 todos → render 标题 + 3 项', () => {
    const todos: TodoItem[] = [
      { content: 'A', status: 'completed', activeForm: 'A' },
      { content: 'B', status: 'in_progress', activeForm: 'B' },
      { content: 'C', status: 'pending', activeForm: 'C' },
    ]
    render(<TodoZone todos={todos} />)
    expect(screen.getByText('3 tasks (1 done, 1 in progress, 1 open)')).toBeInTheDocument()
    expect(screen.getByText('A')).toBeInTheDocument()
    expect(screen.getByText('B')).toBeInTheDocument()
    expect(screen.getByText('C')).toBeInTheDocument()
  })

  it('completed 项渲染 ✓ 图标', () => {
    const todos: TodoItem[] = [
      { content: 'done-item', status: 'completed', activeForm: 'x' },
    ]
    const { container } = render(<TodoZone todos={todos} />)
    const li = container.querySelector('[data-testid="todo-item-completed"]')!
    expect(li.textContent).toContain('✓')
  })

  it('in_progress 项渲染 ■ 图标, pending 项渲染 ☐', () => {
    const todos: TodoItem[] = [
      { content: 'ip', status: 'in_progress', activeForm: 'x' },
      { content: 'pd', status: 'pending', activeForm: 'y' },
    ]
    const { container } = render(<TodoZone todos={todos} />)
    expect(container.querySelector('[data-testid="todo-item-in_progress"]')!.textContent).toContain('■')
    expect(container.querySelector('[data-testid="todo-item-pending"]')!.textContent).toContain('☐')
  })
})
```

- [ ] **Step 2: 跑测试**

Run: `cd /Users/ethan/code/opencc-web/packages/zai && bun vitest run test/web/TodoZone.test.tsx`
Expected: 4 个 test 全部 PASS。

- [ ] **Step 3: Commit**

```bash
git add packages/zai/test/web/TodoZone.test.tsx
git commit -m "test(zai-web): TodoZone 组件渲染 + 状态图标单测"
```

---

## Task 12: 完整回归

**Files:** 无修改

- [ ] **Step 1: 跑 agent-core 全套**

Run: `cd /Users/ethan/code/opencc-web/packages/zai-agent-core && bun vitest run`
Expected: 全部 PASS（包括新加的 TodoWriteTool 测试）。

- [ ] **Step 2: 跑 zai-web 全套**

Run: `cd /Users/ethan/code/opencc-web/packages/zai && bun vitest run`
Expected: 全部 PASS（包括新加的 todosBySession + TodoZone 测试）。

- [ ] **Step 3: 跑 zai 全套 typecheck + build**

Run: `cd /Users/ethan/code/opencc-web && bun tsc --noEmit -p packages/zai/tsconfig.json && bun tsc --noEmit -p packages/zai-agent-core/tsconfig.json`
Expected: exit 0。

Run: `cd /Users/ethan/code/opencc-web && bun run build`
Expected: exit 0。

- [ ] **Step 4: 手工 dev server 验证**

按 spec "手工验证" 6 项:

1. 启动 zai-web，让模型调用 TodoWrite → 对话上方立刻出现 todo 区。
2. TodoWrite 把全部项标 completed → todo 区消失（payload.todoCount=0 → todosBySession[sid]=[] → TodoZone render null）。
3. 切到其他 session → 当前 todo 区清空；切回 → todo 区恢复。
4. 刷新页面 → todo 区从 transcript 还原（extractTodosFromTranscript 命中最近一次 TodoWrite）。
5. 模型并行调 TodoWrite + BashTool → TodoZone 正常更新（TodoWrite 走守卫不进 messages），BashTool 卡片正常显示（ToolCallBlock 路径不变）。
6. `bun typecheck`、`bun run build`、`bun test` 全部通过。

- [ ] **Step 5: Commit（如有调整）**

如果手工验证发现任何调整，按"一改一提交"原则逐条 commit；无调整则跳过此步。

---

## 自检（Plan vs Spec）

| Spec 要求 | 覆盖任务 |
|---|---|
| In-scope 1: agent-core 注册 TodoWriteTool | Task 1/2/3 |
| In-scope 2: zai-web 对话区上方 TodoZone 组件 | Task 8/9 |
| In-scope 3: store todosBySession + TodoWrite 排除 messages | Task 4/5/6/7 |
| In-scope 4: transcript loadTranscript 还原 | Task 7 |
| 会话切换内存策略 | Task 5 (clearMessages/setCurrentSession/createNewSession) |
| UI 位置 / 样式 | Task 8/9/11 |
| 实时 vs transcript 双路径 | Task 6/7/10 |
| 错误处理与边界（空数组 / 损坏 / 并发） | Task 3/10/11 |
| 测试覆盖 | Task 3/10/11 |
| 不做的事（持久化 / TaskCreate 不改 / 不带 nudge / 不写 README） | 全部任务守住 |