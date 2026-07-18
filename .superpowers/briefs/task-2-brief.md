# Task 2 Brief

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
