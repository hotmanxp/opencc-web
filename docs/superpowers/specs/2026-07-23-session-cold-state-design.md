# Session Cold-State Hydration 设计规格

> 给"打开/切换 session 时"补一个聚合 REST 端点,作为 SSE cold-start 窗口里的快照补全。SSE 仍是 source of truth,REST 只补"还没收到的第一条"。

---

## 1. 背景与目标

### 1.1 当前 SSE-only 设计下的 cold-start 缺口

zai 主对话路径已经把 4 类状态( cwd / v2 tasks / bash tasks / agent tasks)统一迁到 SSE 推送,删了对应的轮询 hook(`useSessionCwd` 5s 轮询、`useBashBackgroundTasks` 15s 轮询)与一次性 REST 兜底(详见 `docs/superpowers/specs/2026-07-19-sse-state-push-design.md`)。

代价:**首次打开一个长期未访问的 session、或在 SSE 还没 emit 第一条事件时 UI 是空态**。

| 状态 | 当前 cold-start 表现 |
|---|---|
| cwd | `ConfigStatusBar` 暂时 fallback 到 `useAppStore.instanceContext.cwdName`,直到 LLM 自切 cwd 触发 SSE |
| bash 后台任务 | `useBashBackgroundTasks` 返回 `[]`,dock 空白直到下一次 bash 后台命令 |
| v2 tasks | `AgentInputBox` 的 N/M 任务摘要显示 0,直到第一个 TaskCreate/Update tool_call |
| agent tasks | `useBackgroundTasks` 返回 `[]`,直到下一个 SSE `agent_task.changed` 推送 |

服务端有完整权威存储( `CwdStore` / `BashBackgroundTracker.byId` / `TaskListStore` 落盘 JSON / `BackgroundRuntime.store` 落盘 JSON),但前端没有取。

### 1.2 目标

1. 新增一个**单一**聚合 REST 端点 `GET /api/agent/sessions/:id/state`,一次性返回 4 类快照。
2. 前端在**首次打开 session** 与**切换 session** 两个时机触发 cold-start fetch。
3. SSE 仍是 source of truth:任何后续 SSE `*.changed` 都通过现有 reducer 自然覆盖 REST 写入。
4. REST 失败不影响 UI:任一字段拉取失败 → 静默跳过该字段,其它继续。

### 1.3 非目标 (YAGNI)

- 不实现服务端推送 vs REST 的"谁更新谁"的优先级仲裁层 — 简化为"后到的赢",SSE 后到 = 自然覆盖
- 不实现前端增量合并 vs 全量替换的优化 — 4 个字段都是数组/单值,直接赋值
- 不实现"检测到 stale 时主动重新 fetch" — 这是已有 SSE replay(256 ring buffer + Last-Event-ID)的职责
- 不实现 agent task 的服务端 `parentSessionId` filter 优化 — 简单 list 后 post-filter,数据量小(<10 task/session)
- 不动 `useEventStream` 现有 dispatch 逻辑 — 4 个 reducer 维持原样

---

## 2. 架构

```
zai-agent-core (权威存储)
  ├─ CwdStore        (in-memory Map<sessionId, SessionCwd>)
  ├─ BashTracker     (in-memory Map<taskId, BashTaskInfo>, 30min TTL + 200 LRU)
  ├─ TaskListStore   (~/.zai/tasks/<sid>.json, 原子写)
  └─ BackgroundRuntime → JsonTaskStore (~/.zai/tasks/<id>.json + events/<id>.log)
                          ↓ 全部由 server 端各取一次
zai server
  └─ routes/sessionState.ts:GET /api/agent/sessions/:id/state
       4 路并行,每路独立 try/catch,聚合返回
                          ↓ JSON
zai web
  └─ useAgentStore.hydrateSessionState(sid) action
       fetch → 4 个字段独立 set 进 cwdBySession / v2TasksBySession /
                            bashTasksBySession / agentTasksBySession
       ↓
  调用点:
    • useEventStream 收到 server.connected  → hydrateSessionState(sessionId)
    • useAgentStore.setCurrentSession(sid)  → hydrateSessionState(sid) (fire-and-forget)
```

---

## 3. 接口设计

### 3.1 Server endpoint

```
GET /api/agent/sessions/:id/state
→ 200 OK
  {
    "cwd":        { "cwd": "/abs/path", "updatedAt": 1721000000000 } | null,
    "v2Tasks":    [ { id, subject, description?, activeForm?, status,
                       blocks, blockedBy, owner?, updatedAt } ],
    "bashTasks":  [ BashTaskInfo ],
    "agentTasks": [ BackgroundTask ]
  }
```

- HTTP 200 即视为成功,内部 4 个数据源**各跑各的 try/catch**,任何一个抛错 → 对应字段 fallback 到 null / `[]`,不影响其它字段
- HTTP 4xx 仅在 `:id` 缺失或非 string 时(理论上 express 已经兜底)返回
- HTTP 5xx 不应出现 — 4 路都是内存读或单文件读,失败语义都已降级

**字段裁剪**:
- `v2Tasks` 沿用 `routes/v2Tasks.ts:33-43` 的裁剪规则(去掉 metadata/sessionId),不返 raw `TaskItem`
- `bashTasks` / `agentTasks` 透传 — 已经是 SSE payload 的同构 shape,前端 reducer 直接吃

### 3.2 Client action

```ts
// useAgentStore 新增
hydrateSessionState: async (sid: string) => {
  const headers = buildZaiTokenHeader()
  const res = await fetch(
    `/api/agent/sessions/${encodeURIComponent(sid)}/state`,
    { headers },
  )
  if (!res.ok) return          // 整端点失败 → 静默
  const snap = await res.json()
  set((s) => {
    const next = { ...s }
    // cwd: 只在 store 还没有该 sid 条目时覆盖
    // (否则服务器 cwd 可能比 SSE 后续推送旧一帧,会覆盖更新值)
    if (snap.cwd && !s.cwdBySession[sid]) {
      next.cwdBySession = { ...s.cwdBySession, [sid]: snap.cwd.cwd }
    }
    if (Array.isArray(snap.v2Tasks)) {
      next.v2TasksBySession = { ...s.v2TasksBySession, [sid]: snap.v2Tasks }
    }
    if (Array.isArray(snap.bashTasks)) {
      next.bashTasksBySession = { ...s.bashTasksBySession, [sid]: snap.bashTasks }
    }
    if (Array.isArray(snap.agentTasks)) {
      next.agentTasksBySession = { ...s.agentTasksBySession, [sid]: snap.agentTasks }
    }
    return next
  })
}
```

**字段独立覆盖**:`snap.v2Tasks` 字段缺失或非数组 → 跳过该字段;`snap.cwd === null` → 跳过。任意字段缺失不影响其它字段写入。

---

## 4. 服务端实现

### 4.1 新增路由

`packages/zai/src/server/routes/sessionState.ts`(约 60 行,挂载到 `server/index.ts`):

```ts
router.get('/agent/sessions/:id/state', async (req, res) => {
  const sid = req.params.id
  const [cwdResult, v2Result, bashResult, agentResult] = await Promise.all([
    Promise.resolve().then(() => {
      const cwd = CwdStore.has(sid) ? CwdStore.get(sid) : null
      // CwdStore 不存 updatedAt, 用 Date.now() 占位 — 服务端重启后 cwd
      // 全清, 这个 updatedAt 只用于客户端去重/debug, 精度不重要。
      return cwd ? { cwd, updatedAt: Date.now() } : null
    }),
    getTaskListStore().list(sid)
      .then((tasks) => tasks.map(trimV2Task))
      .catch((err) => { console.warn('[sessionState] v2 failed', err); return [] }),
    Promise.resolve().then(() => bashBackgroundTracker.list({ sessionId: sid }))
      .catch((err) => { console.warn('[sessionState] bash failed', err); return [] }),
    getBackgroundRuntime().list()
      .then((all) => all.filter((t) => t.parentSessionId === sid))
      .catch((err) => { console.warn('[sessionState] agent failed', err); return [] }),
  ])
  res.json({
    cwd: cwdResult,
    v2Tasks: v2Result,
    bashTasks: bashResult,
    agentTasks: agentResult,
  })
})
```

### 4.2 需要的 supporting 改动(0 处)

- **`BashBackgroundTracker.list({sessionId})` 已存在**(`packages/zai-agent-core/src/tools/BashTool/bashTracker.ts:312`),签名完全匹配,直接调用即可
- **`BackgroundRuntime.list()` 已经支持 TaskListFilter**(虽然只支持 status/limit),server 端拿全量 post-filter 即可,数据量小

---

## 5. 客户端集成

### 5.1 调用点 1:`useEventStream` 收到 `server.connected`

`packages/zai/src/web/src/store/useEventStream.ts:60-61`:
```ts
case 'server.connected':
  useAppStore.getState().setConnected(true)
  // ★ 新增:cold-start 快照补全
  const sid = useAgentStore.getState().sessionId
  if (sid) void useAgentStore.getState().hydrateSessionState(sid)
  break
```

**为什么用 server.connected 而非 SSE onopen**:EventSource onopen 只在浏览器层 TCP 建立时触发,不等 server 端 per-sid slice 注册完成。`server.connected` 是 server 在 send 完 SSE header 后发的第一条命名事件,代表"我准备好给你推这条 sid 的事件了"。此时拉 REST 拿 cold-start 快照,顺序是 server 先注册了 per-sid 切片,client 再拉快照,不会漏事件。

### 5.2 调用点 2:`setCurrentSession` 切换 session

`packages/zai/src/web/src/store/useAgentStore.ts` 的 `setCurrentSession` action,在已设置 `sessionId` 之后加一行:
```ts
setCurrentSession: async (sid: string) => {
  // ... existing logic: set({ sessionId: sid }), 重建 SSE handle 等
  // ★ 新增: 切会话后 cold-start fetch (fire-and-forget)
  void get().hydrateSessionState(sid)
}
```

**为什么也加这里**:server.connected 在切换时也会触发,但**它走的是 useEventStream 的 sessionId 订阅 — 旧 SSE handle close → 新 SSE handle open → 等 server.connected**。中间可能有几十毫秒到几百毫秒的窗口。在 setCurrentSession 同步路径里 fire-and-forget 一次 fetch,可以与新 SSE 连接建立**并行**进行,降低首屏可见状态延迟。

### 5.3 不动现有 reducer

4 个 `applyCwdChanged` / `applyV2TaskChanged` / `applyBashTaskChanged` / `applyAgentTaskChanged` reducer 维持原样。REST 写入和 SSE 写入共用同一个 set path,后到者覆盖前到者(SSE 因为 server 端写入先于 emit,通常会先到;REST 是 fire-and-forget,服务端处理顺序由 promise.all 决定,可能先于也可能后于 SSE 第一条;但所有后续 SSE 都晚于 REST,自然把 stale 值覆盖回最新值)。

---

## 6. 关键设计决策

### 6.1 为什么聚合端点而不是 4 个独立 endpoint

- ✅ 切 session 时只发一个 HTTP 请求
- ✅ 4 字段语义就是"cold-start 快照"这一 use case
- ✅ URL 路径一致,易于文档化与测试
- ❌ 失去按字段独立缓存的可能(不重要 — store 是内存,fetch 完后直接到 store)

### 6.2 cwd 字段为什么"只在 store 没有该 sid 时覆盖"

服务端 `CwdStore` 不存 `updatedAt`(精度不重要,见 §4.1 注释)。如果 client store 已经有该 sid 的 cwd(通常意味着 SSE 已经推过 `cwd.changed`),那么服务端的 cwd 可能比 SSE 后到的值**旧一帧**。直接覆盖会造成 cwd 显示回滚。只在 store 缺失时写入,等价于"cwd 只用 REST cold-fill,后续全部走 SSE"。

### 6.3 BashTracker 不落盘的兼容性

`bashTracker.ts` 顶部注释明确说"进程级单例,不落盘,进程重启后丢失可接受"。本次新增的 `listBySession` 在 server 重启后会返回 `[]`,与现有 cold-start 表现一致,不引入新的不变量。

### 6.4 不实现 topic 过滤

spec `2026-07-19-sse-state-push-design.md` §1.3 提到 `/api/event?topics=...` URL 参数。本期不实现 — 当前 EventSource 客户端没用 topics 参数( `lib/eventSource.ts` 没读 `topics` query)。若未来要减少 server 重连时 replay 量,再单独做,本期不阻塞。

---

## 7. 测试

### 7.1 Server unit (`packages/zai/src/server/test/unit/routes/sessionState.test.ts`)

- ✓ sid 存在 → 返回 200 + 4 字段
- ✓ sid 命中 CwdStore → `cwd` 非 null
- ✓ sid 未命中 CwdStore → `cwd === null`
- ✓ CwdStore 抛错(单元内 mock throw) → `cwd === null`,其它字段不受影响
- ✓ TaskListStore 抛错 → `v2Tasks: []`,其它字段不受影响
- ✓ BashTracker 抛错 → `bashTasks: []`,其它字段不受影响
- ✓ BackgroundRuntime 抛错 → `agentTasks: []`,其它字段不受影响
- ✓ agentTasks 只返回 `parentSessionId === sid` 的 task,过滤正确

### 7.2 Client unit (`packages/zai/src/web/src/store/useAgentStore.hydrateSessionState.test.ts`)

- ✓ fetch 200 + 完整 snap → 4 个 map 字段都写入
- ✓ snap.v2Tasks 缺失 → 不写 `v2TasksBySession`,其它字段照写
- ✓ snap.cwd 非 null + store.cwdBySession[sid] 已存在 → **不覆盖** cwd
- ✓ snap.cwd 非 null + store.cwdBySession[sid] 缺失 → 写入 cwd
- ✓ fetch 4xx / 5xx → 整 action 静默返回,store 不动

### 7.3 BashTracker unit

在 `bashTracker.test.ts`(若存在)或新建:
- ✓ `listBySession(sid)` 只返 `sessionId === sid` 的 task
- ✓ tracker 为空 → 返回 `[]`

---

## 8. 风险与已知限制

- **race window**(已接受):REST fetch 与 SSE 第一条 `*.changed` 事件之间存在几十毫秒窗口,期间 UI 会从"空"→"REST 填的快照"→"SSE 实时更新"。用户感知是 cold start 到首次有内容之间的延迟变短(因为有 REST 兜底),不会有"内容闪回"。
- **server 重启后 cwd 全清**:这是已有行为,本期不修。
- **bash task 进程重启后丢失**:这是已有行为,本期不修。
- **agent task 在 server 重启后由 JsonTaskStore 提供持久化**:`BackgroundRuntime.events()` 已经处理"in-memory record 找不到时退化为只回放历史"(`DefaultBackgroundRuntime.ts:160`),本期 cold-start 复用 `BackgroundRuntime.list()`,直接读磁盘 task 文件,等价于一次"全量回放",正确。

---

## 9. 文件清单

新增:
- `packages/zai/src/server/routes/sessionState.ts` (~60 行)
- `packages/zai/src/server/routes/sessionState.test.ts` (~150 行,与 `agent.cwd.test.ts` 同级)
- `packages/zai/src/web/src/store/useAgentStore.hydrateSessionState.test.ts` (~80 行)

修改:
- `packages/zai/src/server/index.ts` (注册新 router,~2 行)
- `packages/zai/src/web/src/store/useAgentStore.ts` (新增 `hydrateSessionState` action + `setCurrentSession` 末尾加一行)
- `packages/zai/src/web/src/store/useEventStream.ts` (server.connected case 加一行)

不修改:
- 4 个 `apply*Changed` reducer
- `lib/eventSource.ts`(SSE subscribe)
- `CwdStore` / `TaskListStore` / `JsonTaskStore`(服务端存储层)
- `useSessionCwd` / `useBashBackgroundTasks` / `useBackgroundTasks` 三个 hook 的 selector

---

## 10. 交付方式

- 单分支 `feat/session-cold-state` 一次性落地
- 提交顺序建议:
  1. `feat(zai-agent-core): BashTracker.listBySession` + 单测
  2. `feat(zai-server): GET /api/agent/sessions/:id/state` + 单测
  3. `feat(zai-web): useAgentStore.hydrateSessionState` + 单测 + 接线(server.connected / setCurrentSession)
- 不拆 PR — 端到端可独立测,中间态不可用