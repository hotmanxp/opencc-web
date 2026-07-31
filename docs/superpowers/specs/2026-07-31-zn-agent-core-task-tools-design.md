# TaskCreate / TaskGet / TaskUpdate / TaskList 工具接入 zn-agent-core

> 设计日期:2026-07-31
> 范围:`packages/zn-agent-core` + `packages/zai` 前端 store / Agent 渲染层
> 取代:`TodoWrite` 工具路径 + 前端 `todosBySession` 渲染

## 1. 背景

zai 当前存在两套并行任务追踪机制:

1. **`TodoWrite` 工具**:LLM 调 `TodoWrite({todos:[{content,status,activeForm}]})`,前端在 `useAgentStore.todosBySession[sid]` 维护 in-memory 扁平 todo 列表。AGENTS.md §"TodoWrite 守卫" 描述: `upsertToolCall` 收到 `name==='TodoWrite'` 立刻吞掉不写 messages,在 `:done` 阶段解析 `input.todos` 写 `todosBySession[sid]`。
2. **V2 TaskList**:`compat/taskListStore.ts` 已实现完整 store(`create/list/get/update`,带 session 隔离 + 原子写 + stateChangeBus 事件 + auto-cleanup),前端 `v2TasksBySession` 已订阅 SSE `v2_task.changed` 增量。**但 LLM 调用的工具 wrapper 缺失**——`/api/agent/sessions/:sid/v2-tasks` 路由注释明确写:"写操作是 LLM 调 TaskCreate/Update tool,走 zai-agent-core 内部通道,不经过此路由",这条通道从未实现。

本次工作的目标:**为 LLM 实现 TaskCreate / TaskGet / TaskUpdate / TaskList 四个工具 wrapper,接到现成的 `TaskListStore`;同步移除 TodoWrite 路径,前端迁移到 v2TasksBySession 渲染。**

## 2. 设计目标

- **单一任务系统**:LLM 通过 4 个 Task 工具管任务,前端统一从 `v2TasksBySession` 渲染;TodoWrite 路径整体下线。
- **session 严格隔离**:任务按 `ctx.sessionId`(==`opts.transcriptId`)分桶,跨 session 不可见。
- **schema 最小化**:仅暴露 `subject / description / activeForm / status`;`owner / blocks / blockedBy` 在 `TaskListStore.TaskItem` 上保留字段,但工具 schema 不接受写入(为后续 sub-agent 任务派单预留后端字段,不污染 LLM 输入)。
- **模块化**:新建 `compat/tools/tasks/` 子目录,任务工具自包含,与 Bash/FileRead 等核心工具解耦。

## 3. 文件改动清单

### 3.1 新增

```
packages/zn-agent-core/src/compat/tools/tasks/
  ├── schemas.ts        # 4 个工具的 zod input schemas + 共享约束
  ├── TaskCreateTool.ts # executor 接 TaskListStore.create
  ├── TaskGetTool.ts    # executor 接 TaskListStore.get
  ├── TaskUpdateTool.ts # executor 接 TaskListStore.update
  ├── TaskListTool.ts   # executor 接 TaskListStore.list
  └── index.ts          # 4 个工具数组 + join buildDefaultTools
```

**`schemas.ts`**:

```ts
import { z } from 'zod'

export const SubjectSchema = z.string().min(1).max(200)
export const DescriptionSchema = z.string().max(2000).optional()
export const ActiveFormSchema = z.string().max(80).optional()
export const TaskIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/)
export const TaskStatusSchema = z.enum(['pending', 'in_progress', 'completed'])

export const TaskCreateInput = z.object({
  subject: SubjectSchema.describe('Short title of the task (1-200 chars).'),
  description: DescriptionSchema.describe('Optional longer description.'),
  activeForm: ActiveFormSchema.describe('Optional present-tense label shown when in_progress (e.g. "Implementing feature").'),
})

export const TaskGetInput = z.object({
  id: TaskIdSchema.describe('Task ID returned by TaskCreate or TaskList.'),
})

export const TaskUpdateInput = z.object({
  id: TaskIdSchema.describe('Task ID to update.'),
  status: TaskStatusSchema.optional().describe('New status.'),
  subject: SubjectSchema.optional().describe('Replace subject.'),
  description: DescriptionSchema.describe('Replace description.'),
  activeForm: ActiveFormSchema.describe('Replace activeForm.'),
})

export const TaskListInput = z.object({})
```

**`TaskCreateTool.ts`**(其他三个结构相同,executor 不同):

```ts
import { makeTool } from '../index.js'  // 复用 makeTool 工厂
import type { Tool } from '../runtime/types.js'
import { getTaskListStore } from '../../taskListStore.js'
import { TaskCreateInput } from './schemas.js'

async function createExecutor(
  input: z.infer<typeof TaskCreateInput>,
  ctx: { sessionId?: string },
): Promise<{ output: string }> {
  if (!ctx.sessionId) throw new Error('TaskCreate requires sessionId')
  const task = await getTaskListStore().create(ctx.sessionId, input)
  return { output: JSON.stringify(task) }
}

export const TaskCreateTool: Tool = makeTool({
  name: 'TaskCreate',
  description: 'Create a new task in the current session\'s task list...',
  inputSchema: TaskCreateInput,
  executor: createExecutor,
})
```

(完整描述文本在 §5 工具契约。)

**`tasks/index.ts`**:

```ts
import { TaskCreateTool } from './TaskCreateTool.js'
import { TaskGetTool } from './TaskGetTool.js'
import { TaskUpdateTool } from './TaskUpdateTool.js'
import { TaskListTool } from './TaskListTool.js'

export { TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool }
export const taskTools = [TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool]
```

每个 `*Tool.ts` 旁边配 `*Tool.test.ts`(单元测试,与 §8.1 对应)。

### 3.2 改动

| 文件 | 改动 |
|---|---|
| `packages/zn-agent-core/src/compat/tools/index.ts` | `buildDefaultTools()` 内追加 `...taskTools`(无条件启用,无需 env)。import 从 `./tasks/index.js` |
| `packages/zai/src/web/src/store/useAgentStore.ts` | 删除 `todosBySession: Record<string, TodoItem[]>` 字段、`applyTodoUpdate` reducer;删除 `upsertToolCall` 中 `name === 'TodoWrite'` 守卫分支;TaskStateEvent map 中删除 `todosBySession` |
| `packages/zai/src/web/src/pages/Agent.tsx` | 若有 todos 相关 props / 渲染,删除并改读 `v2TasksBySession`(已存在);`scheduleTaskListClearIfAllDone` 仍由 `v2TasksBySession` 触发 |

### 3.3 不改动

- `compat/taskListStore.ts`(已完整实现,无需改)
- `/api/agent/sessions/:sid/v2-tasks` GET 路由(已存在,继续作为冷启动兜底)
- `useBackgroundTasks` / 后台 BackgroundRuntime(与本任务正交)
- `compat/runtime/openccAdapter.ts`(无需新增 ctx 字段,`sessionId` 已在 toolCtx 中)

## 4. 数据流

```
LLM: tool_use(name="TaskCreate", input={subject:"...", description:"..."})
  │
  ▼
runOpenccQuery (openccAdapter.ts:583)
  ├─ toolsByName.get('TaskCreate') → TaskCreateTool
  ├─ toolCtx = { cwd, sessionId: opts.sessionId ?? opts.transcriptId ?? 'unknown', ... }
  └─ tool.call(input, toolCtx) → TaskCreateTool.executor
        │
        ▼
      getTaskListStore().create(sessionId, input)
        ├─ TaskListStore.create(sessionId, { subject, description, activeForm })
        │   ├─ randomUUID().slice(0,8) → id
        │   ├─ loadSession(sessionId) → map
        │   ├─ map.set(id, task)
        │   ├─ saveSession(sessionId, map)   # tmp + rename 原子写
        │   └─ stateChangeBus.emit('v2_task.changed', { sessionId, task, action:'upsert' })
        └─ return task
        │
        ▼
      { output: JSON.stringify(task) }
        │
        ▼
runOpenccQuery 拼 tool_result 块 → 下轮 turn LLM 看到 task JSON
        │
        ▼  (并行)
stateChangeBus('v2_task.changed') → state-to-event 桥接层
  → SSE event: state.v2_task.changed
  → 前端 useAgentStore.applyV2TaskChange → v2TasksBySession[sid].push(task)
  → Agent.tsx 渲染(v2TasksBySession 已存在)
```

TaskGet / TaskUpdate / TaskList 数据流同理,核心是 store 调用 + SSE 推送。

## 5. 工具契约

### 5.1 TaskCreate

- **Name**: `TaskCreate`
- **Description**:
  > Create a new task in the current session's task list. Tasks track multi-step work — use them to break down complex requests into trackable units. Returns the created task (with assigned id). Persists to disk and pushes a v2_task.changed SSE event so the UI updates live.
- **Input**: `{ subject, description?, activeForm? }`
- **Output**: JSON string of `TaskItem`(`{ id, sessionId, subject, status:'pending', ... }`)
- **Errors**: sessionId 缺失 → 抛错 → is_error:true;zod 校验失败 → makeTool 兜底路径

### 5.2 TaskGet

- **Name**: `TaskGet`
- **Description**:
  > Retrieve a single task by id. Returns null payload if the task doesn't exist or belongs to another session.
- **Input**: `{ id }`
- **Output**: JSON string of `TaskItem | null`
- **Errors**: 任务不存在 → `{"output":"[error] task not found: <id>"}`(非抛错,LLM 可重试)

### 5.3 TaskUpdate

- **Name**: `TaskUpdate`
- **Description**:
  > Update an existing task. Use status='in_progress' when starting, status='completed' when done. Auto-cleanup: when all tasks in a session reach terminal status (completed / deleted), the session's task file is removed.
- **Input**: `{ id, status?, subject?, description?, activeForm? }`
- **Output**: JSON string of updated `TaskItem`;若 id 不存在或跨 session,返回字符串 `"null"`(LLM 解析后看到 JS null)
- **Side effects**: 触发 auto-cleanup(若全 session 终态)

### 5.4 TaskList

- **Name**: `TaskList`
- **Description**:
  > List all non-deleted tasks for the current session. Returns an array sorted by createdAt ascending. Use this when you need to see current state before updating.
- **Input**: `{}`
- **Output**: JSON string of `TaskItem[]`,按 `createdAt` 升序(与 `TaskListStore.list()` 一致);空数组若无任务

## 6. 前端迁移

### 6.1 useAgentStore 改动

**删除**:

```ts
// type & state
todosBySession: Record<string, TodoItem[]>

// reducer
applyTodoUpdate(sessionId, todos)

// upsertToolCall 中的 TodoWrite 守卫分支:
// if (name === 'TodoWrite') { ... ; return }

// TaskStateEvent map 中的 todosBySession 字段(若有则删,无则保持现状)
```

**保留**:

- `v2TasksBySession` 全套逻辑(`applyV2TaskChange` reducer、`v2_task.changed` 事件订阅)
- `scheduleTaskListClearIfAllDone`(改由 `v2TasksBySession` 触发终态检查)

### 6.2 Agent.tsx 改动

- 删除 todos 相关 props(若有则删,无则保持现状)
- 渲染路径:AgentInputBox 已经从 store 直接取 `v2TasksBySession` 显示任务摘要(参考 AGENTS.md §"AgentInputBox 内部从 store 直接取"),确认渲染组件无 todos 残留

## 7. 错误处理矩阵

| 场景 | 行为 | LLM 可见性 |
|---|---|---|
| `ctx.sessionId` 缺失 | executor 抛 `Error('TaskCreate requires sessionId')` | is_error:true 走 runtime.tool_result 错误路径 |
| `ctx.sessionId === 'unknown'`(opts 没传 transcriptId/sessionId) | 同上抛错 | 同上 |
| TaskGet / TaskUpdate 的 id 不存在或跨 session | executor 返回 `{ output: "[error] task not found: <id>" }`(TaskGet)或 `{ output: "null" }`(TaskUpdate,LLM 可读 JS null) | LLM 看到错误字符串/null,可调 TaskList 重试 |
| zod 校验失败(空 subject / status 拼写错) | makeTool safeParse 失败返回 `{ output: "[error] invalid input for <name>: <details>" }` | LLM 看到 zod issue 列表 |
| TaskUpdate 推到终态 + 全 session 终态 | TaskListStore.update 内触发 `deleteSession`(已有逻辑) | 文件删除 + stateChangeBus 推 per-task delete 事件 |
| 并发写(同 session 多 tool_use 串行触发 saveSession) | `tmp + rename` 原子写保护;并发窗口下最后写入胜出 | 无副作用 |
| 磁盘 I/O 错误 | store 抛错 → executor 抛错 → is_error:true | LLM 看到错误信息 |

## 8. 测试

### 8.1 单元测试

`packages/zn-agent-core/src/compat/tools/tasks/*.test.ts`:

- **TaskCreate**:用 `setTaskListStore(new TaskListStore(tmpDir))` 注入临时 dataDir;调 executor({subject,description});断言返回 task 含正确字段 + 文件落盘 + stateChangeBus emit 调用
- **TaskGet**:seed 一个 task 后调 executor({id});断言返回完整 task;不存在的 id 返回 null
- **TaskUpdate**:seed 后改 status;断言文件更新 + stateChangeBus emit;推到 completed + 全终态时断言 file 被删
- **TaskList**:seed 3 个 task;executor({});断言返回 3 个;deleted task 被过滤
- **session 隔离**:session A 创建 task,session B 调 TaskGet 同 id 返回 null

### 8.2 集成测试

`packages/zn-agent-core/test/runtime/taskToolsIntegration.test.ts`:

- mock modelCaller 输出 `tool_use(name='TaskCreate', input={subject:'x'})`
- 断言 runOpenccQuery 走通:tool 调用 → tool_result 拼接 → 下轮 turn 发出 → 最终 runtime.done
- 断言 stateChangeBus('v2_task.changed') 被 emit
- 断言 4 个工具都在 `mergedTools` 里(modelCaller 拿到的 tool 列表)

### 8.3 前端测试

`packages/zai/src/web/src/store/useAgentStore.test.ts`:

- 断言 `todosBySession` 字段已移除(类型层面)
- 断言 `upsertToolCall` 不再有 TodoWrite 守卫分支(直接走 tool_result 渲染)
- v2TasksBySession 相关断言保留

`packages/zai/src/web/src/pages/Agent.test.tsx`(若有):

- 渲染时无 todos 残留 props(若有 Agent.test.tsx,断言改读 v2TasksBySession;无则跳过此断言)

## 9. 验收标准

- ✅ `compat/tools/index.ts` 的 `buildDefaultTools()` 返回包含 TaskCreate/TaskGet/TaskUpdate/TaskList 4 个工具
- ✅ 4 个工具的 executor 在 `ctx.sessionId` 缺失时抛错
- ✅ TaskListStore.create / get / update / list 被正确调用 + 写盘 + stateChangeBus emit
- ✅ 前端 `useAgentStore` 不再有 `todosBySession` 字段 / `applyTodoUpdate` reducer / TodoWrite 守卫
- ✅ 前端 Agent 渲染路径无 todosBySession 残留引用
- ✅ 单元 + 集成测试通过(`pnpm --filter @zn-ai/zn-agent-core test` + 前端 vitest)
- ✅ `pnpm --filter @zn-ai/zn-agent-core typecheck` + 前端 tsc 通过

## 10. 不在范围内

- `owner / blocks / blockedBy` 字段不暴露给 LLM(本阶段);`TaskListStore.TaskItem` 字段保留,后续 sub-agent 任务派单阶段再启用
- 不引入 in-process teammate 共享任务机制(独立 spec)
- 不改 `runOpenccQuery` 的 toolCtx 形状(已含 sessionId,无需新增字段)
- 不动后台 BackgroundRuntime 与其 store(JsonTaskStore)
- 不动 `/api/agent/sessions/:sid/v2-tasks` GET 路由(冷启动兜底继续生效)
- 不引入 TaskList 工具的 system prompt 注入(LLM 从工具 description 即可学会用法)

## 11. 风险与回退

| 风险 | 缓解 |
|---|---|
| 现有依赖 TodoWrite 的 LLM prompt / 测试 fixture 失效 | grep 排查:`grep -r "TodoWrite\|todosBySession" packages/` —— 预期仅命中 store + Agent.tsx + 历史测试 |
| 前端 v2TasksBySession 渲染路径有 bug 导致任务不可见 | 单元测试 + 手动验证:LLM 调 TaskCreate → store → SSE → 前端 UI 出现新任务 |
| auto-cleanup 太激进(LLM 完成最后任务 → 文件删 → 下轮看不到历史) | TaskListStore.update 已有逻辑:仅"全 session 终态"才删;中间状态保留 |
| `ctx.sessionId === 'unknown'` 路径触发抛错 | runOpenccQuery line 99 已用 `opts.sessionId ?? opts.transcriptId ?? 'unknown'`;zai-server 总是传两者之一,实际不会触发;但兜底抛错优于静默 |
| blocks/blockedBy 字段缺失导致 sub-agent 任务派单需求无法满足 | 留作 Phase 2 独立 spec |

## 12. 实施计划

按以下顺序实施,每步可独立 commit:

1. **新增 compat/tools/tasks/ 目录与 4 个工具**(零前端依赖,可单测)
2. **接入 buildDefaultTools**(compat/tools/index.ts 改动)
3. **单元 + 集成测试**
4. **前端 useAgentStore 清理**(删 todosBySession + TodoWrite 守卫)
5. **前端 Agent.tsx 路径验证**(若有 todos 残留引用则改 v2TasksBySession)
6. **前端 typecheck + 测试**

完整实施步骤与代码片段由独立的 plan 文档提供,本文仅描述目标状态。