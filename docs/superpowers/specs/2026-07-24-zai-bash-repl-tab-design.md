# Bash REPL Tab Design

**Status:** Draft (post-brainstorming)
**Date:** 2026-07-24
**Branch:** `feat/bash-repl-tab` (worktree off `main`)

## 1. Background & Goal

zai 右侧展开区（`SplitPane`）当前承载 `Files` / `Git` / `待定` 三个 Tab。
"待定" 是占位 Tab。用户希望在 `SplitPane` 中新增一个 **Bash Tab**，允许在 UI 中手动执行 bash 命令并实时看到流式 stdout / stderr 输出，与 LLM agent 触发的 Bash Tool 完全独立。

**Goal**: 在 `SplitPane` 增加 `Bash` Tab，承载一个 per-session 的交互式 REPL：
- 用户敲命令 → Enter 执行
- 输出（stdout/stderr）按 chunk 增量推送、自动滚动
- 当前命令运行中可点 abort 强制终止
- 切换 session 时 Bash Tab 切换到对应 session 的 REPL

**Non-goals**（明确不在本轮范围）：
- ANSI 颜色解析、Tab 补全、Ctrl-C / Ctrl-L 快捷键
- 命令历史持久化（仅 session 内）
- 命令历史重放 / 重新执行
- 与 LLM agent 触发的 Bash Tool 共享任何状态

## 2. Architecture

```
Server (zai package)
├── services/repl/
│   ├── ReplSession.ts          # 单 session 的 REPL 状态机
│   ├── ReplRegistry.ts         # Map<sessionId, ReplSession> 单例
│   └── types.ts                # ReplEvent / ExecRequest / ExecResponse
└── routes/bashRepl.ts          # 3 个 endpoint: exec / events(SSE) / abort

Web
├── components/splitPane/
│   ├── BashTab.tsx             # 新 Tab 组件
│   └── SplitPane.tsx           # 扩 TabKey + 注册新 Tab (替换'待定')
├── hooks/useBashRepl.ts        # SSE 连接 / exec / abort
└── lib/bashReplApi.ts          # fetch 包装
```

**关键边界**：
- `ReplSession` 不感知 LLM / agent 路径，完全独立
- `ReplRegistry` 是 process-level singleton（与 `BashTracker`、`EventBus` 同级）
- `BashTab` 不直连 SSE，调用 `useBashRepl` hook

## 3. Component Contracts

### 3.1 `ReplSession`（server）

**State**（仅内存）：
- `child: ChildProcess | null` — 当前运行的子进程
- `events: EventEmitter` — 内部事件总线（stdout/stderr/exit/error）
- `history: ExecRecord[]` — 所有执行记录（execId, command, startedAt, finishedAt, exitCode, signal）
- `busy: boolean` — child 是否在跑
- `cwd: string` — 初始 cwd（`exec` 时可被覆盖）

**API**：

```ts
class ReplSession {
  constructor(defaultCwd: string)
  async exec(command: string, opts?: { cwd?: string }): Promise<{ execId: string; startedAt: number }>
  // throws ReplBusyError when busy

  abort(): void
  // SIGTERM, 5s 后升级 SIGKILL

  dispose(): void
  // kill child, clear history, close all listeners

  on(handler: (ev: ReplEvent) => void): () => void
  // 返回 unsubscribe 函数
}

class ReplBusyError extends Error {
  readonly currentExecId: string
}
```

**关键行为**：
- `exec` 时 `spawn('sh', ['-c', command], { cwd, env: filteredEnv })`，env 过滤白名单：`PATH`, `HOME`, `USER`, `LANG`, `LC_*`, `TZ`
- stdout/stderr 各自 `on('data', chunk => emit({kind, execId, chunk, ts}))`
- child `'exit'` → emit `{kind:'exit', execId, code, signal, ts}` → `busy=false`, `child=null`
- child `'error'`（如 ENOENT）→ emit `{kind:'error', execId, message, ts}` → `busy=false`, `child=null`

### 3.2 `ReplRegistry`（server）

```ts
class ReplRegistry {
  private map = new Map<string, ReplSession>()

  get(sessionId: string, defaultCwd: string): ReplSession
  // 懒加载：不存在则用 defaultCwd 创建空实例

  dispose(sessionId: string): void
  // 删除 entry，调用 session.dispose()
}

// Singleton: module-level `_registry`
export function getReplRegistry(): ReplRegistry
```

### 3.3 `ReplEvent`（SSE 载荷）

```ts
export type ReplEvent =
  | { kind: 'stdout'; execId: string; chunk: string; ts: number }
  | { kind: 'stderr'; execId: string; chunk: string; ts: number }
  | { kind: 'exit'; execId: string; code: number | null; signal: string | null; ts: number }
  | { kind: 'error'; execId: string; message: string; ts: number }

export type ExecRequest = { command: string; cwd?: string }
export type ExecResponse =
  | { ok: true; execId: string; startedAt: number }
  | { ok: false; busy: true; currentExecId: string }
```

### 3.4 Routes

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/bash/repl/:sessionId/exec` | `ExecRequest` | `200 ExecResponse{ok:true}` / `409 ExecResponse{ok:false,busy}` / `500 {error}` |
| GET | `/api/bash/repl/:sessionId/events` | — | SSE `data: ReplEvent` (15s 心跳, no replay) |
| POST | `/api/bash/repl/:sessionId/abort` | — | `200 {ok:true}` / `409 {error:'no command running'}` |

- `events` 路由 `res.setHeader('Cache-Control','no-cache')` + `res.setHeader('Content-Type','text/event-stream')`
- `defaultCwd` 由路由 handler 注入：`instanceContext.cwd ?? process.cwd()`

### 3.5 `useBashRepl`（web hook）

```ts
function useBashRepl(sessionId: string | null, defaultCwd: string | null): {
  events: ReplEvent[]
  busy: boolean
  currentExecId: string | null
  connected: boolean
  exec: (command: string) => Promise<{ ok: true; execId: string } | { ok: false; busy: boolean; currentExecId: string }>
  abort: () => Promise<void>
  clear: () => void
}
```

**关键行为**：
- `sessionId` 或 `defaultCwd` 变化 → 关闭旧 EventSource、建新的；events 数组清空
- EventSource 自动重连（浏览器原生）；`connected` 由 onopen/onerror 维护
- `exec` 不抛：busy=true 时返回 `{ok:false, busy:true, currentExecId}`，调用方决定是否 toast

### 3.6 `BashTab`（web 组件）

```
┌─────────────────────────────────────────────────┐
│ Bash · /Users/.../cwd  · ● (idle/running)        │  ← header
├─────────────────────────────────────────────────┤
│ $ ls -la                                       │
│ drwxr-xr-x ...                                │
│ ...                                            │
│ ── exit 0 ──                                  │
│                                                 │
│ $ sleep 5; echo done                          │
│ done                                            │
│ ── exit 0 (5.2s) ──                          │  ← output area (flex:1, auto-scroll)
├─────────────────────────────────────────────────┤
│ [____________________ input ________________]  │  ← Input (Enter=exec)
│                                                  [abort] │  ← 仅 busy 时显示
└─────────────────────────────────────────────────┘
```

**渲染细节**：
- output 区：`whiteSpace:'pre-wrap'`、`fontFamily:'ui-monospace,Menlo'`
- stderr 染色：浅红 `#ef4444`
- exit-0 染色：绿 `#52c41a`；exit-非零：橙 `#f59e0b`；被信号杀：灰
- 切 session 时 output 清空（SSE 不补发历史 — 仅内存范围）

### 3.7 `SplitPane` 改动

- `TabKey = 'git' | 'fs' | 'bash'`（删 `'tbd'`）
- `items` 数组：
  ```tsx
  { key: 'bash', label: 'Bash', children: <BashTab sessionId={activeSessionId} cwd={cwd} /> },
  ```
- `STORAGE_KEYS.tab` 默认值由 `'git'` 不变（用户已习惯 Git 默认）

## 4. Data Flow

### 4.1 一次 exec 的完整流

```
[BashTab Input "ls -la"]
  ↓ Enter
[useBashRepl.exec('ls -la')]
  ↓ fetch POST /api/bash/repl/:sid/exec {command, cwd}
[routes/bashRepl.ts handler]
  ↓ ReplRegistry.get(sid, cwd)  // 懒加载
  ↓ ReplSession.exec('ls -la', {cwd: '/foo'})
  ↓ spawn('sh', ['-c', 'ls -la'], {cwd:'/foo', env})
  ↓ return {execId:'e-1', startedAt: ...}
  ↓ ReplSession.on(handler) 由 SSE 路由在 events endpoint 注册
[response 200 {ok:true, execId:'e-1'}]
  ↓
[useBashRepl: busy=true, currentExecId='e-1']
  ↓ (与此同时)
[child.stdout.on('data')] → ReplSession.events.emit({kind:'stdout', execId:'e-1', chunk, ts})
  ↓ SSE handler: res.write(`data: ${JSON.stringify(ev)}\n\n`)
  ↓
[useBashRepl SSE onmessage] → push events[]
  ↓
[BashTab] → output 区 auto-append + scroll-to-bottom
  ↓
[child 'exit'] → emit({kind:'exit', execId:'e-1', code:0})
  ↓ SSE → useBashRepl: busy=false, currentExecId=null
  ↓ BashTab 显示分隔行 '── exit 0 ──'，abort 按钮消失
```

### 4.2 abort 流

```
[BashTab 点击 abort]
  ↓
[useBashRepl.abort()]
  ↓ POST /api/bash/repl/:sid/abort
[bashRepl.ts → ReplSession.abort()]
  ↓ child.kill('SIGTERM')，setTimeout(5000)→SIGKILL
  ↓ child 'exit' → emit({kind:'exit', code:null, signal:'SIGTERM'})
  ↓
[useBashRepl: busy=false]
```

### 4.3 切 session 流

```
[SplitPane 切 active session → BashTab 重 mount，sessionId 变化]
  ↓
[useBashRepl useEffect on sessionId 变化]
  ↓ old EventSource.close()；new EventSource(/events?sid=newSid)
  ↓ 新 session 没历史 events（仅内存）
  ↓ BashTab 清空 output，等待用户输入
```

### 4.4 错误处理

| 场景 | 处理 |
|---|---|
| spawn 失败（ENOENT） | ReplSession emit `{kind:'error', message:'spawn ENOENT'}`，exec endpoint 仍返回 200 + execId（child 已死但 execId 已记录）；busy=false |
| 上一命令在跑 | POST exec 返回 409 `{ok:false, busy:true, currentExecId}` |
| child 被信号杀 | `{kind:'exit', code:null, signal:'SIGTERM'}`，前端 signal 灰显示 |
| SSE 断连 | EventSource 自动重连，UI 显示"重连中"灰条（connected=false）；不补发历史 |

## 5. Testing

### 5.1 单测（vitest）

**`ReplSession.test.ts`**：
- `exec` 启动 child、stdout/stderr 正确 emit（用 `echo` / `>&2 echo`）
- `exec` 已有 child 时抛 `ReplBusyError`
- `abort` 调 SIGTERM（mock child.kill）；超时升级 SIGKILL
- child 自然 exit（code 0 / 非 0）→ emit `{kind:'exit', code}`
- child 被信号杀 → emit `{kind:'exit', code:null, signal}`
- spawn ENOENT（不存在的 command）→ emit `{kind:'error', message}`、busy=false
- dispose() 后再 exec 报错或重新初始化（明确 dispose 后状态）

**`ReplRegistry.test.ts`**：
- `get` 懒加载：首次调用创建新实例，二次调用同 sessionId 返回相同实例
- `get` 接受 defaultCwd 用于首次 exec
- 不同 sessionId 之间完全隔离

**`bashRepl.routes.test.ts`**（supertest）：
- POST exec 200（无 busy）
- POST exec 409（连续两次 exec）
- GET events 推送 stdout / stderr / exit（用 stream consumer）
- POST abort 触发 SIGTERM
- 500 路径：mock ReplSession.exec 抛错

### 5.2 前端

**`useBashRepl.test.ts`**（vitest + jsdom + mock EventSource）：
- exec 推 busy=true，SSE 收到 exit 后 busy=false
- sessionId 变化关闭旧 EventSource、建新的
- abort 调用 POST endpoint
- 断线重连（mock EventSource 触发 error → open 序列）

**`BashTab.test.tsx`**：
- Enter 触发 exec
- busy 时 abort 按钮出现
- 收到 exit event 后显示分隔行
- stderr 染色
- 输入框 busy 时禁用

### 5.3 E2E（手测）

启动 server（worktree 分支），访问 web，开 Bash Tab：
- 跑 `ls`、`echo`、长输出（`yes | head -100`）
- 跑会失败命令（`false`、`nonexistent-cmd`）
- 跑会卡死命令（`sleep 30`），中途点 abort
- 切 session 后 Bash Tab output 清空
- 刷新页面后 Bash Tab output 为空（符合仅内存范围）

## 6. Worktree & Branch

- 分支：`feat/bash-repl-tab`，基于当前 `main`（避开 `feat/opencc-memory` / `feat/sse-state-push` 等进行中分支以减少冲突）
- worktree 路径：`/Users/ethan/code/opencc-web-feat-bash-repl-tab`（沿用项目惯例）
- spec 路径：`docs/superpowers/specs/2026-07-24-zai-bash-repl-tab-design.md`

## 7. Out of Scope (Future)

- ANSI 颜色解析（`ansi-to-react` 或自实现）
- Tab 补全（`/etc/bash_completion` 集成）
- Ctrl-C / Ctrl-L 快捷键
- 命令历史持久化（`~/.zai/repl/<sid>.log` 落盘 + 重连回放）
- 复用现有 BashTool 的 sandbox 限制（executor / maxCpuMs / networkEgress）
- 与 CwdStore 联动（写 pwd -P trailer 跟踪 cwd 变化）
- 与 `useAppStore.instanceContext.cwdName` 联动更新 status bar

这些列入未来 spec，本轮只交付最小可用 REPL。