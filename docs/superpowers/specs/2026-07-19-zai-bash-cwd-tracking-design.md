# zai LLM 自切 cwd 能力 移植设计

> 把 opencc 的 "BashTool trailer 跟踪 shell cwd" 能力搬到 zai，让 LLM 跑 `cd foo` 后，后续 Bash / FileRead / Glob 等工具在新的 cwd 下执行。zai 多 session 共享一个 server 实例，所以 cwd 必须按 sessionId 隔离。

---

## 1. 背景与目标

### 1.1 痛点

zai 当前 BashTool 每次都用 `cfg.workdir`（实例启动 cwd）spawn 新进程，LLM 在 Bash 里跑 `cd /tmp` 只影响那一次子进程的内部 cwd，对后续工具调用完全无感知：

- LLM 切到 `/tmp` 后调 FileRead，相对路径 `./foo.txt` 找不到文件
- LLM 切到 git worktree 干活后，主 cwd 还是 repo root，行为割裂
- 系统 prompt 里的 `CWD:` 永远是实例启动 cwd，不反映 LLM 实际工作目录

opencc 通过"shell trailer 钩子"解决了这个问题：

```bash
# bashProvider.ts:155-186 把用户命令拼成:
eval '<用户命令>' && pwd -P >| /tmp/claude-<id>-cwd
# 子进程退出后 readFileSync 拿到新 cwd, 对比旧值, 写全局 state
```

zai 之前的 `cwd.ts` 留了 ALS 接口但底层 `getCwdState / setCwd` 引用了不存在的 `bootstrap/state.ts`，是残缺状态。

### 1.2 目标

- LLM 在 BashTool 跑 `cd <path>` 后，**同 session** 的后续所有工具调用都用新 cwd
- 多 session 并发时，session A 切 cwd 不影响 session B
- 前端展示当前 session 的 cwd（替代静态的实例启动 cwdName）
- 不做目录权限限制（用户明确延后处理）
- 不引入 npm 新依赖

### 1.3 与 opencc 的区别

| 维度 | opencc | zai（本次设计） |
|---|---|---|
| 隔离单位 | ALS SDK context（per-SDK-call） | Map<sessionId, cwd>（per-session） |
| 隔离层数 | 3 层 ALS + 全局 STATE | 1 层 Map（sessionId 直接定位） |
| Sub-agent cwd 隔离 | ✅ 通过 `runWithCwdOverride` 包装 | ❌ 暂不做（将来再加） |
| `resetCwdIfOutsideProject` | ✅ 漂出 allowed dir 拉回 | ❌ stub 保留 false（用户明确不做权限限制） |
| `CwdChanged` hook | ✅ 触发 `executeCwdChangedHooks` | ❌ 不做（zai 暂未消费 hooks） |
| `AdditionalWorkingDirectory` 权限扩展 | ✅ 自动加入 allowed dirs | ❌ 不做 |
| 前端展示 | 不需要（CLI） | ✅ 每 5s 轮询 + ConfigStatusBar 展示 |

---

## 2. 总体架构

### 2.1 系统拓扑

```
┌──────────────────────────────────────────────────────────────────┐
│ zai-server  (单进程，N 个 session 共享)                          │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ CwdStore  (新文件: zai-agent-core/src/runtime/cwdStore)  │    │
│  │   Map<sessionId, { cwd: string; updatedAt: number }>     │    │
│  │   get / set / getOrInit / delete                         │    │
│  └──────────────────────────────────────────────────────────┘    │
│           ▲              ▲                       ▲              │
│           │ 初始化        │ 写入                  │ 读取         │
│  ┌────────┴──────┐ ┌─────┴────────┐ ┌───────────┴───────────┐  │
│  │ agent.ts     │ │ BashTool.ts  │ │ /api/agent/sessions/   │  │
│  │ prompt 入口  │ │ call()       │ │   :id/pwd  GET         │  │
│  └──────────────┘ └──────────────┘ └───────────────────────┘  │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ cwd.ts (改)                                              │    │
│  │   新增: sessionIdStorage (ALS) + runWithSessionId       │    │
│  │   改: getCwd() / setCwd() → 从 ALS 取 sid → 查 CwdStore│    │
│  │   保留: pwd() / getCwd() / runWithCwdOverride 不变       │    │
│  └─────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
                                ▲
                                │ 5s 轮询 GET /api/agent/sessions/:id/pwd
                                │
┌───────────────────────────────┴──────────────────────────────────┐
│ zai-web                                                           │
│  useSessionCwd(sessionId) → ConfigStatusBar 替换原 cwdName        │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 关键决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| CwdStore 位置 | `zai-agent-core/src/runtime/cwdStore.ts` | 跟 `queryLoop` / `toolExecution` 同层；放 `runtime/` 子目录会与 background runtime 语义冲突 |
| sessionId 传递 | **新增 ALS `sessionIdStorage`** | 让 `getCwd()` / `setCwd()` 保持无参（跟 opencc 的 SDK context 同构），所有现有调用方零签名改动 |
| CwdStore 持久化 | 仅内存 Map | 进程崩溃 = session 重启，transcript 重跑，cwd 不需要持久 |
| trailer 注入点 | BashTool.ts:294 `spawn` 之前 | 直接复用 opencc `bashProvider.ts:185` 模式 |
| tmpfile 路径 | `/tmp/zai-bash-<taskId>-cwd` | 跟现有 `persistShellOutput.ts` 的 `/tmp/zai-bash-<taskId>.txt` 同前缀，taskId 唯一 |
| 前端轮询频率 | 5s | 用户在 brainstorm 中确认 |
| 前端展示位 | ConfigStatusBar 替换 cwdName | 用户在 brainstorm 中确认 |

---

## 3. 端到端数据流

### 3.1 Session 初始化

```
1. POST /api/agent/prompt  { prompt, sessionId?: "sess-abc" }
   ↓
2. agent.ts:311 handler 入口
     ctx.cwd = 进程启动 cwd（不变，作为 fallback）
     sessionId = existingSessionId ?? newSessionId()
   ↓
3. fire-and-forget 异步执行，第一步:
     runWithSessionId(sessionId, async () => {
       CwdStore.getOrInit(sessionId, ctx.cwd)
         // map 里没有 → map.set(sessionId, { cwd: ctx.cwd, updatedAt: Date.now() })
       const cwd = getCwd()  // 通过 ALS 拿到 sid → CwdStore.get(sid) = ctx.cwd
       // ↓
       // queryLoop(...)，所有后续 cwd() 调用都走 ALS + CwdStore
     })
   ↓
4. system prompt 拼装:prompts.ts:469 "CWD: ${getCwd()}"
   → 返回 ctx.cwd（首次）/ 新 cwd（cd 后）
```

### 3.2 BashTool 切 cwd

```
1. LLM tool_use Bash({ command: "cd /tmp && ls" }, toolUseId=t1, sessionId)
   ↓
2. BashTool.call(input, ctx)
     ctx.sessionId (新增字段，从 ctx.__runtimeConfig.sessionId 取)
     effectiveWorkdir = useSandbox ? cfg.workdir : CwdStore.get(ctx.sessionId) ?? process.cwd()
   ↓
3. tmpfile = `/tmp/zai-bash-${taskId}-cwd`
     commandString = input.command + `\npwd -P >| ${tmpfile}`
     spawn('sh', ['-c', commandString], { cwd: effectiveWorkdir })
   ↓
4. child.on('exit', code, signal):
     bashBackgroundTracker.markFinished(...)
     if (!preventCwdChanges && !backgroundTaskId) {  // 仅 foreground 主线程
       try {
         newCwd = readFileSync(tmpfile, 'utf8').trim()
         oldCwd = CwdStore.get(ctx.sessionId)
         if (newCwd !== oldCwd) {
           CwdStore.set(ctx.sessionId, newCwd)
           logEvent('zai_bash_cwd_changed', { sessionId, oldCwd, newCwd })
         }
         unlinkSync(tmpfile)  // 清理
       } catch {
         logForDebugging(`cwd trailer failed for ${ctx.sessionId}`)
       }
     }
     resetCwdIfOutsideProject()  // 仍是 stub 返回 false
   ↓
5. CwdStore.set 内部:
     map.set(sessionId, { cwd: newCwd, updatedAt: Date.now() })
```

### 3.3 前端展示

```
1. Agent.tsx 当前选中 session
     sessionId = useAgentStore(s => s.sessionId)
   ↓
2. useSessionCwd(sessionId) hook
     启动时: fetch GET /api/agent/sessions/:id/pwd 立即拿一次
     setInterval(5_000): 重复 fetch
     sessionId 变化: clearInterval + 重启
     unmount: clearInterval
     fetch 失败/超时: catch 静默，保留旧值
   ↓
3. server GET /api/agent/sessions/:id/pwd
     sid = req.params.id
     cwd = CwdStore.get(sid) ?? process.cwd()
     if (cwd == process.cwd() && !CwdStore.has(sid)) return 404
     res.json({ cwd, updatedAt })
   ↓
4. ConfigStatusBar 收到 cwd
     Layout.tsx 原本 setInstanceContext({ cwdName: <basename> }) 改为传 sessionCwdName
     UI: 顶部黄色小字 `${basename(sessionCwd)}` 替换静态 cwdName
```

### 3.4 关键不变量

| 不变量 | 保证方式 |
|---|---|
| 同一 session 内 cwd 一致 | `Map<sessionId, cwd>` 单写者（BashTool trailer） |
| 不同 session 互不影响 | key 是 sessionId，不会跨 key 读写 |
| cwd 写失败不影响 Bash 结果 | try/catch 包 readFileSync，失败时 cwd 不变 |
| tmpfile 不泄漏 | BashTool exit handler 里 unlinkSync + 错误吞 |
| CwdStore 永远有 fallback | `get(sessionId) ?? process.cwd()` |
| 进程崩溃后 cwd 丢失可接受 | transcript 重跑即可，无持久化 |

---

## 4. 错误处理

### 4.1 错误矩阵

| 错误场景 | 触发条件 | 行为 |
|---|---|---|
| tmpfile 读失败 (ENOENT) | sh 进程被杀 / 命令早期失败 / `set -e` 触发 | try/catch 静默，保留旧 cwd |
| tmpfile 读失败 (EIO / 权限) | tmpdir 满 / SELinux | logForDebugging warn，保留旧 cwd |
| tmpfile unlink 失败 | 已被外部清理 / TOCTOU | silent 吞 |
| newCwd == oldCwd | cd 命令失败 / 命令没改 cwd | 跳过 CwdStore.set，避免无谓更新 |
| CwdStore.get(sid) 返回 undefined | session 从未调过 getOrInit | fallback 到 process.cwd() |
| session 不存在（GET /pwd） | 收到未知 sid | 返回 404，前端保留旧值 |
| 前端轮询失败（网络抖） | fetch throw / 5xx | hook 内 catch 静默，保留上一次 cwd |
| 前端轮询 timeout | 后端卡住 | AbortController 5s timeout，保留旧值 |
| tmpfile path 冲突 | taskId 复用 / 并发 | `id = randomUUID().slice(0,8)` 已避免 |
| CwdStore 内存泄漏 | session 关闭但 map 没清理 | DELETE session 时调 `CwdStore.delete(sid)` |

### 4.2 日志

- **info**: `CwdStore.set` 成功 → `logEvent('zai_bash_cwd_changed', { sessionId, oldCwd, newCwd })`
- **warn**: tmpfile read/unlink 失败 → `logForDebugging`
- **debug**: 轮询请求 → 默认关，`ZAI_DEBUG=1` 时打开

### 4.3 并发与取消

- **aborted bash 命令**: sh 进程已被 `ctx.abortSignal` kill → 不会跑 trailer → tmpfile 不存在 → ENOENT → silent
- **trailer 自身超时**: 没有独立超时，跟 child exit 一起；`pwd -P` 几乎不会卡，整个 spawn 受 `timeoutMs` 兜底
- **同 session 多并发 Bash**: 不可能，queryLoop 串行 `executeToolsStreaming`
- **跨 session 并发 Bash**: 不同 sessionId key，BashTool trailer 各自读自己的 tmpfile，各自写自己的 map，互不干扰

---

## 5. API 与数据形状

### 5.1 Server 端

**新增路由**: `GET /api/agent/sessions/:id/pwd`

Response 200:
```json
{ "cwd": "/Users/ethan/code/proj/subdir", "updatedAt": 1721370000000 }
```

Response 404（session 未注册）:
```json
{ "error": "session not found" }
```

挂在现有 `agent.ts` router 上（已经有 `/agent/sessions`, `/agent/sessions/:id` 等 CRUD，加一条即可）。

### 5.2 CwdStore API

```typescript
// zai-agent-core/src/runtime/cwdStore.ts
export interface SessionCwd {
  cwd: string
  updatedAt: number
}

export const CwdStore = {
  get(sessionId: string): string | undefined
  set(sessionId: string, cwd: string): void
  getOrInit(sessionId: string, defaultCwd: string): string
  has(sessionId: string): boolean
  delete(sessionId: string): void
  size(): number  // 测试用
  clear(): void  // 测试用
}
```

### 5.3 cwd.ts 新增 ALS

```typescript
// zai-agent-core/src/opencc-internals/utils/cwd.ts
const sessionIdStorage = new AsyncLocalStorage<string>()

export function runWithSessionId<T>(sessionId: string, fn: () => T): T {
  return sessionIdStorage.run(sessionId, fn)
}

export function getCurrentSessionId(): string | undefined {
  return sessionIdStorage.getStore()
}

// getCwd() 实现改为:
export function getCwd(): string {
  const sid = sessionIdStorage.getStore()
  if (sid) {
    return CwdStore.get(sid) ?? process.cwd()
  }
  return process.cwd()  // ALS 外 fallback（应该不会发生）
}
```

签名保持无参 → `prompts.ts` / `path.ts` / `file.ts` / `outputStyles.ts` 等所有调用方零改动。

### 5.4 前端 store / hook

**新增**: `packages/zai/src/web/src/hooks/useSessionCwd.ts`

```typescript
export function useSessionCwd(sessionId: string | null): string | undefined {
  // - 立即 fetch 一次
  // - setInterval(5_000)
  // - sessionId 变化时 clearInterval + 重启
  // - fetch 失败 / 404 保留旧值
  // - unmount clearInterval
  return cwd
}
```

**修改**: `packages/zai/src/web/src/components/ConfigStatusBar.tsx`
- 新增可选 prop `sessionCwd?: string`
- 渲染优先级: `sessionCwd ? basename(sessionCwd) : cwdName`

**修改**: `packages/zai/src/web/src/components/Layout.tsx:41-44`
- 在 `useAppStore` 拿到 instanceContext 后，再加一个 `<SessionCwdBridge />` 组件（避免 Layout 直接订阅 useAgentStore）

新增 `SessionCwdBridge.tsx`:
```typescript
export function SessionCwdBridge() {
  const sessionId = useAgentStore(s => s.sessionId)
  const sessionCwd = useSessionCwd(sessionId)
  const setInstanceContext = useAppStore(s => s.setInstanceContext)
  useEffect(() => {
    setInstanceContext(prev => ({ ...prev, cwdName: sessionCwd ? basename(sessionCwd) : prev.cwdName }))
  }, [sessionCwd])
  return null
}
```

---

## 6. 文件变更清单

### 6.1 新增

| 路径 | 用途 |
|---|---|
| `packages/zai-agent-core/src/runtime/cwdStore.ts` | CwdStore 实现 |
| `packages/zai-agent-core/src/runtime/cwdStore.test.ts` | 单元测试 |
| `packages/zai-agent-core/src/opencc-internals/utils/cwd.test.ts` | ALS sessionId 注入测试 |
| `packages/zai/src/server/routes/cwd.test.ts` (或扩 `agent.test.ts`) | GET /pwd API 测试 |
| `packages/zai/src/web/src/hooks/useSessionCwd.ts` | 前端轮询 hook |
| `packages/zai/src/web/src/hooks/useSessionCwd.test.ts` | hook 测试 |
| `packages/zai/src/web/src/components/SessionCwdBridge.tsx` | Layout 桥接组件 |

### 6.2 修改

| 路径 | 改动 |
|---|---|
| `packages/zai-agent-core/src/opencc-internals/utils/cwd.ts` | 新增 `runWithSessionId` + `sessionIdStorage`，改 `getCwd` 实现 |
| `packages/zai-agent-core/src/tools/BashTool/BashTool.ts` | spawn 拼接 trailer；exit handler 读 tmpfile + 写 CwdStore |
| `packages/zai-agent-core/src/tools/BashTool/BashTool.test.ts` | 新增 trailer / CwdStore 交互段 |
| `packages/zai/src/server/routes/agent.ts` | 新增 GET `/sessions/:id/pwd`；prompt handler 包 `runWithSessionId` |
| `packages/zai/src/server/services/agentRuntime.ts` | `initAgentRuntime` 时不需特殊处理（CwdStore 是 module singleton） |
| `packages/zai/src/web/src/components/Layout.tsx` | 渲染 `<SessionCwdBridge />` |
| `packages/zai/src/web/src/components/ConfigStatusBar.tsx` | 新增 `sessionCwd` prop |
| `packages/zai/src/web/src/components/ConfigStatusBar.test.tsx` | 新增 sessionCwd case |

### 6.3 不改

- `utils.ts:resetCwdIfOutsideProject` — 保持 stub false（不做权限限制）
- `executeCwdChangedHooks` — 不调用（zai 不消费 hooks）
- `AdditionalWorkingDirectory` — 不接入（不做权限扩展）
- `bootstrap/state.ts` — 不实现（用 CwdStore 替代 STATE）
- `runtime/types.ts` — 不改

---

## 7. 测试策略

### 7.1 单元测试

**`cwdStore.test.ts`**
- get 已有 sid → 返回 cwd
- get 未注册 sid → 返回 undefined
- set 新 sid → map 写入
- set 已有 sid → 覆盖 + updatedAt 推进
- getOrInit 首次调用 → 写入 default
- getOrInit 第二次调用 → 返回已有值，不覆盖
- delete(sid) → 移除
- delete 不存在的 sid → noop

**`cwd.test.ts`**
- runWithSessionId 外 → getCwd() fallback process.cwd()
- runWithSessionId 内 → getCwd() 返回 ALS sid 对应的 cwd
- 嵌套 runWithSessionId → 内层覆盖外层
- runWithCwdOverride 嵌套 → ALS cwd override 仍生效

**`BashTool.test.ts` 新增 trailer 段**
- call 拼接 trailer: `'echo hi'` → spawn 接 `'echo hi\npwd -P >| /tmp/zai-bash-<taskId>-cwd'`
- exit handler 读 tmpfile + 写 CwdStore（mock child + fake fs）
- newCwd === oldCwd → 不调 CwdStore.set
- tmpfile ENOENT → 不抛，cwd 不变
- sessionId 缺失 → CwdStore.getOrInit 用 process.cwd()

### 7.2 集成测试

**`agent.cwd.test.ts`**
- POST /agent/prompt (新 sid) → CwdStore 出现 sid → cwd = ctx.cwd
- POST /agent/prompt (带旧 sid) → 恢复已有 cwd
- GET /agent/sessions/:sid/pwd (存在) → 返回 cwd
- GET /agent/sessions/:unknown/pwd → 404
- DELETE /agent/sessions/:sid → CwdStore.delete(sid) 被调

**`BashTool.cwd.integration.test.ts`**
- session A `cd /tmp` → map[sidA] = `/tmp`
- 同 session 下次 Bash `pwd` → effectiveWorkdir = `/tmp`
- session A `cd /tmp`, session B 同时创建 → map[sidB] 仍是 ctx.cwd
- `cd /nonexistent` → sh 报错 exit 1 → CwdStore 不变

### 7.3 前端测试

**`useSessionCwd.test.ts`**
- 初始立即 fetch → 拿到 cwd
- 5s 后第二次 fetch（fake timers）
- sessionId 变化 → clearInterval + 重启
- unmount → clearInterval
- fetch 失败 → 保留旧值
- 返回 undefined → 显示 fallback

**`ConfigStatusBar.test.tsx`**（已有，加 case）
- 收到 sessionCwd → 渲染 basename
- cwd = `/` → 渲染 `/`
- sessionCwd undefined → 渲染 fallback cwdName

### 7.4 手工 E2E 验收清单

- [ ] 启动 zai → ConfigStatusBar 显示启动 cwd basename
- [ ] 让 LLM `cd /tmp` → 5s 内 status bar 变 `tmp`
- [ ] 切到另一个 session → status bar 立即变回该 session 的 cwd
- [ ] 切回原 session → 仍是 `tmp`（不被另一个 session 污染）
- [ ] session 删除 → map 中对应 key 也清除
- [ ] 后端重启 → session transcript 重跑 → cwd 重置到 ctx.cwd

---

## 8. 风险与权衡

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| `pwd -P >| tmpfile` 在某些 shell 不支持 | 低 | trailer 失败，cwd 不更新 | opencc 已经在 macOS/Linux/WSL 验证；zai 也只支持 POSIX |
| 同 taskId 复跑导致 tmpfile 串 | 极低 | 读到上次的 cwd | taskId 用 `randomUUID().slice(0,8)` 唯一 |
| 前端 5s 轮询在大量 session 时打爆 server | 低 | 性能 | 后续可换 SSE 广播 `cwd.changed` 事件 |
| CwdStore 内存增长 | 低 | 几 KB / session × N | session 删除时 delete；正常上限 100 sessions ≈ 几十 KB |
| ALS + Map 双层结构 vs opencc 三层 ALS | 已是设计选择 | 失去 SDK context 隔离能力 | runWithCwdOverride 仍保留，将来 sub-agent 可补 |
| BashTool 改动影响现有 sed 模拟 / 后台任务 | 低 | regression | 全面跑 BashTool 现有测试；trailer 只在 foreground 路径加 |

---

## 9. 实施步骤概要

具体步骤由 writing-plans skill 生成。概要：

1. 新建 `CwdStore` + 单测
2. 改 `cwd.ts` 加 `runWithSessionId` + ALS + 单测
3. 改 `BashTool.ts` 加 trailer 注入 + exit handler + 单测
4. 改 `agent.ts` 加 GET `/pwd` + 包 `runWithSessionId` + 集成测试
5. 改 `agent.ts` DELETE session 时调 `CwdStore.delete`
6. 新建 `useSessionCwd` hook + 单测
7. 新建 `SessionCwdBridge` + 改 `Layout` + 改 `ConfigStatusBar` + 测试
8. 手工 E2E 验收清单跑一遍