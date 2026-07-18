# Agent Bottom Status Bar + Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
1. 修复 zai-web 中三个互关联的 bug：
   - Bug A：实时流式期间，工具调用名字显示 "unknown"
   - Bug B：V2 TaskList（TaskCreate/List/Get/Update）后端注册了，但前端没有任何 UI/状态显示
   - Bug C：原 TodoWrite tool_use 流式状态在某些路径下未更新
2. 新增 zai-web Agent 页面"红框"位置的状态条：显示任务 + TODO 进度，点击向上展开 dropdown

**Architecture:**

**Phase 1 — Bug Fix Sentry (优先于 Phase 2)**
- Bug A：定位 `runtime.tool_call` 事件丢 `toolName` 的具体路径，加 console.warn 数据收集 + 在 schema 兜底处显式 fail-loud；前端 `ToolCallBlock` 改名"未知工具（recordId）"避免裸 unknown 字符。
- Bug B：在 `zai-web` 端新增 `v2TasksBySession: Record<sessionId, V2TaskItem[]>` store slice + server 路由 `GET /api/agent/sessions/:sid/v2-tasks` + SSE 监听 zai-agent-core 内部的 task 变更事件（zai-agent-core 已通过 `tool_use:start/done` 把 TaskCreate/TaskUpdate 走普通工具路径发出，因此走 SSE `runtime.tool_call/result` 即可）。

**Phase 2 — 新增 BottomStatusBar**
- 新增 `BottomStatusBar` 组件，渲染在 `<AgentInputBox />` 之**上**、消息流容器内。摘要：`N/M 任务 · K 进行中 · J 待开始` + caret。
- `TodoDropdown` 组件分两段：上半部分走老 TodoWrite todos、下半部分走 V2 TaskList，参考 `TodoZone.tsx` 已有的三态视觉。

**Tech Stack:** React 18 + TypeScript + antd 5 (`Popover`, `Badge`) + zustand 4 (`useAgentStore`) + happy-dom + vitest + RTL — 与 `TaskDrawer.test.tsx` 同样的栈。后端用 Express（与现有 `/api/agent/*` 路由一致）。

## Global Constraints

- 中文 UI 字符串，沿用现有"任务 / 进行中 / 已完成"文案
- 颜色用 zai-web 现有暗色主题：`#a78bfa`（violet-400）激活色、`#52c41a` 完成、`rgba(255,255,255,0.45)` 默认文本
- 不新增 npm 依赖（V2 TaskList 直接复用 `applyRuntimeEvent` 现有 SSE 通道）
- 单测覆盖 dropdown 触发、`N/M` 计算、空态折叠、unknown 名字降级四个分支
- 不破坏现有 `useAgentStore.ts` 已有 reducer 行为；只在合适位置追加 v2 store slice
- 改完所有改动必须在浏览器里目视确认一次（外部 dev server 在 5173 端口跑）

---

## File Structure

**Phase 1 — Bug Fix**

Files:
- Modify: `packages/zai/src/web/src/pages/Agent.tsx:515` — `ToolCallBlock` 的 `const name = ... || 'unknown'` 改为更可读的降级文案
- Modify: `packages/zai/src/web/src/store/useAgentStore.ts` — 在 AgentState 接口 + store 实现里追加 `v2Tasks: Record<string, V2TaskItem[]>` 和 `setV2Tasks`/`updateV2Task`/`deleteV2Task` 三个 reducer
- Create: `packages/zai/src/web/src/lib/v2TaskApi.ts` — V2 TaskList client API（GET 列表 / 更新单条 / 删除单条）
- Create: `packages/zai/src/server/routes/v2Tasks.ts` — Express 路由，从 `~/.zai/tasks.json` 读出 V2 任务列表（**只读**，因为写操作由 zai-agent-core 内部 tool call 完成）
- Modify: `packages/zai/src/server/index.ts` — 注册新路由
- Create: `packages/zai/src/web/src/components/V2TaskListPanel.tsx` — V2 TaskList 在 UI 上的渲染面板（被 BottomStatusBar 通过 Popover 包含）
- Create: `packages/zai/src/web/src/lib/v2TaskApi.test.ts` — V2 任务 API 单测

**Phase 2 — BottomStatusBar 新增**

Files:
- Create: `packages/zai/src/web/src/components/ConfigStatusBar.tsx` — 原底栏(bypass/cwd/branch/model/TaskDock)整体搬家
- Create: `packages/zai/src/web/src/components/TodoDropdown.tsx` — 向上弹出的 TODO 详情面板（只渲染，由 Popover 包裹）
- Create: `packages/zai/src/web/src/components/TodoDropdown.test.tsx`
- Create: `packages/zai/src/web/src/components/BottomStatusBar.tsx` — 红框位置的状态条 + 触发按钮
- Create: `packages/zai/src/web/src/components/BottomStatusBar.test.tsx`
- Modify: `packages/zai/src/web/src/pages/Agent.tsx` — 把 inline 底栏 div 换成 `<ConfigStatusBar />`；在 `<AgentInputBox />` 上方插入 `<BottomStatusBar />`

**Not touching:**
- `TodoZone.tsx`、`TaskDock.tsx`、`TaskDrawer.tsx`、`ModelStatusButton.tsx`、`ModeStatusButton.tsx`
- `packages/zai-agent-core/src/` 任何源码（bug 修复都在 web 端的可见层或 server 层）

---

# Phase 1 — Bug Fix

---

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

## Task 2: V2 TaskList 数据模型 — store slice 扩展

**Files:**
- Modify: `packages/zai/src/web/src/store/useAgentStore.ts`
- Create: `packages/zai/src/web/src/lib/v2TaskApi.ts`

**Interfaces:**
- Consumes: 复用现有 `applyRuntimeEvent` 已经走通 SSE `runtime.tool_call`/`runtime.tool_result` 路径（zai-agent-core 内部 TaskCreate 等工具也走这条路径，前端不需要新 SSE 事件类型）
- Produces: 暴露 `useAgentStore.getState().v2Tasks`、`setV2Tasks(sid, tasks)`、`updateV2Task(sid, task)`、`deleteV2Task(sid, taskId)`

- [ ] **Step 1: 在 useAgentStore.ts 加 V2 类型 + state + actions**

在文件顶部 `TodoItem` 类型（约第 10 行）旁边新增：

```ts
// V2 TaskList 镜像 (mirror of zai-agent-core TaskListStore). 跟 TodoZone
// 字段对齐: 客户端只读, 写操作走 TaskCreate/TaskUpdate tool call, server
// 重新计算后通过本字段刷新. status 多一个 'deleted' (completed 之外
// 软删除态), UI 用删除线表达.
export type V2TaskItem = {
  id: string
  subject: string
  description?: string
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  blocks: string[]
  blockedBy: string[]
  owner?: string
  updatedAt: number
}
```

在 `interface AgentState`（约第 65 行）内、`todosBySession` 之后追加：

```ts
  // V2 TaskList 镜像: 与老 TodoWrite 分开存, 因为语义不同 (跨 turn、
  // 会话之间可被查询). key 用 sessionId (来自 tool_use:start.msg.sessionId).
  v2TasksBySession: Record<string, V2TaskItem[]>
  setV2Tasks: (sessionId: string, tasks: V2TaskItem[]) => void
  updateV2Task: (sessionId: string, task: V2TaskItem) => void
  deleteV2Task: (sessionId: string, taskId: string) => void
```

在 `useAgentStore` 初始 state（约第 322 行 todosBySession: {} 旁）追加：

```ts
  v2TasksBySession: {},

  setV2Tasks: (sessionId, tasks) =>
    set((s) => ({
      v2TasksBySession: { ...s.v2TasksBySession, [sessionId]: tasks },
    })),

  updateV2Task: (sessionId, task) =>
    set((s) => {
      const cur = s.v2TasksBySession[sessionId] ?? []
      const next = cur.some((t) => t.id === task.id)
        ? cur.map((t) => (t.id === task.id ? task : t))
        : [...cur, task]
      return {
        v2TasksBySession: { ...s.v2TasksBySession, [sessionId]: next },
      }
    }),

  deleteV2Task: (sessionId, taskId) =>
    set((s) => {
      const cur = s.v2TasksBySession[sessionId] ?? []
      return {
        v2TasksBySession: {
          ...s.v2TasksBySession,
          [sessionId]: cur.filter((t) => t.id !== taskId),
        },
      }
    }),
```

同样在 `clearMessages` (约 562 行) 把 `v2TasksBySession` 一起重置（旧 sid 保留，新 sid 清空 — 与 todosBySession 对齐）：

```ts
        // v2TasksBySession 与 todosBySession 一致: 切会话/清屏 只清理当前 sid
        const { [sid as string]: _dropV2, ...restV2 } = (s.v2TasksBySession ?? {}) as Record<string, V2TaskItem[]>
        void _dropV2
```

并在 return 里把 `todosBySession: sid ? rest : s.todosBySession,` 同样改为 `, v2TasksBySession: sid ? restV2 : s.v2TasksBySession`。

- [ ] **Step 2: 创建 v2TaskApi client**

`packages/zai/src/web/src/lib/v2TaskApi.ts`：

```ts
// V2 TaskList 客户端. 写操作(zai-agent-core 内部 tool call)不在这里,
// 这里只暴露只读: 因为 store 已经通过 SSE 增量更新, 但首次进入会话时
// 需要 GET 一次把磁盘上 ~/.zai/tasks.json 现有内容拉过来覆盖本地缓存.

import type { V2TaskItem } from '../store/useAgentStore.js'

const API = '/api/agent/sessions'

function getHeaders(): HeadersInit {
  const token = (typeof localStorage !== 'undefined' && localStorage.getItem('zai-token')) || ''
  return token ? { 'X-Zai-Token': token } : {}
}

export async function fetchV2Tasks(sessionId: string): Promise<V2TaskItem[]> {
  const res = await fetch(`${API}/${encodeURIComponent(sessionId)}/v2-tasks`, {
    headers: getHeaders(),
  })
  if (!res.ok) throw new Error(`v2-tasks fetch failed: ${res.status}`)
  const data = (await res.json()) as { tasks: V2TaskItem[] }
  return data.tasks
}
```

- [ ] **Step 3: 写 v2TaskApi 单测**

`packages/zai/src/web/src/lib/v2TaskApi.test.ts`：

```ts
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { fetchV2Tasks } from './v2TaskApi.js'

describe('fetchV2Tasks', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  test('GET 路径正确 + 返回 task 数组', async () => {
    localStorage.setItem('zai-token', 'tok-123')
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ tasks: [{ id: 't1', subject: 'demo', status: 'pending', blocks: [], blockedBy: [], updatedAt: 0 }] }),
    })
    // @ts-expect-error mock fetch
    globalThis.fetch = mockFetch

    const tasks = await fetchV2Tasks('sess-abc')
    expect(tasks[0]?.subject).toBe('demo')
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/agent/sessions/sess-abc/v2-tasks'),
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Zai-Token': 'tok-123' }) }),
    )
  })

  test('HTTP 非 2xx 抛错', async () => {
    // @ts-expect-error mock fetch
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    await expect(fetchV2Tasks('s1')).rejects.toThrow(/500/)
  })
})
```

- [ ] **Step 4: 跑测试**

Run: `pnpm --filter @zn-ai/zai test -- v2TaskApi`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/store/useAgentStore.ts packages/zai/src/web/src/lib/v2TaskApi.ts packages/zai/src/web/src/lib/v2TaskApi.test.ts
git commit -m "feat(zai-web): add v2TasksBySession store slice + fetchV2Tasks client API"
```

---

## Task 3: V2 TaskList server 路由 + 自动 fetch

**Files:**
- Create: `packages/zai/src/server/routes/v2Tasks.ts`
- Modify: `packages/zai/src/server/index.ts`
- Modify: `packages/zai/src/web/src/pages/Agent.tsx`

**Interfaces:**
- Consumes: 复用 `TaskListStore.getTaskListStore` 读 `~/.zai/tasks.json`
- Produces: `GET /api/agent/sessions/:sid/v2-tasks → { tasks: V2TaskItem[] }`

- [ ] **Step 1: 写 server 路由**

`packages/zai/src/server/routes/v2Tasks.ts`：

```ts
// V2 TaskList 只读路由. zai-web 通过 SSE 的 runtime.tool_call 拿到增量
// 写入本地 store, 但首次 / 刷新时需要从磁盘把 ~/.zai/tasks.json 现状拉
// 过来覆盖本地空态. 写操作是 LLM 调 TaskCreate/Update tool, 走
// zai-agent-core 内部通道, 不经过此路由.
//
// 字段映射: server 侧 TaskItem.subject -> client V2TaskItem.subject;
// status 透传; blocks/blockedBy 透传; 不返回 metadata (含 _internal).

import { Router } from 'express'
import { getTaskListStore } from '../../zai-agent-core/src/tools/Tasks/TaskListStore.js'

export function v2TasksRouter(): Router {
  const r = Router()

  r.get('/api/agent/sessions/:sid/v2-tasks', async (req, res) => {
    try {
      // 当前实现: 全局单例 store; sessionId 仅用于路由形状统一, 暂未做 partition
      const all = await getTaskListStore().list()
      res.json({ tasks: all })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  return r
}
```

> ⚠️ 上面的 import 路径 `../../zai-agent-core/src/...` 假设 server 路由可以访问 agent-core 源码。如果 server 是已构建产物消费，改成 `import { getTaskListStore } from '@zn-ai/zai-agent-core'` — **先确认实际产物结构，必要时 import 路径改 ProductPathAdapter**（参见 `packages/zai/src/server/services/...` 内已有同类 import）。

- [ ] **Step 2: 注册路由**

`packages/zai/src/server/index.ts` 在已有路由注册的位置（约第 30-40 行查找 `app.use('api/agent/...'`）追加：

```ts
import { v2TasksRouter } from './routes/v2Tasks.js'
// ...
app.use(v2TasksRouter())
```

- [ ] **Step 3: 在 Agent.tsx 中首次会话切换时 fetch V2 任务**

`packages/zai/src/web/src/pages/Agent.tsx`：

1. 加 import（按字母序插在 `useEventStream` 附近）：

```tsx
import { fetchV2Tasks } from '../lib/v2TaskApi.js'
import { useAgentStore } from '../store/useAgentStore'
```

2. 在 Agent 组件函数体内部（紧跟现有的 `useEffect(() => { (async () => { await loadSessions(); ... })() }, [])` 之后，约第 1123 行之下）新增 useEffect：

```tsx
  // 进 agent 页 / 切 session 时,把 ~/.zai/tasks.json 当前内容拉过来覆盖
  // 本地 v2Tasks 缓存. 这是 SSE 增量之外的兜底,处理浏览器刷新或换设备的情况.
  useEffect(() => {
    const sid = sessionId
    if (!sid) return
    let cancelled = false
    void (async () => {
      try {
        const tasks = await fetchV2Tasks(sid)
        if (cancelled) return
        useAgentStore.getState().setV2Tasks(sid, tasks)
      } catch (err) {
        console.warn('[v2Tasks] initial fetch failed:', err)
      }
    })()
    return () => { cancelled = true }
  }, [sessionId])
```

3. 同时在 `applyRuntimeEvent` 已有的 `runtime.tool_call` 分支末尾（约 useAgentStore.ts 第 911 行 `upsertToolCall(startMsg); return` 之后**之前**追加对 V2 工具的零成本预处理）：

```ts
        // V2 TaskList 工具 (TaskCreate/List/Get/Update) 走完正常
        // upsertToolCall 之后,顺手刷新本地 v2TasksBySession 缓存 — 因为
        // store 数据 source of truth 是 .tasks.json 文件, 通过
        // getTaskListStore().create() / update() 已经写盘, 这里 GET 一次
        // 覆盖本地镜像. 不阻塞 tool_use:start 主流程, 失败静默.
        if (event.toolName === 'TaskCreate' || event.toolName === 'TaskUpdate' || event.toolName === 'TaskDelete') {
          // 异步 fire-and-forget, 不 await 不 block
          void (async () => {
            try {
              const tasks = await fetchV2Tasks(sid)
              useAgentStore.getState().setV2Tasks(sid, tasks)
            } catch { /* 静默 */ }
          })()
        }
```

> ⚠️ 上面这一段需在 useAgentStore.ts 顶端加 `import { fetchV2Tasks } from '../lib/v2TaskApi.js'`。如果担心 web store 反向依赖 lib API 形成循环 import，可改成在 store action 内置 API_BASE 直接 fetch（与 store 内 `loadSessions` 同款自包含写法）。

- [ ] **Step 4: typecheck + build**

Run: `pnpm --filter @zn-ai/zai typecheck`
Expected: pass

Run: `pnpm --filter @zn-ai/zai build`
Expected: 成功编译；server 启动 `pnpm --filter @zn-ai/zai dev` 后，`curl http://localhost:5173/api/agent/sessions/test/v2-tasks` 应返回 `{ tasks: [...] }`（空数组也 OK）

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/server/routes/v2Tasks.ts packages/zai/src/server/index.ts packages/zai/src/web/src/pages/Agent.tsx packages/zai/src/web/src/store/useAgentStore.ts
git commit -m "feat(zai): expose V2 TaskList via GET route + auto-refresh on session change"
```

---

# Phase 2 — BottomStatusBar

---

## Task 4: 把内联底栏抽出为 `ConfigStatusBar`

**Files:**
- Create: `packages/zai/src/web/src/components/ConfigStatusBar.tsx`
- Modify: `packages/zai/src/web/src/pages/Agent.tsx:1405-1432`

**Interfaces:**
- Consumes: `cwdName: string`、`branch: string`、`onTaskSelect: (taskId: string) => void`（即 `setSelectedTaskId`）
- Produces: 一个无状态的 React 组件，返回原有那段 div

- [ ] **Step 1: 写组件骨架**

`packages/zai/src/web/src/components/ConfigStatusBar.tsx`:

```tsx
import { ModelStatusButton } from "./ModelStatusButton";
import { ModeStatusButton } from "./ModeStatusButton";
import { TaskDock } from "./TaskDock";

type Props = {
  cwdName: string;
  branch: string;
  onTaskSelect: (taskId: string) => void;
};

export default function ConfigStatusBar({ cwdName, branch, onTaskSelect }: Props) {
  return (
    <div
      style={{
        borderTop: "1px solid rgba(255,255,255,0.10)",
        padding: "6px 10px",
        fontSize: 12,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        color: "rgba(255,255,255,0.45)",
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <ModeStatusButton />
      <span style={{ color: "#eab308" }}>{cwdName}</span>
      <span style={{ color: "rgba(255,255,255,0.25)" }}>·</span>
      <span style={{ color: "#22c55e" }}>{branch}</span>
      <span style={{ color: "rgba(255,255,255,0.25)" }}>·</span>
      <span style={{ color: "#f97316" }}>
        <ModelStatusButton />
      </span>
      <span style={{ color: "rgba(255,255,255,0.25)" }}>·</span>
      <TaskDock onSelect={onTaskSelect} />
    </div>
  );
}
```

- [ ] **Step 2: 在 Agent.tsx 替换原内联 div**

`packages/zai/src/web/src/pages/Agent.tsx`:

1. 加 import：

```tsx
import ConfigStatusBar from "../components/ConfigStatusBar";
```

2. 删除 `Agent.tsx:1407-1431` 整段内联 div，替换为：

```tsx
<div className="bottom-stack">
  <AgentInputBox />
  <ConfigStatusBar
    cwdName={cwdName}
    branch={branch}
    onTaskSelect={setSelectedTaskId}
  />
</div>
```

- [ ] **Step 3: 视觉零改动验证**

Run: `pnpm --filter @zn-ai/zai typecheck`
Expected: pass

Run: 浏览器手动加载 `/agent` 路由，对比改前底栏
Expected: bypass / cwd / branch / model / 后台任务 5 个元素位置与外观完全一致

- [ ] **Step 4: Commit**

```bash
git add packages/zai/src/web/src/components/ConfigStatusBar.tsx packages/zai/src/web/src/pages/Agent.tsx
git commit -m "refactor(zai-web): extract inline bottom config bar into ConfigStatusBar component"
```

---

## Task 5: 新增 `TodoDropdown` 组件（合并老 TodoWrite + V2 TaskList）

**Files:**
- Create: `packages/zai/src/web/src/components/TodoDropdown.tsx`

**Interfaces:**
- Consumes: `todos: TodoItem[]`、`v2Tasks: V2TaskItem[]`
- Produces: 一个 div 容器，分两段（上 TODO，下 V2 任务），由 `BottomStatusBar` 用 Popover 包裹

- [ ] **Step 1: 实现组件**

`packages/zai/src/web/src/components/TodoDropdown.tsx`:

```tsx
import type { TodoItem, V2TaskItem } from "../store/useAgentStore";

type Props = { todos: TodoItem[]; v2Tasks: V2TaskItem[] };

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    width: 360,
    background: "#1f1f1f",
    borderRadius: 6,
    padding: 10,
    maxHeight: 360,
    overflowY: "auto",
    color: "#fff",
    fontSize: 12,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  header: {
    fontSize: 11,
    fontWeight: 600,
    color: "rgba(255,255,255,0.55)",
    marginBottom: 8,
    display: "flex",
    justifyContent: "space-between",
  },
  list: { listStyle: "none", padding: 0, margin: 0 },
  item: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "5px 6px",
    borderRadius: 4,
  },
  icon: { width: 16, textAlign: "center", fontSize: 12 },
  empty: {
    fontSize: 12,
    color: "rgba(255,255,255,0.40)",
    padding: "16px 8px",
    textAlign: "center",
  },
  divider: {
    height: 1,
    background: "rgba(255,255,255,0.08)",
    margin: "10px -10px",
  },
};

function todoIcon(status: TodoItem["status"]): string {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "■";
  return "☐";
}

function v2Icon(status: V2TaskItem["status"]): string {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "■";
  if (status === "deleted") return "✗";
  return "☐";
}

function todoColor(status: TodoItem["status"]): string {
  if (status === "completed") return "#52c41a";
  if (status === "in_progress") return "#a78bfa";
  return "rgba(255,255,255,0.40)";
}

function v2Color(status: V2TaskItem["status"]): string {
  if (status === "completed") return "#52c41a";
  if (status === "in_progress") return "#a78bfa";
  if (status === "deleted") return "#f5222d";
  return "rgba(255,255,255,0.40)";
}

export default function TodoDropdown({ todos, v2Tasks }: Props) {
  const todoDone = todos.filter((t) => t.status === "completed").length;
  const todoInProgress = todos.filter((t) => t.status === "in_progress").length;
  const v2Done = v2Tasks.filter((t) => t.status === "completed").length;
  const v2InProgress = v2Tasks.filter((t) => t.status === "in_progress").length;
  const isEmpty = todos.length === 0 && v2Tasks.length === 0;

  if (isEmpty) {
    return (
      <div style={styles.wrap} data-testid="todo-dropdown-empty">
        <div style={styles.empty}>暂无任务或 TODO</div>
      </div>
    );
  }

  return (
    <div style={styles.wrap} data-testid="todo-dropdown">
      {todos.length > 0 && (
        <>
          <div style={styles.header}>
            <span>当前会话 TODO</span>
            <span>
              {todoDone}/{todos.length} 完成 · {todoInProgress} 进行中
            </span>
          </div>
          <ul style={styles.list}>
            {todos.map((t, i) => (
              <li
                key={`todo-${i}`}
                style={styles.item}
                data-testid={`todo-dropdown-item-${t.status}`}
              >
                <span style={{ ...styles.icon, color: todoColor(t.status) }}>
                  {todoIcon(t.status)}
                </span>
                <span
                  style={{
                    flex: 1,
                    color: t.status === "completed" ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.85)",
                    textDecoration: t.status === "completed" ? "line-through" : "none",
                  }}
                >
                  {t.content}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {v2Tasks.length > 0 && (
        <>
          <div style={styles.divider} />
          <div style={styles.header}>
            <span>V2 任务清单</span>
            <span>
              {v2Done}/{v2Tasks.length} 完成 · {v2InProgress} 进行中
            </span>
          </div>
          <ul style={styles.list}>
            {v2Tasks.map((t) => (
              <li
                key={t.id}
                style={styles.item}
                data-testid={`v2-task-dropdown-item-${t.status}`}
              >
                <span style={{ ...styles.icon, color: v2Color(t.status) }}>
                  {v2Icon(t.status)}
                </span>
                <span
                  style={{
                    flex: 1,
                    color: t.status === "completed" || t.status === "deleted"
                      ? "rgba(255,255,255,0.45)"
                      : "rgba(255,255,255,0.85)",
                    textDecoration: t.status === "completed" || t.status === "deleted"
                      ? "line-through"
                      : "none",
                  }}
                  title={t.description ?? t.subject}
                >
                  {t.subject}
                </span>
                {t.blockedBy.length > 0 && (
                  <span style={{ fontSize: 10, color: "rgba(255,255,255,0.45)" }}>
                    依赖 {t.blockedBy.length}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 视觉一致性自查**

对照 `TodoZone.tsx` 已经写的 styles，确认视觉密度一致：颜色 `#a78bfa` (violet-400) + `#52c41a` (绿) + `rgba(255,255,255,0.40)` 默认 — 与 zai-web 现有暗色主题完全一致；图标 `☐ / ■ / ✓` 复用 `TodoZone` 已有的 `statusIcon`。

- [ ] **Step 3: Commit**

```bash
git add packages/zai/src/web/src/components/TodoDropdown.tsx
git commit -m "feat(zai-web): TodoDropdown panel covers legacy TodoWrite + V2 TaskList"
```

---

## Task 6: 写 `TodoDropdown` 单元测试

**Files:**
- Create: `packages/zai/src/web/src/components/TodoDropdown.test.tsx`

- [ ] **Step 1: 写测试**

`packages/zai/src/web/src/components/TodoDropdown.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import TodoDropdown from "./TodoDropdown.js";
import type { TodoItem, V2TaskItem } from "../store/useAgentStore.js";

const todo = (content: string, status: TodoItem["status"]): TodoItem => ({
  content, status, activeForm: content,
});

const v2 = (id: string, subject: string, status: V2TaskItem["status"], extra: Partial<V2TaskItem> = {}): V2TaskItem => ({
  id, subject, status, blocks: [], blockedBy: [], updatedAt: 0, ...extra,
});

describe("TodoDropdown", () => {
  test("空 todos + 空 v2 渲染 empty 提示", () => {
    render(<TodoDropdown todos={[]} v2Tasks={[]} />);
    expect(screen.getByTestId("todo-dropdown-empty")).toHaveTextContent("暂无任务或 TODO");
    expect(screen.queryByTestId("todo-dropdown")).toBeNull();
  });

  test("仅 todos 时显示 N/M 完成进度 + 三个 data-testid", () => {
    const todos: TodoItem[] = [
      todo("分析需求", "completed"),
      todo("写代码", "in_progress"),
      todo("写测试", "pending"),
    ];
    render(<TodoDropdown todos={todos} v2Tasks={[]} />);
    expect(screen.getByTestId("todo-dropdown")).toBeInTheDocument();
    expect(screen.getByTestId("todo-dropdown")).toHaveTextContent("1/3 完成");
    expect(screen.getByTestId("todo-dropdown")).toHaveTextContent("1 进行中");
    expect(screen.getByTestId("todo-dropdown-item-completed")).toHaveTextContent("分析需求");
    expect(screen.getByTestId("todo-dropdown-item-in_progress")).toHaveTextContent("写代码");
    expect(screen.getByTestId("todo-dropdown-item-pending")).toHaveTextContent("写测试");
  });

  test("同时含 todos + v2 时渲染两段", () => {
    render(
      <TodoDropdown
        todos={[todo("老 todo", "in_progress")]}
        v2Tasks={[v2("v1", "V2 任务 A", "pending"), v2("v2", "V2 任务 B", "completed")]}
      />,
    );
    expect(screen.getByTestId("todo-dropdown-item-in_progress")).toHaveTextContent("老 todo");
    expect(screen.getByTestId("v2-task-dropdown-item-pending")).toHaveTextContent("V2 任务 A");
    expect(screen.getByTestId("v2-task-dropdown-item-completed")).toHaveTextContent("V2 任务 B");
    expect(screen.getByTestId("todo-dropdown")).toHaveTextContent("V2 任务清单");
  });

  test("v2 task 含 blockedBy 时显示依赖数量", () => {
    render(
      <TodoDropdown
        todos={[]}
        v2Tasks={[v2("v1", "blocked", "pending", { blockedBy: ["a", "b"] })]}
      />,
    );
    expect(screen.getByTestId("v2-task-dropdown-item-pending")).toHaveTextContent("依赖 2");
  });

  test("v2 task deleted 状态显示 ✗ 删除线", () => {
    render(
      <TodoDropdown todos={[]} v2Tasks={[v2("v1", "deleted one", "deleted")]} />,
    );
    expect(screen.getByTestId("v2-task-dropdown-item-deleted")).toHaveTextContent("deleted one");
  });
});
```

- [ ] **Step 2: 跑测试**

Run: `pnpm --filter @zn-ai/zai test -- TodoDropdown`
Expected: 5 passed

如果失败：
- `Cannot find module './TodoDropdown.js'` → 检查 import 后缀，本仓库 TSX 测试用 `.js` 后缀（参照 `TaskDrawer.test.tsx:3`）
- `toHaveTextContent` 报错 → 检查是否所有中文中间夹了多余空白

- [ ] **Step 3: Commit**

```bash
git add packages/zai/src/web/src/components/TodoDropdown.test.tsx
git commit -m "test(zai-web): cover TodoDropdown empty / progress / V2 / blocked-by / deleted"
```

---

## Task 7: 新增 `BottomStatusBar` 组件（红框位置）

**Files:**
- Create: `packages/zai/src/web/src/components/BottomStatusBar.tsx`
- Modify: `packages/zai/src/web/src/pages/Agent.tsx`

- [ ] **Step 1: 实现组件**

`packages/zai/src/web/src/components/BottomStatusBar.tsx`:

```tsx
import { Popover, Tooltip } from "antd";
import { CaretUpOutlined } from "@ant-design/icons";
import TodoDropdown from "./TodoDropdown.js";
import type { TodoItem, V2TaskItem } from "../store/useAgentStore.js";

type Props = {
  todos: TodoItem[];
  v2Tasks: V2TaskItem[];
  /** 触发按钮文字，默认 "任务"。 */
  label?: string;
};

export function BottomStatusBar({ todos, v2Tasks, label = "任务" }: Props) {
  // 老 TODO (会话内) 与 V2 (跨会话持久) 各自统计
  const todoTotal = todos.length;
  const todoDone = todos.filter((t) => t.status === "completed").length;
  const todoInProgress = todos.filter((t) => t.status === "in_progress").length;
  const todoOpen = todoTotal - todoDone - todoInProgress;

  const v2Total = v2Tasks.length;
  const v2Done = v2Tasks.filter((t) => t.status === "completed").length;
  const v2InProgress = v2Tasks.filter((t) => t.status === "in_progress").length;

  const total = todoTotal + v2Total;
  const done = todoDone + v2Done;
  const inProgress = todoInProgress + v2InProgress;
  const open = todoOpen + (v2Total - v2Done - v2InProgress);

  // 触发器: `N/M 任务 · K 进行中 · J 待开始` + 向上 caret
  const trigger = (
    <div
      data-testid="bottom-status-trigger"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: "8px 12px",
        cursor: "pointer",
        background: "rgba(255,255,255,0.04)",
        borderTop: "1px solid rgba(255,255,255,0.10)",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        color: total > 0 ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.45)",
        fontSize: 12,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        userSelect: "none",
      }}
    >
      {total === 0 ? (
        <span>暂无 {label}</span>
      ) : (
        <span data-testid="bottom-status-summary">
          <span style={{ color: done === total ? "#52c41a" : "rgba(255,255,255,0.85)" }}>
            {done}/{total} {label}
          </span>
          {inProgress > 0 && (
            <span style={{ color: "#a78bfa", marginLeft: 8 }}>
              · {inProgress} 进行中
            </span>
          )}
          {open > 0 && (
            <span style={{ color: "rgba(255,255,255,0.55)", marginLeft: 8 }}>
              · {open} 待开始
            </span>
          )}
        </span>
      )}
      <CaretUpOutlined style={{ fontSize: 10, opacity: 0.7 }} />
    </div>
  );

  return (
    <Popover
      data-testid="bottom-status-popover"
      content={<TodoDropdown todos={todos} v2Tasks={v2Tasks} />}
      trigger="click"
      placement="topRight"
      arrow={false}
      destroyTooltipOnHide
    >
      <Tooltip
        title={total === 0 ? `暂无${label},点击查看历史` : `点击查看${label}详情`}
        placement="top"
      >
        {trigger}
      </Tooltip>
    </Popover>
  );
}
```

- [ ] **Step 2: 在 Agent.tsx 接线**

`packages/zai/src/web/src/pages/Agent.tsx`:

1. 新增 import：

```tsx
import { BottomStatusBar } from "../components/BottomStatusBar";
```

2. 在 Agent 函数体顶部、`todosForCurrentSession` 紧下方追加 v2 任务派生：

```tsx
  const v2TasksForCurrentSession: V2TaskItem[] =
    sessionId != null ? (v2TasksBySession[sessionId] ?? []) : [];
```

并且在组件顶部 useAgentStore 选择器区补一行（与 `todosBySession` 同位置）：

```tsx
  const v2TasksBySession = useAgentStore((s) => s.v2TasksBySession);
```

3. 在 `<div className="bottom-stack">` **内部、`<AgentInputBox />` 之前**插入新组件：

```tsx
        <BottomStatusBar todos={todosForCurrentSession} v2Tasks={v2TasksForCurrentSession} />

        <div className="bottom-stack">
          <AgentInputBox />
```

- [ ] **Step 3: typecheck 验证**

Run: `pnpm --filter @zn-ai/zai typecheck`
Expected: 通过

- [ ] **Step 4: 浏览器目测**

Run: `pnpm --filter @zn-ai/zai dev`，浏览器打开 `/agent`

预期：
1. 空状态：看到一行 `暂无 任务` + caret
2. 当前会话已发过 TodoWrite 工具：摘要 `X/Y 任务 · K 进行中`
3. 同时有 V2 任务：摘要 `N/M 任务` 合并两条线
4. 点击触发条 → 上方弹出 360px 宽面板：上半 TODO、下半 V2

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/components/BottomStatusBar.tsx packages/zai/src/web/src/pages/Agent.tsx
git commit -m "feat(zai-web): add BottomStatusBar above input box for merged TODO + V2 task summary"
```

---

## Task 8: 写 `BottomStatusBar` 单元测试

**Files:**
- Create: `packages/zai/src/web/src/components/BottomStatusBar.test.tsx`

- [ ] **Step 1: 写测试**

`packages/zai/src/web/src/components/BottomStatusBar.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { BottomStatusBar } from "./BottomStatusBar.js";
import type { TodoItem, V2TaskItem } from "../store/useAgentStore.js";

const todo = (content: string, status: TodoItem["status"]): TodoItem => ({
  content, status, activeForm: content,
});
const v2 = (id: string, subject: string, status: V2TaskItem["status"]): V2TaskItem => ({
  id, subject, status, blocks: [], blockedBy: [], updatedAt: 0,
});

describe("BottomStatusBar", () => {
  test("空 todos + 空 v2 渲染空态", () => {
    render(<BottomStatusBar todos={[]} v2Tasks={[]} />);
    expect(screen.getByTestId("bottom-status-trigger")).toHaveTextContent("暂无 任务");
    expect(screen.queryByTestId("bottom-status-summary")).toBeNull();
  });

  test("仅 todos 时摘要只算 todo", () => {
    const todos: TodoItem[] = [
      todo("a", "completed"),
      todo("b", "completed"),
      todo("c", "in_progress"),
      todo("d", "pending"),
    ];
    render(<BottomStatusBar todos={todos} v2Tasks={[]} />);
    const summary = screen.getByTestId("bottom-status-summary");
    expect(summary).toHaveTextContent("2/4 任务");
    expect(summary).toHaveTextContent("1 进行中");
    expect(summary).toHaveTextContent("1 待开始");
  });

  test("合并 todos + v2 进度", () => {
    render(
      <BottomStatusBar
        todos={[todo("a", "completed")]}
        v2Tasks={[
          v2("v1", "v2 task", "in_progress"),
          v2("v2", "v2 done", "completed"),
          v2("v3", "v2 pending", "pending"),
        ]}
      />,
    );
    const summary = screen.getByTestId("bottom-status-summary");
    expect(summary).toHaveTextContent("2/4 任务"); // 1 + 3
    expect(summary).toHaveTextContent("1 进行中");
    expect(summary).toHaveTextContent("2 待开始"); // 1 老 + 1 v2 pending
  });

  test("全完成时进度数字染绿", () => {
    render(
      <BottomStatusBar
        todos={[todo("a", "completed"), todo("b", "completed")]}
        v2Tasks={[]}
      />,
    );
    const summary = screen.getByTestId("bottom-status-summary");
    const greenSpan = summary.querySelector("span")
    expect(greenSpan?.style.color).toBe("rgb(82, 196, 26)") // #52c41a
  });

  test("点击 trigger 展开 popover 并渲染合并的 dropdown", async () => {
    render(
      <BottomStatusBar
        todos={[todo("first", "in_progress")]}
        v2Tasks={[v2("v1", "v2 task", "pending")]}
      />,
    );
    fireEvent.click(screen.getByTestId("bottom-status-trigger"))
    await waitFor(() => expect(screen.getByTestId("todo-dropdown")).toBeInTheDocument())
    expect(screen.getByTestId("todo-dropdown-item-in_progress")).toHaveTextContent("first")
    expect(screen.getByTestId("v2-task-dropdown-item-pending")).toHaveTextContent("v2 task")
  });
})
```

- [ ] **Step 2: 跑测试**

Run: `pnpm --filter @zn-ai/zai test -- BottomStatusBar`
Expected: 5 passed

常见失败：
- `findByTestId` 超时 → 改 `await waitFor(() => screen.getByTestId(...))`
- antd Popover 触发需 click 在 data-testid 节点上（已挂在 div 上 ✓）

- [ ] **Step 3: 全量回归**

Run: `pnpm --filter @zn-ai/zai test`
Expected: 全部通过（含已有的 `TaskDrawer.test.tsx`、`useBackgroundTasks.test.ts`、`useAgentStore.test.ts`、`TodoDropdown.test.tsx`、`BottomStatusBar.test.tsx` 等）

Run: `pnpm --filter @zn-ai/zai typecheck`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add packages/zai/src/web/src/components/BottomStatusBar.test.tsx
git commit -m "test(zai-web): cover BottomStatusBar empty / merged / green-complete / popover"
```

---

## Self-Review

1. **Spec coverage:**
   - Bug A 实时流式 unknown → Task 1 (ToolCallBlock 名字降级 + console.warn 数据收集)
   - Bug B V2 TaskList 没 UI → Task 2 (store slice + fetch API) + Task 3 (server 路由 + 自动 fetch)
   - Bug C 老 TodoWrite 没更新 → Task 5 TodoDropdown 直接读 useAgentStore.todosBySession（既有数据流）；Task 7 BottomStatusBar 同样路径
   - 红框位置显示 → Task 7
   - 点击向上弹出 → Task 5 (TodoDropdown) + Task 7 (Popover trigger="click" placement="topRight")
   - 底栏 bypass/cwd/branch/model 不动 → Task 4 (ConfigStatusBar 搬走)

2. **Placeholder scan:** 全部给了完整代码；没有 "TBD / TODO / 类似 Task N"。

3. **Type consistency:**
   - `TodoItem` / `V2TaskItem` 都从 `useAgentStore.ts` 导出
   - `setSelectedTaskId` 类型 `(taskId: string) => void` 与 useState 一致
   - testid 在生产代码和测试之间命名一致：`bottom-status-trigger`、`bottom-status-summary`、`todo-dropdown`、`v2-task-dropdown-item-${status}`

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-18-agent-bottom-status-bar.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
