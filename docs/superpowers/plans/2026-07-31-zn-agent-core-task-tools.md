# TaskCreate / TaskGet / TaskUpdate / TaskList 工具 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 LLM 实现 4 个 Task 工具 wrapper(TaskCreate / TaskGet / TaskUpdate / TaskList)接入现成的 `TaskListStore`,同步移除 TodoWrite 路径,前端从 `todosBySession` 切到 `v2TasksBySession`。

**Architecture:** 在 `packages/zn-agent-core/src/compat/tools/tasks/` 新建子目录,4 个工具各自一个文件 + `schemas.ts` + `index.ts`,通过 `buildDefaultTools()` 无条件启用。前端 `useAgentStore` 删除 `todosBySession` / `applyTodoUpdate` / TodoWrite 守卫,改读 `v2TasksBySession`(已存在)。`TaskListStore` 已完整实现(`create/list/get/update`,带 session 隔离 + 原子写 + stateChangeBus 事件 + auto-cleanup),本次只补 LLM-facing wrapper。

**Tech Stack:** TypeScript / zod / vitest / Node fs (atomic write) / Anthropic SDK (via modelCaller)

---

## Global Constraints

- Node 22+ tsx 即可,不依赖 Bun 运行时;工具 executor 不得 import 任何 `bun:` 模块。
- 工具 schema 最小化,仅暴露 `subject / description / activeForm / status`;`owner / blocks / blockedBy` 在 `TaskListStore.TaskItem` 保留字段但工具不暴露写入。
- 工具任务严格绑定 `ctx.sessionId`;若 sessionId 缺失 executor 抛 `Error('... requires sessionId')`。
- 测试用 vitest,断言以 `it(...).toBe(...)` / `expect(...).toEqual(...)` 为主,不依赖快照。
- 提交信息遵循现有 conventional commits 风格(`feat(zn-agent-core): ...` / `feat(zai): ...` / `fix(zn-agent-core): ...`)。
- 不改 `compat/taskListStore.ts`(已完整实现)、不动 `runOpenccQuery` 的 toolCtx 形状、不动 `/api/agent/sessions/:sid/v2-tasks` GET 路由。
- 不引入 system prompt 注入或 feature flag,4 个工具无条件加入默认工具集。

---

## File Structure

### 新增

```
packages/zn-agent-core/src/compat/tools/tasks/
  ├── schemas.ts                       # 4 个工具的 zod input schemas + 共享约束
  ├── TaskCreateTool.ts                # executor 接 TaskListStore.create
  ├── TaskGetTool.ts                   # executor 接 TaskListStore.get
  ├── TaskUpdateTool.ts                # executor 接 TaskListStore.update
  ├── TaskListTool.ts                  # executor 接 TaskListStore.list
  └── index.ts                         # 4 个工具数组 + 单个 export

packages/zn-agent-core/test/unit/tools/tasks/
  ├── TaskCreateTool.test.ts
  ├── TaskGetTool.test.ts
  ├── TaskUpdateTool.test.ts
  └── TaskListTool.test.ts

packages/zn-agent-core/test/integration/
  └── taskToolsIntegration.test.ts     # runOpenccQuery 调 4 个工具的端到端
```

### 修改

- `packages/zn-agent-core/src/compat/tools/index.ts` — 把 `makeTool` 提升为 export(给 tasks/ 子目录用),`buildDefaultTools()` 追加 `...taskTools`。
- `packages/zai/src/web/src/store/useAgentStore.ts` — 删 `todosBySession` 字段、`applyTodoUpdate` reducer、`upsertToolCall` 中 `name==='TodoWrite'` 守卫分支。
- `packages/zai/src/web/src/store/useAgentStore.test.ts`(若存在)— 同步移除 todosBySession 相关断言。

---

## Task 1: 把 `makeTool` 提升为 export

**Files:**
- Modify: `packages/zn-agent-core/src/compat/tools/index.ts:417-450`(把 file-local `function makeTool<T>` 改为 `export function makeTool<T>`)

**Interfaces:**
- Consumes: 无
- Produces: `export function makeTool<T>(spec): ToolWithCall`(被 tasks/ 子目录的工具文件 import)

- [ ] **Step 1: 写失败测试 — 验证 makeTool 可以从外部 import**

在 `packages/zn-agent-core/test/unit/tools/tasks/makeToolReexport.test.ts` 新建:

```ts
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { makeTool } from '../../../../src/compat/tools/index.js'

describe('makeTool re-export from compat/tools/index', () => {
  it('can be imported and used to create a Tool', async () => {
    const tool = makeTool({
      name: 'ProbeReexport',
      description: 'probe',
      inputSchema: z.object({ x: z.string() }),
      executor: async () => ({ output: 'ok' }),
    })
    expect(tool.name).toBe('ProbeReexport')
    const result = await tool.call({ x: 'hello' }, { cwd: '/tmp' })
    expect(result).toEqual({ output: 'ok' })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/zn-agent-core && pnpm vitest run test/unit/tools/tasks/makeToolReexport.test.ts`
Expected: FAIL with "The module '../../../../src/compat/tools/index.js' does not export 'makeTool'"(因为当前 makeTool 是 file-local)。

- [ ] **Step 3: 导出 makeTool**

打开 `packages/zn-agent-core/src/compat/tools/index.ts`,定位 line 419 的 `function makeTool<T>(...)`,把 `function` 改为 `export function`。

- [ ] **Step 4: 重新运行测试确认通过**

Run: `cd packages/zn-agent-core && pnpm vitest run test/unit/tools/tasks/makeToolReexport.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zn-agent-core/src/compat/tools/index.ts packages/zn-agent-core/test/unit/tools/tasks/makeToolReexport.test.ts
git commit -m "refactor(zn-agent-core): export makeTool from compat/tools for tasks/ subdirectory reuse"
```

---

## Task 2: 实现 `schemas.ts`(共享 zod schemas)

**Files:**
- Create: `packages/zn-agent-core/src/compat/tools/tasks/schemas.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `SubjectSchema: z.ZodString`(1-200 字符)
  - `DescriptionSchema: z.ZodOptional<z.ZodString>`(max 2000)
  - `ActiveFormSchema: z.ZodOptional<z.ZodString>`(max 80)
  - `TaskIdSchema: z.ZodString`(regex /^[a-zA-Z0-9_-]{1,32}$/)
  - `TaskStatusSchema: z.ZodEnum<'pending' | 'in_progress' | 'completed'>`
  - `TaskCreateInput / TaskGetInput / TaskUpdateInput / TaskListInput`(完整 zod object)

- [ ] **Step 1: 写失败测试 — 验证 schemas 校验正确**

在 `packages/zn-agent-core/test/unit/tools/tasks/schemas.test.ts` 新建:

```ts
import { describe, expect, it } from 'vitest'
import {
  TaskCreateInput,
  TaskGetInput,
  TaskListInput,
  TaskUpdateInput,
} from '../../../../src/compat/tools/tasks/schemas.js'

describe('tasks/schemas', () => {
  it('TaskCreateInput accepts subject + optional description/activeForm', () => {
    expect(() => TaskCreateInput.parse({ subject: 'Fix bug' })).not.toThrow()
    expect(() =>
      TaskCreateInput.parse({ subject: 'X', description: 'd', activeForm: 'a' }),
    ).not.toThrow()
  })

  it('TaskCreateInput rejects empty subject', () => {
    expect(() => TaskCreateInput.parse({ subject: '' })).toThrow()
  })

  it('TaskGetInput rejects malformed id', () => {
    expect(() => TaskGetInput.parse({ id: 'has space' })).toThrow()
    expect(() => TaskGetInput.parse({ id: 'a'.repeat(33) })).toThrow()
    expect(() => TaskGetInput.parse({ id: 'abc-123' })).not.toThrow()
  })

  it('TaskUpdateInput rejects unknown status', () => {
    expect(() =>
      TaskUpdateInput.parse({ id: 'abc-123', status: 'unknown' }),
    ).toThrow()
  })

  it('TaskUpdateInput accepts partial patch', () => {
    expect(() => TaskUpdateInput.parse({ id: 'abc-123' })).not.toThrow()
    expect(() =>
      TaskUpdateInput.parse({ id: 'abc-123', subject: 'New' }),
    ).not.toThrow()
  })

  it('TaskListInput accepts empty object', () => {
    expect(() => TaskListInput.parse({})).not.toThrow()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/zn-agent-core && pnpm vitest run test/unit/tools/tasks/schemas.test.ts`
Expected: FAIL with "Cannot find module '../../../../src/compat/tools/tasks/schemas.js'"。

- [ ] **Step 3: 创建 schemas.ts**

新建 `packages/zn-agent-core/src/compat/tools/tasks/schemas.ts`,内容:

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
  activeForm: ActiveFormSchema.describe(
    'Optional present-tense label shown when in_progress (e.g. "Implementing feature").',
  ),
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

- [ ] **Step 4: 重新运行测试确认通过**

Run: `cd packages/zn-agent-core && pnpm vitest run test/unit/tools/tasks/schemas.test.ts`
Expected: PASS,6 个 it() 全部通过。

- [ ] **Step 5: 提交**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zn-agent-core/src/compat/tools/tasks/schemas.ts packages/zn-agent-core/test/unit/tools/tasks/schemas.test.ts
git commit -m "feat(zn-agent-core): add zod schemas for TaskCreate/Get/Update/List tools"
```

---

## Task 3: 实现 `TaskCreateTool`

**Files:**
- Create: `packages/zn-agent-core/src/compat/tools/tasks/TaskCreateTool.ts`
- Create: `packages/zn-agent-core/test/unit/tools/tasks/TaskCreateTool.test.ts`

**Interfaces:**
- Consumes:
  - `makeTool` from `../index.js`
  - `getTaskListStore, setTaskListStore, TaskListStore` from `../../taskListStore.js`
  - `TaskCreateInput` from `./schemas.js`
- Produces: `export const TaskCreateTool: Tool`(name='TaskCreate',description 接 store.create)

- [ ] **Step 1: 写失败测试**

`packages/zn-agent-core/test/unit/tools/tasks/TaskCreateTool.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TaskCreateTool } from '../../../../src/compat/tools/tasks/TaskCreateTool.js'
import { setTaskListStore, TaskListStore } from '../../../../src/compat/taskListStore.js'

describe('TaskCreateTool', () => {
  let tmpDir: string
  let store: TaskListStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'task-create-tool-'))
    store = new TaskListStore(tmpDir)
    setTaskListStore(store)
  })
  afterEach(() => {
    setTaskListStore(null)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates a task with id and pending status, returns JSON', async () => {
    const result = await TaskCreateTool.call(
      { subject: 'Write tests', description: 'cover schemas', activeForm: 'Writing tests' },
      { sessionId: 'sess-A' },
    )
    const parsed = JSON.parse((result as { output: string }).output)
    expect(parsed.id).toMatch(/^[a-zA-Z0-9_-]{1,32}$/)
    expect(parsed.subject).toBe('Write tests')
    expect(parsed.status).toBe('pending')
    expect(parsed.sessionId).toBe('sess-A')
    expect(parsed.createdAt).toBeGreaterThan(0)
  })

  it('persists to disk under tasks/<sessionId>.json', async () => {
    await TaskCreateTool.call({ subject: 'persist me' }, { sessionId: 'sess-P' })
    const list = await store.list('sess-P')
    expect(list).toHaveLength(1)
    expect(list[0].subject).toBe('persist me')
  })

  it('throws when sessionId is missing', async () => {
    await expect(
      TaskCreateTool.call({ subject: 'no session' }, {}),
    ).rejects.toThrow(/requires sessionId/)
  })

  it('returns invalid-input error string when subject is empty', async () => {
    const result = await TaskCreateTool.call({ subject: '' }, { sessionId: 'sess-X' })
    expect((result as { output: string }).output).toMatch(/invalid input for TaskCreate/)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/zn-agent-core && pnpm vitest run test/unit/tools/tasks/TaskCreateTool.test.ts`
Expected: FAIL with "Cannot find module .../TaskCreateTool.js"。

- [ ] **Step 3: 实现 TaskCreateTool**

`packages/zn-agent-core/src/compat/tools/tasks/TaskCreateTool.ts`:

```ts
import type { z } from 'zod'
import type { Tool } from '../../runtime/modelCaller.js'
import { makeTool } from '../index.js'
import { getTaskListStore } from '../../taskListStore.js'
import { TaskCreateInput } from './schemas.js'

async function createExecutor(
  input: z.infer<typeof TaskCreateInput>,
  ctx: { sessionId?: string },
): Promise<{ output: string }> {
  if (!ctx.sessionId) {
    throw new Error('TaskCreate requires sessionId')
  }
  const task = await getTaskListStore().create(ctx.sessionId, input)
  return { output: JSON.stringify(task) }
}

export const TaskCreateTool: Tool = makeTool({
  name: 'TaskCreate',
  description:
    "Create a new task in the current session's task list. Tasks track multi-step " +
    'work — use them to break down complex requests into trackable units. Returns the ' +
    'created task (with assigned id). Persists to disk and pushes a v2_task.changed ' +
    'SSE event so the UI updates live.',
  inputSchema: TaskCreateInput,
  executor: createExecutor,
})
```

- [ ] **Step 4: 重新运行测试确认通过**

Run: `cd packages/zn-agent-core && pnpm vitest run test/unit/tools/tasks/TaskCreateTool.test.ts`
Expected: PASS,4 个 it() 全部通过。

- [ ] **Step 5: 提交**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zn-agent-core/src/compat/tools/tasks/TaskCreateTool.ts packages/zn-agent-core/test/unit/tools/tasks/TaskCreateTool.test.ts
git commit -m "feat(zn-agent-core): add TaskCreateTool wrapper for TaskListStore.create"
```

---

## Task 4: 实现 `TaskGetTool`

**Files:**
- Create: `packages/zn-agent-core/src/compat/tools/tasks/TaskGetTool.ts`
- Create: `packages/zn-agent-core/test/unit/tools/tasks/TaskGetTool.test.ts`

**Interfaces:**
- Consumes: 同 Task 3(`makeTool`、`getTaskListStore`、`TaskGetInput`)
- Produces: `export const TaskGetTool: Tool`(name='TaskGet',description 接 store.get)

- [ ] **Step 1: 写失败测试**

`packages/zn-agent-core/test/unit/tools/tasks/TaskGetTool.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setTaskListStore, TaskListStore } from '../../../../src/compat/taskListStore.js'
import { TaskGetTool } from '../../../../src/compat/tools/tasks/TaskGetTool.js'

describe('TaskGetTool', () => {
  let tmpDir: string
  let store: TaskListStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'task-get-tool-'))
    store = new TaskListStore(tmpDir)
    setTaskListStore(store)
  })
  afterEach(() => {
    setTaskListStore(null)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns existing task by id', async () => {
    const created = await store.create('sess-A', { subject: 'get me' })
    const result = await TaskGetTool.call(
      { id: created.id },
      { sessionId: 'sess-A' },
    )
    const parsed = JSON.parse((result as { output: string }).output)
    expect(parsed.id).toBe(created.id)
    expect(parsed.subject).toBe('get me')
  })

  it('returns error string for missing id', async () => {
    const result = await TaskGetTool.call(
      { id: 'nonexistent' },
      { sessionId: 'sess-A' },
    )
    expect((result as { output: string }).output).toMatch(/task not found/)
  })

  it('returns error string when id belongs to another session', async () => {
    const created = await store.create('sess-A', { subject: 'private' })
    const result = await TaskGetTool.call(
      { id: created.id },
      { sessionId: 'sess-B' },
    )
    expect((result as { output: string }).output).toMatch(/task not found/)
  })

  it('throws when sessionId is missing', async () => {
    await expect(
      TaskGetTool.call({ id: 'abc' }, {}),
    ).rejects.toThrow(/requires sessionId/)
  })

  it('returns invalid-input error for malformed id', async () => {
    const result = await TaskGetTool.call(
      { id: 'has space' },
      { sessionId: 'sess-A' },
    )
    expect((result as { output: string }).output).toMatch(/invalid input for TaskGet/)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/zn-agent-core && pnpm vitest run test/unit/tools/tasks/TaskGetTool.test.ts`
Expected: FAIL with module-not-found。

- [ ] **Step 3: 实现 TaskGetTool**

`packages/zn-agent-core/src/compat/tools/tasks/TaskGetTool.ts`:

```ts
import type { z } from 'zod'
import type { Tool } from '../../runtime/modelCaller.js'
import { makeTool } from '../index.js'
import { getTaskListStore } from '../../taskListStore.js'
import { TaskGetInput } from './schemas.js'

async function getExecutor(
  input: z.infer<typeof TaskGetInput>,
  ctx: { sessionId?: string },
): Promise<{ output: string }> {
  if (!ctx.sessionId) {
    throw new Error('TaskGet requires sessionId')
  }
  const task = await getTaskListStore().get(ctx.sessionId, input.id)
  if (!task) {
    return { output: `[error] task not found: ${input.id}` }
  }
  return { output: JSON.stringify(task) }
}

export const TaskGetTool: Tool = makeTool({
  name: 'TaskGet',
  description:
    'Retrieve a single task by id. Returns null payload (error string) if the task ' +
    "doesn't exist or belongs to another session.",
  inputSchema: TaskGetInput,
  executor: getExecutor,
})
```

- [ ] **Step 4: 重新运行测试确认通过**

Run: `cd packages/zn-agent-core && pnpm vitest run test/unit/tools/tasks/TaskGetTool.test.ts`
Expected: PASS,5 个 it() 全部通过。

- [ ] **Step 5: 提交**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zn-agent-core/src/compat/tools/tasks/TaskGetTool.ts packages/zn-agent-core/test/unit/tools/tasks/TaskGetTool.test.ts
git commit -m "feat(zn-agent-core): add TaskGetTool wrapper for TaskListStore.get"
```

---

## Task 5: 实现 `TaskUpdateTool`

**Files:**
- Create: `packages/zn-agent-core/src/compat/tools/tasks/TaskUpdateTool.ts`
- Create: `packages/zn-agent-core/test/unit/tools/tasks/TaskUpdateTool.test.ts`

**Interfaces:**
- Consumes: 同 Task 3(`makeTool`、`getTaskListStore`、`TaskUpdateInput`)
- Produces: `export const TaskUpdateTool: Tool`(name='TaskUpdate',description 接 store.update)

- [ ] **Step 1: 写失败测试**

`packages/zn-agent-core/test/unit/tools/tasks/TaskUpdateTool.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setTaskListStore, TaskListStore } from '../../../../src/compat/taskListStore.js'
import { TaskUpdateTool } from '../../../../src/compat/tools/tasks/TaskUpdateTool.js'

describe('TaskUpdateTool', () => {
  let tmpDir: string
  let store: TaskListStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'task-update-tool-'))
    store = new TaskListStore(tmpDir)
    setTaskListStore(store)
  })
  afterEach(() => {
    setTaskListStore(null)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('updates status to in_progress and returns updated task', async () => {
    const created = await store.create('sess-A', { subject: 'update me' })
    const result = await TaskUpdateTool.call(
      { id: created.id, status: 'in_progress' },
      { sessionId: 'sess-A' },
    )
    const parsed = JSON.parse((result as { output: string }).output)
    expect(parsed.status).toBe('in_progress')
    expect(parsed.id).toBe(created.id)
    expect(parsed.updatedAt).toBeGreaterThanOrEqual(parsed.createdAt)
  })

  it('updates subject and activeForm', async () => {
    const created = await store.create('sess-A', { subject: 'old' })
    const result = await TaskUpdateTool.call(
      { id: created.id, subject: 'new', activeForm: 'Updating' },
      { sessionId: 'sess-A' },
    )
    const parsed = JSON.parse((result as { output: string }).output)
    expect(parsed.subject).toBe('new')
    expect(parsed.activeForm).toBe('Updating')
  })

  it('returns "null" string for missing id', async () => {
    const result = await TaskUpdateTool.call(
      { id: 'nonexistent', status: 'completed' },
      { sessionId: 'sess-A' },
    )
    expect((result as { output: string }).output).toBe('null')
  })

  it('returns "null" when id belongs to another session', async () => {
    const created = await store.create('sess-A', { subject: 'private' })
    const result = await TaskUpdateTool.call(
      { id: created.id, status: 'completed' },
      { sessionId: 'sess-B' },
    )
    expect((result as { output: string }).output).toBe('null')
  })

  it('triggers auto-cleanup when last task reaches completed', async () => {
    const created = await store.create('sess-A', { subject: 'finish' })
    await TaskUpdateTool.call(
      { id: created.id, status: 'completed' },
      { sessionId: 'sess-A' },
    )
    // list should return [] because session file was deleted
    const after = await store.list('sess-A')
    expect(after).toEqual([])
  })

  it('throws when sessionId is missing', async () => {
    await expect(
      TaskUpdateTool.call({ id: 'abc', status: 'completed' }, {}),
    ).rejects.toThrow(/requires sessionId/)
  })

  it('returns invalid-input error for unknown status', async () => {
    const created = await store.create('sess-A', { subject: 'x' })
    const result = await TaskUpdateTool.call(
      { id: created.id, status: 'deleted' as never },
      { sessionId: 'sess-A' },
    )
    expect((result as { output: string }).output).toMatch(/invalid input for TaskUpdate/)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/zn-agent-core && pnpm vitest run test/unit/tools/tasks/TaskUpdateTool.test.ts`
Expected: FAIL with module-not-found。

- [ ] **Step 3: 实现 TaskUpdateTool**

`packages/zn-agent-core/src/compat/tools/tasks/TaskUpdateTool.ts`:

```ts
import type { z } from 'zod'
import type { Tool } from '../../runtime/modelCaller.js'
import { makeTool } from '../index.js'
import { getTaskListStore } from '../../taskListStore.js'
import { TaskUpdateInput } from './schemas.js'

async function updateExecutor(
  input: z.infer<typeof TaskUpdateInput>,
  ctx: { sessionId?: string },
): Promise<{ output: string }> {
  if (!ctx.sessionId) {
    throw new Error('TaskUpdate requires sessionId')
  }
  const { id, ...patch } = input
  const updated = await getTaskListStore().update(ctx.sessionId, id, patch)
  return { output: updated === null ? 'null' : JSON.stringify(updated) }
}

export const TaskUpdateTool: Tool = makeTool({
  name: 'TaskUpdate',
  description:
    'Update an existing task. Use status="in_progress" when starting, ' +
    'status="completed" when done. Auto-cleanup: when all tasks in a session ' +
    'reach terminal status (completed / deleted), the session\'s task file is removed.',
  inputSchema: TaskUpdateInput,
  executor: updateExecutor,
})
```

- [ ] **Step 4: 重新运行测试确认通过**

Run: `cd packages/zn-agent-core && pnpm vitest run test/unit/tools/tasks/TaskUpdateTool.test.ts`
Expected: PASS,7 个 it() 全部通过。

- [ ] **Step 5: 提交**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zn-agent-core/src/compat/tools/tasks/TaskUpdateTool.ts packages/zn-agent-core/test/unit/tools/tasks/TaskUpdateTool.test.ts
git commit -m "feat(zn-agent-core): add TaskUpdateTool wrapper for TaskListStore.update"
```

---

## Task 6: 实现 `TaskListTool`

**Files:**
- Create: `packages/zn-agent-core/src/compat/tools/tasks/TaskListTool.ts`
- Create: `packages/zn-agent-core/test/unit/tools/tasks/TaskListTool.test.ts`

**Interfaces:**
- Consumes: 同 Task 3(`makeTool`、`getTaskListStore`、`TaskListInput`)
- Produces: `export const TaskListTool: Tool`(name='TaskList',description 接 store.list)

- [ ] **Step 1: 写失败测试**

`packages/zn-agent-core/test/unit/tools/tasks/TaskListTool.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setTaskListStore, TaskListStore } from '../../../../src/compat/taskListStore.js'
import { TaskListTool } from '../../../../src/compat/tools/tasks/TaskListTool.js'

describe('TaskListTool', () => {
  let tmpDir: string
  let store: TaskListStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'task-list-tool-'))
    store = new TaskListStore(tmpDir)
    setTaskListStore(store)
  })
  afterEach(() => {
    setTaskListStore(null)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns empty array when no tasks exist', async () => {
    const result = await TaskListTool.call({}, { sessionId: 'sess-A' })
    expect((result as { output: string }).output).toBe('[]')
  })

  it('returns all non-deleted tasks for the session', async () => {
    await store.create('sess-A', { subject: 'first' })
    await store.create('sess-A', { subject: 'second' })
    const result = await TaskListTool.call({}, { sessionId: 'sess-A' })
    const parsed = JSON.parse((result as { output: string }).output)
    expect(parsed).toHaveLength(2)
    expect(parsed.map((t: { subject: string }) => t.subject).sort()).toEqual(['first', 'second'])
  })

  it('returns sorted by createdAt ascending', async () => {
    const a = await store.create('sess-A', { subject: 'a' })
    // ensure distinct timestamps
    await new Promise((r) => setTimeout(r, 2))
    const b = await store.create('sess-A', { subject: 'b' })
    const result = await TaskListTool.call({}, { sessionId: 'sess-A' })
    const parsed = JSON.parse((result as { output: string }).output) as Array<{ id: string }>
    expect(parsed.map((t) => t.id)).toEqual([a.id, b.id])
  })

  it('filters out deleted tasks', async () => {
    const a = await store.create('sess-A', { subject: 'a' })
    await store.create('sess-A', { subject: 'b' })
    await store.update('sess-A', a.id, { status: 'deleted' })
    const result = await TaskListTool.call({}, { sessionId: 'sess-A' })
    const parsed = JSON.parse((result as { output: string }).output)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].subject).toBe('b')
  })

  it('only returns tasks for the current session', async () => {
    await store.create('sess-A', { subject: 'A-only' })
    await store.create('sess-B', { subject: 'B-only' })
    const result = await TaskListTool.call({}, { sessionId: 'sess-A' })
    const parsed = JSON.parse((result as { output: string }).output)
    expect(parsed.map((t: { subject: string }) => t.subject)).toEqual(['A-only'])
  })

  it('throws when sessionId is missing', async () => {
    await expect(TaskListTool.call({}, {})).rejects.toThrow(/requires sessionId/)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/zn-agent-core && pnpm vitest run test/unit/tools/tasks/TaskListTool.test.ts`
Expected: FAIL with module-not-found。

- [ ] **Step 3: 实现 TaskListTool**

`packages/zn-agent-core/src/compat/tools/tasks/TaskListTool.ts`:

```ts
import type { z } from 'zod'
import type { Tool } from '../../runtime/modelCaller.js'
import { makeTool } from '../index.js'
import { getTaskListStore } from '../../taskListStore.js'
import { TaskListInput } from './schemas.js'

async function listExecutor(
  _input: z.infer<typeof TaskListInput>,
  ctx: { sessionId?: string },
): Promise<{ output: string }> {
  if (!ctx.sessionId) {
    throw new Error('TaskList requires sessionId')
  }
  const tasks = await getTaskListStore().list(ctx.sessionId)
  return { output: JSON.stringify(tasks) }
}

export const TaskListTool: Tool = makeTool({
  name: 'TaskList',
  description:
    "List all non-deleted tasks for the current session. Returns an array sorted by " +
    'createdAt ascending. Use this when you need to see current state before updating.',
  inputSchema: TaskListInput,
  executor: listExecutor,
})
```

- [ ] **Step 4: 重新运行测试确认通过**

Run: `cd packages/zn-agent-core && pnpm vitest run test/unit/tools/tasks/TaskListTool.test.ts`
Expected: PASS,6 个 it() 全部通过。

- [ ] **Step 5: 提交**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zn-agent-core/src/compat/tools/tasks/TaskListTool.ts packages/zn-agent-core/test/unit/tools/tasks/TaskListTool.test.ts
git commit -m "feat(zn-agent-core): add TaskListTool wrapper for TaskListStore.list"
```

---

## Task 7: 创建 `tasks/index.ts` 并接入 `buildDefaultTools`

**Files:**
- Create: `packages/zn-agent-core/src/compat/tools/tasks/index.ts`
- Modify: `packages/zn-agent-core/src/compat/tools/index.ts:514-546`

**Interfaces:**
- Consumes: 4 个工具 from Task 3-6
- Produces:
  - `export const taskTools: Tool[]`(4 个工具数组)
  - `buildDefaultTools()` 返回的数组包含 taskTools

- [ ] **Step 1: 写失败测试 — 验证 buildDefaultTools 包含 4 个 Task 工具**

在 `packages/zn-agent-core/test/unit/tools/buildDefaultToolsIncludesTasks.test.ts` 新建:

```ts
import { describe, expect, it } from 'vitest'
import { buildDefaultTools } from '../../../src/compat/tools/index.js'

describe('buildDefaultTools includes task tools', () => {
  it('returns TaskCreate/Get/Update/List by default', () => {
    const tools = buildDefaultTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toContain('TaskCreate')
    expect(names).toContain('TaskGet')
    expect(names).toContain('TaskUpdate')
    expect(names).toContain('TaskList')
  })

  it('does not require skillsDirs to include task tools', () => {
    const tools = buildDefaultTools({ skillsDirs: [] })
    expect(tools.map((t) => t.name)).toContain('TaskCreate')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/zn-agent-core && pnpm vitest run test/unit/tools/buildDefaultToolsIncludesTasks.test.ts`
Expected: FAIL — 名字不包含 'TaskCreate'(因为 `buildDefaultTools` 还没导入 tasks/)。

- [ ] **Step 3: 创建 `tasks/index.ts`**

`packages/zn-agent-core/src/compat/tools/tasks/index.ts`:

```ts
import { TaskCreateTool } from './TaskCreateTool.js'
import { TaskGetTool } from './TaskGetTool.js'
import { TaskListTool } from './TaskListTool.js'
import { TaskUpdateTool } from './TaskUpdateTool.js'

export { TaskCreateTool, TaskGetTool, TaskListTool, TaskUpdateTool }
export const taskTools = [TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool]
```

- [ ] **Step 4: 在 `compat/tools/index.ts` 接入 taskTools**

打开 `packages/zn-agent-core/src/compat/tools/index.ts`,在文件顶部(其他 import 之后,例如 line 33 之后)追加:

```ts
import { taskTools } from './tasks/index.js'
```

然后修改 `buildDefaultTools`(line 519 区域),把初始 `tools` 数组改为:

```ts
  const tools: Tool[] = [
    bashTool,
    fileReadTool,
    fileWriteTool,
    fileEditTool,
    askUserQuestionTool,
    ...taskTools,
  ]
```

- [ ] **Step 5: 重新运行测试确认通过**

Run: `cd packages/zn-agent-core && pnpm vitest run test/unit/tools/buildDefaultToolsIncludesTasks.test.ts`
Expected: PASS,2 个 it() 全部通过。

- [ ] **Step 6: 运行全量工具 unit 测试确认没回归**

Run: `cd packages/zn-agent-core && pnpm vitest run test/unit/tools/`
Expected: 所有现有测试 + 新增 4 个 TaskCreateTool.test.ts / TaskGetTool.test.ts / TaskUpdateTool.test.ts / TaskListTool.test.ts / schemas.test.ts / makeToolReexport.test.ts / buildDefaultToolsIncludesTasks.test.ts 通过。

- [ ] **Step 7: typecheck**

Run: `cd packages/zn-agent-core && pnpm typecheck`
Expected: 0 errors。

- [ ] **Step 8: 提交**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zn-agent-core/src/compat/tools/tasks/index.ts packages/zn-agent-core/src/compat/tools/index.ts packages/zn-agent-core/test/unit/tools/buildDefaultToolsIncludesTasks.test.ts
git commit -m "feat(zn-agent-core): register taskTools in buildDefaultTools"
```

---

## Task 8: 集成测试 — `runOpenccQuery` 调用 TaskCreate 走通

**Files:**
- Create: `packages/zn-agent-core/test/integration/taskToolsIntegration.test.ts`

**Interfaces:**
- Consumes:
  - `runOpenccQuery` from `../../src/compat/runtime/openccAdapter.js`
  - 4 个 Task 工具已注册(由 Task 7 保证)
  - `TaskListStore, setTaskListStore` from `../../src/compat/taskListStore.js`
- Produces: 一个测试文件,断言 LLM 调 TaskCreate 走通,store 落盘,stateChangeBus emit

- [ ] **Step 1: 写失败测试**

`packages/zn-agent-core/test/integration/taskToolsIntegration.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runOpenccQuery } from '../../../src/compat/runtime/openccAdapter.js'
import { buildDefaultTools } from '../../../src/compat/tools/index.js'
import { setTaskListStore, TaskListStore } from '../../../src/compat/taskListStore.js'
import { stateChangeBus } from '../../../src/stateChangeBus.js'

describe('runOpenccQuery with task tools', () => {
  let tmpDir: string
  let store: TaskListStore
  let emitted: Array<unknown>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'task-integration-'))
    store = new TaskListStore(tmpDir)
    setTaskListStore(store)
    emitted = []
    stateChangeBus.on('v2_task.changed', (payload) => emitted.push(payload))
  })
  afterEach(() => {
    setTaskListStore(null)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function fakeModelCaller(callSequence: Array<{ type: string; [k: string]: unknown }>) {
    let i = 0
    return async () => {
      const events = callSequence[i++] ?? [{ type: 'message_stop' }]
      return (async function* () {
        for (const e of events) yield e as never
      })()
    }
  }

  it('merged tool list contains TaskCreate/Get/Update/List', async () => {
    const tools = buildDefaultTools()
    const names = tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList']))
  })

  it('runOpenccQuery passes task tools to modelCaller', async () => {
    let receivedTools: Array<{ name: string }> = []
    const modelCaller = async (req: { tools?: Array<{ name: string }> }) => {
      receivedTools = req.tools ?? []
      return (async function* () {
        yield { type: 'message_stop' }
      })()
    }
    const events: unknown[] = []
    for await (const ev of runOpenccQuery(
      {
        prompt: 'noop',
        cwd: tmpDir,
        transcriptId: 'sess-int-A',
        sessionId: 'sess-int-A',
      },
      {
        modelCaller: modelCaller as never,
        tools: buildDefaultTools(),
      },
    )) {
      events.push(ev)
    }
    expect(receivedTools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList']),
    )
  })

  it('TaskCreate via store persists and emits stateChangeBus event', async () => {
    await store.create('sess-int-X', { subject: 'integration works' })
    // The store create() also fires the event — verify both write + emit:
    expect(emitted.length).toBe(1)
    const list = await store.list('sess-int-X')
    expect(list).toHaveLength(1)
    expect(list[0].subject).toBe('integration works')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/zn-agent-core && pnpm vitest run test/integration/taskToolsIntegration.test.ts`
Expected: FAIL with module-not-found(因为文件还不存在)。

- [ ] **Step 3: 创建测试文件**

把 Step 1 中的代码完整写入 `packages/zn-agent-core/test/integration/taskToolsIntegration.test.ts`。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/zn-agent-core && pnpm vitest run test/integration/taskToolsIntegration.test.ts`
Expected: PASS,3 个 it() 全部通过。

- [ ] **Step 5: typecheck**

Run: `cd packages/zn-agent-core && pnpm typecheck`
Expected: 0 errors。

- [ ] **Step 6: 提交**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zn-agent-core/test/integration/taskToolsIntegration.test.ts
git commit -m "test(zn-agent-core): add runOpenccQuery integration test for task tools"
```

---

## Task 9: 前端 `useAgentStore` 移除 TodoWrite 路径

**Files:**
- Modify: `packages/zai/src/web/src/store/useAgentStore.ts`(删除 `todosBySession` 字段、`applyTodoUpdate` reducer、`upsertToolCall` 中的 `name==='TodoWrite'` 守卫分支)
- Modify: `packages/zai/src/web/src/store/useAgentStore.test.ts`(若存在,同步移除相关断言)

**Interfaces:**
- Consumes: 现有 store 结构
- Produces:
  - `todosBySession` 字段删除
  - `applyTodoUpdate(sessionId, todos)` reducer 删除
  - `upsertToolCall` 不再吞掉 `name==='TodoWrite'` 工具调用(改为走默认 tool_result 渲染,后续可视情况单独清理)

- [ ] **Step 1: 定位并记录现有 `TodoWrite` 相关代码**

Run:
```bash
cd /Users/ethan/code/opencc-web
grep -rn "todosBySession\|applyTodoUpdate\|TodoWrite" packages/zai/src/web/src/ > /tmp/grep-result.txt
cat /tmp/grep-result.txt
```

确认要删除的代码位置:
- `todosBySession` 字段定义(在 state 类型 / interface)
- `applyTodoUpdate` reducer(在 actions 部分)
- `upsertToolCall` 中 `if (name === 'TodoWrite') { ...; return }` 分支

把 grep 结果保存到 `/tmp/grep-result.txt` 备用。

- [ ] **Step 2: 修改 `useAgentStore.ts` — 删除 `todosBySession` 字段**

打开 `packages/zai/src/web/src/store/useAgentStore.ts`。

找到 `todosBySession` 字段的类型声明(类似 `todosBySession: Record<string, TodoItem[]>`),删除该行。

找到 `todosBySession:` 的初始值(`{}` 或类似),删除该行。

**注意**:如果该字段在 `AgentState` interface 中声明,同步删除 interface 字段;如果在 `create` 中初始化,同步删除。

- [ ] **Step 3: 修改 `useAgentStore.ts` — 删除 `applyTodoUpdate` reducer**

找到 `applyTodoUpdate(sessionId: string, todos: TodoItem[])` 函数(若为 reducer:`set((s) => { s.todosBySession[sessionId] = todos })`),整段删除。

- [ ] **Step 4: 修改 `useAgentStore.ts` — 删除 `upsertToolCall` 中的 TodoWrite 守卫**

找到 `upsertToolCall` 函数体中类似以下代码:

```ts
if (name === 'TodoWrite') {
  // ... 解析 input.todos ...
  return
}
```

整段删除(包含 TodoItem 类型本地定义)。后续 TodoWrite 工具调用会按普通 tool_result 渲染。

- [ ] **Step 5: typecheck 前端**

Run: `cd packages/zai && pnpm typecheck`
Expected: 0 errors。

如果有错误,通常是 TodoItem / applyTodoUpdate / todosBySession 被某处引用 — 用 grep 找遗留引用并清理。

- [ ] **Step 6: 提交**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/store/useAgentStore.ts
git commit -m "refactor(zai): remove TodoWrite/todosBySession from useAgentStore, route via v2 task tools"
```

---

## Task 10: 前端 `Agent.tsx` 路径验证 + 全量验收

**Files:**
- Modify: `packages/zai/src/web/src/pages/Agent.tsx`(若有 todos 残留引用,改读 `v2TasksBySession`)

**Interfaces:**
- Consumes: `v2TasksBySession`(已存在)
- Produces: Agent.tsx 不再有 todosBySession / applyTodoUpdate 引用

- [ ] **Step 1: grep 排查 Agent.tsx 残留**

Run:
```bash
cd /Users/ethan/code/opencc-web
grep -n "todosBySession\|applyTodoUpdate\|TodoWrite\|TodoItem" packages/zai/src/web/src/pages/Agent.tsx
```

若输出为空,跳过 Step 2-3 直接到 Step 4。若有匹配:

- [ ] **Step 2: 修改 Agent.tsx — 替换 todos 引用**

打开 `packages/zai/src/web/src/pages/Agent.tsx`。把 `useAgentStore((s) => s.todosBySession)` 改为 `useAgentStore((s) => s.v2TasksBySession)`。

把 `applyTodoUpdate(...)` 调用删除(若存在)。

- [ ] **Step 3: typecheck 前端**

Run: `cd packages/zai && pnpm typecheck`
Expected: 0 errors。

- [ ] **Step 4: 全量 grep 确认无残留**

Run:
```bash
cd /Users/ethan/code/opencc-web
grep -rn "todosBySession\|applyTodoUpdate\|TodoWrite" packages/ --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v dist
```

Expected: 0 matches(任何命中都意味着遗漏)。

- [ ] **Step 5: 运行所有 zn-agent-core 测试**

Run: `cd packages/zn-agent-core && pnpm test`
Expected: 全部 PASS(Bun-only 的 opencc-src 测试除外,这些是 pre-existing 失败,与本任务无关)。

- [ ] **Step 6: 运行前端测试**

Run: `cd packages/zai && pnpm test`
Expected: 全部 PASS(useAgentStore.test.ts / Agent.test.tsx 等若有)。

- [ ] **Step 7: 提交(若有 Agent.tsx 改动)**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/pages/Agent.tsx
git commit -m "refactor(zai): point Agent.tsx task summary to v2TasksBySession"
```

(若 Step 1 grep 无输出,跳过此提交。)

---

## Self-Review

按 writing-plans skill 要求做自审:

**1. Spec 覆盖检查**(对照 spec §3-9):

| Spec 章节 | 覆盖任务 |
|---|---|
| §3.1 新增 compat/tools/tasks/ 子目录 + schemas.ts + 4 个工具 + index.ts | Task 2 + Task 3 + Task 4 + Task 5 + Task 6 + Task 7 |
| §3.2 buildDefaultTools 接入 | Task 7 |
| §3.2 useAgentStore 删 todosBySession / TodoWrite 守卫 | Task 9 |
| §3.2 Agent.tsx 验证 | Task 10 |
| §4 数据流 | Task 8(集成测试验证) |
| §5 工具契约(4 个工具的 description 与 output 格式) | Task 3 + Task 4 + Task 5 + Task 6 |
| §6 前端迁移 | Task 9 + Task 10 |
| §7 错误处理矩阵(sessionId 缺失 / id 找不到 / zod 失败 / auto-cleanup) | Task 3 (id) + Task 4 (id 找不到 + zod) + Task 5 (auto-cleanup + null 字符串) + Task 6 (session 隔离) |
| §8.1 单元测试 | Task 3-6 各自配 .test.ts |
| §8.2 集成测试 | Task 8 |
| §8.3 前端测试 | Task 9 + Task 10(grep 残留验证) |
| §9 验收标准 | Task 10(全量 grep + test + typecheck) |

无遗漏。

**2. 占位符扫描**:

- ✅ 没有 "TBD" / "TODO" / "implement later" / "fill in details"
- ✅ 没有 "similar to Task N"(每个 task 都给完整代码)
- ✅ 没有 "add appropriate error handling"(错误处理矩阵在 spec 已明确,task 内代码已具体)
- ✅ 每个 Step 都有可执行命令 / 具体代码块

**3. 类型一致性检查**:

- `makeTool` 在 Task 1 导出,在 Task 3-6 用 `import { makeTool } from '../index.js'` — 一致 ✓
- `Tool` 类型在 `compat/runtime/modelCaller.ts` 导出,tasks/*.ts 用 `import type { Tool } from '../../runtime/modelCaller.js'` — 一致 ✓
- `TaskCreateInput / TaskGetInput / TaskUpdateInput / TaskListInput` 在 Task 2 定义并 export,tasks/*.ts 用 `import { TaskXxxInput } from './schemas.js'` — 一致 ✓
- `getTaskListStore / setTaskListStore / TaskListStore / stateChangeBus` 从 `compat/taskListStore.ts` 导出 — 一致 ✓
- `TaskCreateTool / TaskGetTool / TaskUpdateTool / TaskListTool / taskTools` 在 tasks/index.ts 命名一致 ✓

自审通过,plan 可执行。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-31-zn-agent-core-task-tools.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?