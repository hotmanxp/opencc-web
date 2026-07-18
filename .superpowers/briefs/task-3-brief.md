# Task 3 Brief

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
