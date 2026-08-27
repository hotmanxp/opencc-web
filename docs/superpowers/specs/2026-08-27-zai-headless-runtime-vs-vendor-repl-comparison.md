# zai headless runtime vs vendor REPL:能力对比与缺失盘点

日期:2026-08-27
状态:探索记录 / 设计输入(非定稿)

> 起源:`/Users/ethan/code/opencc-web` 当前 `update-pa` 分支,讨论"server 调用 agent-core 是否缺 REPL 运行环节"演化而来。本文一次性记录三段探索:
> 1. zai server → agent-core 调用链路 + REPL 是否被调用
> 2. `createOpenccRuntime` 与 vendor `REPL.tsx` 的全量能力对比
> 3. vendor 的 loop 循环机制(`/loop`、cron、proactive tick)底层原理
>
> 结论用于驱动后续 hooks 接入、resume 状态补齐、`OpenccRuntime` 契约扩展三类 spec 起草。

---

## 1. TL;DR

- **zai server 没有调用 vendor 的 `REPL.tsx` 交互组件**(由设计决定,非 bug)— 它通过 HTTP 接收 prompt,直接调 `runtime.query(input)`,由 `createOpenccRuntime` 的 headless runtime 包内 vendor 的 `QueryEngine.submitMessage`。
- **手动镜像了 vendor REPL 的若干生命周期职责**:`computeTools` per-turn refresh、resume hydration 反序列化、per-query AbortController、permission mode transition、SDK event → runtime primitive 翻译等;每次 vendor 改 REPL,这些镜像点都有同步压力(代码里多处 `zai patch` 注释明写"Mirror REPL.tsx")。
- **仍然缺失大量能力**:SessionStart/SessionEnd/UserPromptSubmit hooks 全层不调、resume 不恢复 file history/worktree/cost/plan/attribution、background session/swarm/mailbox/sandbox 整层无出口、30+ notification hook 不挂载、tool refresh 时机滞后一轮。
- **vendor 的"循环"机制**全是定时器 / 事件驱动,不是 while 循环:`/loop` 走 `cronScheduler.ts` 的 `setInterval(check, 1000)`(session cron tasks 存内存 Map),proactive tick 走 `useProactive` 的内部 timer,REPL 主驱动是 React render 周期 + `for await query()` 事件消费。
- **ZAI_OPENCC_CLI=1 双轨路径**(`SessionHostRuntimeAdapter` → spawn `opencc -p` 子进程)是拿 vendor 真 REPL 的官方逃生口,代价是 stdio NDJSON + control_request IPC 复杂度。

---

## 2. zai server → agent-core 调用链路

```
HTTP POST /api/agent/prompt
  → packages/zai/src/server/routes/agent.ts:1491 runQueryLoop(cmd)
    → runNextInQueue(cmd.sessionId)            // per-session 串行队列
      → runQueryLoop:
          ↓
          runtime.query(input)                  // OpenccRuntime 契约
            → packages/zn-agent-core/src/opencc-src/server/createOpenccRuntime-impl.ts:522
              → engine.submitMessage(input.prompt, ...)  // 每 session 一个 QueryEngine
                → vendor QueryEngine → defaultQuery → streamingToolExecutor
                  → queryModelWithStreaming → Anthropic API
              ↑ sdkEventAdapter 翻译 SDK Message → runtime.* 事件
            ↑ zai translateRuntimeEvents 翻译 → ServerEvent spec
          ↑ eventBus.emit → SSE /api/event
```

**`REPL.tsx` 在 zai server 中没有被 import**(已通过 grep 验证)— 整个 TUI 组件栈被绕开。`/agent/prompt` 走的是纯 headless path。

---

## 3. 顶层形态对比

| 维度 | vendor `REPL.tsx` (5366 行) | `createOpenccRuntime` (981 行 = types 177 + impl 804) |
|---|---|---|
| 类型 | React/Ink 交互组件 | 工厂函数,返回 8 方法契约的 plain object |
| 输入源 | TTY 终端键盘/粘贴/拖拽 + CLI args + 计划退出 | HTTP `/api/agent/prompt` body |
| 状态管理 | React state + Zustand AppState + Ref + 全局 bootstrap state | 模块级 Map(engines / queryAbortControllers)+ 全局 bootstrap state |
| 输出 | Ink 渲染 + 文件落盘 | AsyncIterable<ServerEvent> + 文件落盘 |
| 调用 query | `for await (const event of query({messages, systemPrompt, userContext, systemContext, canUseTool, toolUseContext, querySource}))` | `for await (const step of translateSdkToRuntime(stream.next()))` 包 vendor `engine.submitMessage` |
| Session 切换 | `resume()` 内置,完整 restore | 仅 `engines.get(sid)` 复用,无显式 resume API |
| 生命周期 hooks | processSessionStartHooks + executeSessionEndHooks **每轮都跑** | **没有**,zai 也没补 |
| Abort 粒度 | queryGuard 状态机 + AbortController per turn + generation token | per-session AbortController Map,但没有 queryGuard 状态机 |

**关键观察**:`createOpenccRuntime` 8 方法契约(query / abort / getSession / listSessions / readTranscript / patchSession / removeSession / shutdown + plugins)**本身不暴露** session lifecycle hook / swarm / background / proactive 等需要长生命周期状态的子模块。这是结构性上限,不是某处遗漏。

---

## 4. 全量能力差距盘点

### A. Session 生命周期

| REPL 能力 | 位置 | headless 镜像 |
|---|---|---|
| `processSessionStartHooks('resume'/'fork')` | REPL.tsx:1960, :1942 | **❌ 缺失** |
| `executeSessionEndHooks(...)` | REPL.tsx:1949, hooks.ts | **❌ 缺失** |
| SessionStart/SessionEnd/UserPromptSubmit hooks | hooks.ts | **❌ 缺失**(整层不调)|
| `/clear` / `clearConversation` | REPL 通过 commands + conversation.ts | **❌** — zai server 是 builtin 命令 `clear`,逻辑分开 |
| `/compact` / `partialCompactConversation` | REPL.tsx:182, :2985 | **⚠️ 间接** — 走 vendor QueryEngine → defaultQuery 自动路径 |
| MicroCompact 状态管理 | `resetMicrocompactState`, `runPostCompactCleanup` | **⚠️ 间接** — 全在 vendor QueryEngine 内部 |

### B. Resume / 状态恢复

createOpenccRuntime-impl.ts:577-625 只把 JSONL 反序列化灌回 `mutableMessages`,其他全部不补:

| 恢复项 | REPL 来源 | headless 镜像 |
|---|---|---|
| 反序列化 JSONL → messages | `deserializeMessages` | **✅** impl.ts:577-625 |
| 恢复 worktree session | `restoreWorktreeForResume` / `exitRestoredWorktree` | **❌ 缺失** |
| 恢复 file history 快照 | `copyFileHistoryForResume`, `restoreSessionStateFromLog` | **❌ 缺失** |
| 恢复 attribution / commitAttribution | `recordAttributionSnapshot` | **❌ 缺失** |
| 恢复 agent setting | `restoreAgentFromSession` | **❌ 缺失** |
| 恢复 plan slug | `copyPlanForResume` / `copyPlanForFork` | **❌ 缺失** |
| 恢复 content replacement state(超长 tool_result) | `reconstructContentReplacementState` | **❌ 缺失** |
| 恢复 cost state | `getStoredSessionCosts` / `setCostStateForRestore` | **❌ 缺失** |
| 恢复 standalone agent context | `computeStandaloneAgentContext` | **❌ 缺失** |
| 恢复 read file state | `restoreReadFileState` | **❌ 缺失** |
| Coordinator mode 切换警告 | `matchSessionMode` | **❌ 缺失** |

### C. Background / Swarm / Mailbox

| REPL 能力 | 镜像状态 |
|---|---|
| `useSessionBackgrounding` | **❌ 缺失** |
| `useSwarmInitialization` | **❌ 缺失** |
| `useInboxPoller`(后台 agent 通知轮询) | **❌ 缺失** — zai 靠 sessionInbox + BashNotifier 部分覆盖,协议不完整 |
| `useMailboxBridge` 跨会话邮箱 | **❌ 缺失** |
| `setMemberActive(teamName, agentName)` | **❌ 缺失** |
| `useTeammateViewAutoExit` | **❌ 缺失** |
| `isBgAgentRuntimeEnabled` 守卫 | **⚠️ 镜像** — zai 通过 `__zaiBridgeCtx` 桥接了一部分 |

### D. Command / Prompt 队列

| REPL 能力 | 镜像状态 |
|---|---|
| `useCommandQueue` 本地命令队列 | **❌ 缺失** |
| `useQueueProcessor` 队列消费 | **❌ 缺失** — zai 用自己的 sessionQueues (HTTP 驱动),语义不同 |
| `queuedCommands` priority 'now' 抢占 | **❌ 缺失** |
| Immediate commands(`/btw` 等) | **❌ 缺失** |
| `handleIncomingPrompt`(被 inbox/bridge 调) | **❌ 缺失** |
| `userInputOnProcessing` 占位提示 | **❌ 缺失** |
| Speculation accept | **❌ 缺失** |

### E. UI / 对话框 / 通知

| REPL 能力 | 镜像状态 |
|---|---|
| `toolJSX` / `setToolJSX` 内嵌对话框 | **❌ 缺失** — `/plugin` `/config` 等需内嵌 UI 的命令 zai server 走 web 路由 |
| Local JSX command 机制 | **❌ 缺失** |
| 30+ notification hooks(rate limit / deprecation / plugin auto-update / MCP / LSP) | **❌ 缺失** — 用户感知不到 |
| AnimatedTerminalTitle / OSC 21337 / tab status | **❌**(non-TTY) |
| Buddy(CompanionSprite) | **❌ 缺失** |
| Voice integration | **❌ 缺失**(gated) |

### F. Permission / Tool 协调

| REPL 能力 | 镜像状态 |
|---|---|
| `toolUseConfirmQueue` 工具确认队列 | **⚠️ 部分** — zai 用 PermissionRegistry 替换,形态不同 |
| `promptQueue` / PromptDialog | **⚠️ 部分** — zai 用 AskRegistry 替换 |
| `permissionStickyFooter` / ExitPlanMode UI | **⚠️ 部分** — 走 headlessPermissionBridge + /api/agent/permission-response |
| `pendingWorkerRequest` / `pendingSandboxRequest` | **❌ 缺失** |
| `sandboxPermissionRequestQueue` / SandboxManager | **❌ 缺失** — 无 sandbox 集成 |
| `useKickOffCheckAndDisableBypassPermissionsIfNeeded` | **❌ 缺失** |
| `useKickOffCheckAndDisableAutoModeIfNeeded` | **❌ 缺失** |
| `applyPermissionUpdate` / `persistPermissionUpdate` | **❌ 缺失** — zai 改模式只能改 transcript meta,不写全局 permission store |
| Auto-mode dangerous rule stripping | **❌ 缺失** |
| `workerSandboxPermissions` 状态 | **❌ 缺失** |
| `setToolPermissionContext` 领导注册 | **❌ 缺失** |

### G. MCP / Plugin / Skill / Tool

| REPL 能力 | 镜像状态 |
|---|---|
| 每轮 `computeTools` refresh(built-ins + MCP + 权限过滤) | **⚠️ 部分** — 镜像成 `computeTools` callback(createOpenccRuntime-impl.ts:105-110),但 vendor 触发点在 `defaultQuery` 开始时,**不是每轮 prompt 提交前**,plugin 中途 enable 当轮 query 看不到 |
| `refreshActivePlugins` / `useManagePlugins` 自动 reload 监听 | **⚠️ 部分** — zai 提供 plugin API,但无自动 reload |
| `useSkillsChange`(skill 文件 hot-reload) | **❌ 缺失** — zai 自己的 commands/registry 启动时一次性加载 |
| `useMergedTools` / `useMergedCommands` / `useMergedClients` | **❌ 缺失** |
| `dynamicMcpConfig` per-session override | **❌ 缺失** |
| `useMcpConnectivityStatus` | **❌ 缺失** |
| `useLspPluginRecommendation` / `useLspInitializationNotification` | **❌ 缺失** |
| `useClaudeCodeHintRecommendation` | **❌ 缺失** |
| `usePluginAutoupdateNotification` | **❌ 缺失** |

### H. 集成 / Transport

| REPL 能力 | 镜像状态 |
|---|---|
| `useSSHSession` | **❌ 缺失** |
| `useRemoteSession` / `useDirectConnect` | **❌ 缺失** |
| `useIDEIntegration` / `closeOpenDiffs` | **❌ 缺失** |
| `getConnectedIdeClient` | **❌ 缺失** |
| `useVoiceIntegration` | **❌ 缺失** |

### I. Proactive / Scheduled / Loop

| REPL 能力 | 镜像状态 |
|---|---|
| `useScheduledTasks`(cron + /loop) | **❌ 缺失** |
| `useProactive`(自动 tick) | **❌ 缺失** |
| `useTaskListWatcher`(内部) | **❌ 缺失** |

### J. 状态 / 性能 / 诊断

| REPL 能力 | 镜像状态 |
|---|---|
| `queryGuard` 状态机 + generation | **❌ 缺失** — zai 用 `sessionRunning` Set,但无 generation token 防 stale finally |
| `diagnosticTracker` | **❌ 缺失** |
| `queryProfiler` / `queryCheckpoint` | **❌ 缺失** |
| `QueryLifecycleOperationTracker` | **❌ 缺失** |
| `apiMetricsRef` + OTPS 统计 + 内部告警 | **❌ 缺失** |
| `startBackgroundHousekeeping` | **❌ 缺失** |
| `registerPrunableCache` | **❌ 缺失** |
| `startPreventSleep` / `stopPreventSleep` | **❌**(non-TTY) |

### K. 标题 / Session 元数据

| REPL 能力 | 镜像状态 |
|---|---|
| `generateSessionTitle`(Haiku 抽标题) | **❌ 缺失** — zai 用 `deriveTitleFromPrompt` 取首行(更简单) |
| Terminal title(animation / rename) | **❌** |
| `clearSessionMetadata` / `restoreSessionMetadata` | **⚠️ 部分** — zai 提供 patchSession 但只能改 title/tags |
| `saveWorktreeState` / `notifySessionMetadataChanged` | **❌ 缺失** |
| `updateSessionName` / `updateSessionActivity` | **❌ 缺失** |

### L. 文件 / Worktree / Cost

| REPL 能力 | 镜像状态 |
|---|---|
| `fileHistoryMakeSnapshot` / `fileHistoryRewind` | **❌ 缺失** — zai server 没实现 `/rewind` |
| `saveCurrentSessionCosts` / `getStoredSessionCosts` | **❌ 缺失** |
| `claude.md` hot-reload | **⚠️ 部分** — zai server 有 `startMemoryWatcher`,但 hot-reload 没接到 computeTools |
| `getMemoryFiles` | **⚠️ 部分** — zai 通过 vendor getSystemContext 走 |

### M. 其他 vendor 独有

| 能力 | 镜像状态 |
|---|---|
| `processInitialMessage`(plan 模式退出后清空) | **❌ 缺失** |
| `/btw` 立即命令 | **❌ 缺失** |
| `teammateStatusBox` / `teammateViewAutoExit` | **❌ 缺失** |
| `TungstenLiveMonitor` / `AntModelSwitchCallout` / `UndercoverAutoCallout`(内部构建 gated) | **❌** |
| `asciicast` 录制 | **❌ 缺失** |
| `suspend` / `resume` SIGTSTP | **❌**(non-TTY) |
| `dumpMode`(`[` 强 dump scrollback) | **❌** |
| `CostThresholdDialog` / `IdleReturnDialog` | **❌** |
| `SkillImprovementSurvey` / `useSkillImprovementSurvey` | **❌ 缺失** |
| `useFeedbackSurvey` / `useMemorySurvey` / `usePostCompactSurvey` | **❌ 缺失** |

### 已经在 headless runtime 镜像的(✅ / ⚠️)

| 能力 | REPL 来源 | headless 镜像位置 |
|---|---|---|
| 主循环入口 | `for await (const event of query(...))` | `for await (const step of stream.next())` 包 `engine.submitMessage` (impl.ts:666-741) |
| Per-query AbortController | print.ts:2282 | impl.ts:561-565 |
| Resume hydration 反序列化 | `useState(initialMessages)` + deserializeMessages | impl.ts:569-627 |
| Per-turn tool refresh | REPL 的 computeTools | impl.ts:105-110, :201-202 |
| Permission mode transition | `transitionPermissionMode` | impl.ts:525-549 |
| 主 Agent slots | AppState 一次性装配 | `createEngine(initialMessages, mainAgentName)` per-session,impl.ts:197-249 |
| Session CRUD | sessionStorage | getSession / listSessions / readTranscript / patchSession / removeSession (impl.ts:765-787) |
| Plugin API | useManagePlugins | plugins 对象 (impl.ts:400-512) |
| SDK event → runtime primitives 翻译 | vendor sdkEventAdapter | compat/runtime/sdkEventAdapter.ts(impl.ts:712-741) |
| Session-injected globalThis bridge | AppState 在 query 上下文 | impl.ts:638-642 + agentRuntime.ts:96-128(`__zaiBridgeCtx`) |

---

## 5. vendor 的 loop 循环机制

**REPL 本身没有显式的 `while (true)` 循环作为主驱动**,所有"周期性"行为外包给定时器 / 事件驱动。

### 5.1 REPL 组件级生命周期

`REPL` 组件每个 session 挂载一次,存活到 session 切换或 unmount。**所有"再次提问"的能力都靠 React state 重渲染**,不是循环:

- mount 一次 → `useEffect(onInit, [])` 启动初始化
- 中途**不重 mount**,用户连续提交 100 条 prompt,REPL 仍是同一个实例
- `suspend/resume`(SIGTSTP)在 REPL.tsx:4468-4484 触发 `setRemountKey(prev => prev + 1)` 强制整棵子树替换,但仍是 React 触发,不是循环

### 5.2 提问驱动的核心管道(REPL.tsx:3109-3314 onQuery)

每条 prompt 走 **onSubmit → onQuery → onQueryImpl**,没有循环:

```
[user types input + Enter]
   ↓ handlePromptSubmit / setInputValue
onSubmit(input) — REPL.tsx:3432
   ↓ setMessages([...prev, userMsg])
   ↓ enqueue / queue processor drain
onQuery(newMessages, abortController, ...) — REPL.tsx:3109
   ├─ queryGuard.tryStart() — 状态机原子进入 running
   ├─ resetTimingRefs / resetCurrentTurn / reset cache metrics
   ├─ setMessages(oldMessages => [...oldMessages, ...newMessages])
   ├─ mrOnBeforeQuery / onBeforeQueryCallback 钩子
   ↓
onQueryImpl — REPL.tsx:2915
   ├─ diagnosticTracker.handleQueryStart / closeOpenDiffs
   ├─ setAlwaysAllowRules (slash-command-scoped tools)
   ├─ getToolUseContext (fresh tools/mcpClients from store)
   ├─ checkAndDisableBypassPermissions / checkAndDisableAutoMode
   ├─ getSystemPrompt / getUserContext / getSystemContext 并发加载
   ├─ buildEffectiveSystemPrompt 拼装 system prompt
   ↓
   for await (const event of query({   ← 唯一真正的"循环",但只在 query 期间存在
     messages, systemPrompt, userContext, systemContext,
     canUseTool, toolUseContext, querySource
   })) {
     onQueryEvent(event)
   }
   ↓ finally: queryGuard.end(gen)
   ├─ resetLoadingState
   ├─ onTurnComplete (zai 镜像成 runNextInQueue 触发下一条)
   └─ sendBridgeResult (mobile bridge)
```

**关键的"循环"是 vendor `query()`(query.ts:1312 起的 `for await (const event of ...)`)**,它内部驱动 LLM tool loop(streamingToolExecutor),一轮 turn 内可能有 N 轮 model → tool → model 的迭代。但 REPL **外层没有循环**,每个 turn 一次性 await 完。

### 5.3 跨 turn 串行:`onTurnComplete` 钩子

REPL.tsx:3190、3107:

```typescript
finally {
  resetLoadingState()
  await mrOnTurnComplete(messagesRef.current, abortController.signal.aborted)
  sendBridgeResultRef.current()
}
```

`onTurnComplete` 是 `mrOnTurnComplete`(mergeRemote / 兼容层包装),zai server **镜像**了这一点:

- `packages/zai/src/server/routes/agent.ts:1491-1597` 的 `runNextInQueue` 在 `runQueryLoop` finally 里调 `void runNextInQueue(sessionId)`
- 这是 zai server 把"REPL 的 onTurnComplete"翻译成"session 队列下一条 prompt"的桥

但 vendor 自己的 `onTurnComplete` **不做**循环启动下一条 — 用户必须**自己手动输入**才会触发下一轮。zai 是显式把队列机制接上。

### 5.4 `/loop` 命令(cron-based 周期循环)

REPL.tsx:4399-4405 的注释明确:"Scheduled tasks from .claude/scheduled_tasks.json (CronCreate/Delete/List) and session-only /loop runs." — **`/loop` 和 cron 走同一个 cronScheduler**。

```
/loop 5m "check builds"          ← 用户输入
   ↓ createLoopCommand           ← skills/bundled/loop.ts
   ↓ addSessionCronTask({       ← bootstrap/state.ts session cron store (durable:false)
       cron: '*/5 * * * *',
       prompt: 'check builds',
       recurring: true,
       permanent: false
     })
   ↓
useScheduledTasks(REPL.tsx:4401) 挂载 cronScheduler
   ↓ createCronScheduler({ onFireTask, isLoading, ... })  ← utils/cronScheduler.ts:142
   ↓ scheduler.start()
   ↓
check() 每秒 tick (utils/cronScheduler.ts:230):
   ├─ isKilled?.() → return (killswitch 守卫 GrowthBook tengu_kairos_cron)
   ├─ isLoading() && !assistantMode → return (turn 期间不发)
   ├─ 遍历 process(t, isSession=false):
   │    ├─ nextFireAt 未设 → 从 lastFiredAt ?? createdAt 锚定
   │    ├─ now < next → return
   │    ├─ onFireTask(task) → enqueuePendingNotification({ value: task.prompt, priority: 'later', isMeta: true })
   │    ├─ recurring && !aged → nextFireAt.set(t.id, jitteredNextCronRunMs(...))
   │    └─ 一次性 task → removeCronTasks (inFlight Set 防双发)
   ↓
enqueuePendingNotification → messageQueueManager.ts
   ↓
useCommandQueue / useQueueProcessor 消费 — REPL.tsx:662, :4242
   ↓ turn 结束 → drain → handleIncomingPrompt → onSubmit(...)
```

**核心常量**(utils/cronScheduler.ts:40-44):
- `CHECK_INTERVAL_MS = 1000` — 每秒扫一遍
- `FILE_STABILITY_MS = 300` — chokidar 文件稳定检测
- `LOCK_PROBE_INTERVAL_MS = 5000` — 非 owning session 探锁间隔

**双层防双发**:
- `tryAcquireSchedulerLock` + chokidar reload(cwd 级,防止两个 OpenCC 实例同时跑同一份 scheduled_tasks.json)
- `inFlight: Set<string>` + `markCronTasksFired`(task 级,防 chokidar reload 期间重入)

**任务过期**:`recurringMaxAgeMs` 默认自动过期时间,aging-out 的 recurring task 最后一轮 fire 后从文件删除(`isRecurringTaskAged` at cronScheduler.ts:53)。

**错过任务补跑**:`findMissedTasks()` 在初始 load 时跑一次,只补一次性的(让用户决定 run-now / discard),recurring 不补(让 check() 自己 anchor 上)。

### 5.5 Proactive 自动 tick(与 /loop 平行)

`useProactive`(REPL.tsx:4424)— 另一条独立通路:

```typescript
useProactive?.({
  isLoading: isLoading || initialMessage !== null,
  queuedCommandsLength: queuedCommands.length,
  hasActiveLocalJsxUI: isShowingLocalJSXCommand,
  isInPlanMode: toolPermissionContext.mode === 'plan',
  onSubmitTick: (prompt: string) => handleIncomingPrompt(prompt, { isMeta: true }),
  onQueueTick: (prompt: string) => enqueue({ mode: 'prompt', value: prompt, isMeta: true })
})
```

- 由 GrowthBook `kairosEnabled` 门控
- 触发的是 /job 命令或内部定时任务(内部构建 gated,外部构建整段死代码消除)
- `onSubmitTick` 立即调 `handleIncomingPrompt` → `onSubmit`(插队)
- `onQueueTick` 入队等 turn 结束

**与 /loop 区别**:`/loop` 是"用户设了间隔循环提 prompt",proactive 是"用户不在场也自动提 prompt"。两条通路独立但都通过 `enqueuePendingNotification` / `handleIncomingPrompt` 落进同一个 queue。

### 5.6 命令队列消费(不是循环)

`useCommandQueue`(REPL.tsx:662)+ `useQueueProcessor`(REPL.tsx:4242)+ `messageQueueManager.ts`:

- 用户输入 / 后台 push / cron 触发 → 都走 `enqueue(...)` → module-level `getCommandQueue()` 数组
- `useQueueProcessor` 注册一个 `onTurnEnd` 钩子(每轮结束后被 queryGuard.end 触发),drain 队列里 priority 合适的条目
- 没有循环,是**事件 + drain**

### 5.7 zai server 这边的镜像情况

| vendor 机制 | zai 镜像状态 |
|---|---|
| REPL 组件生命周期 | **不挂** — server 是 stateless over HTTP,前端持会话 |
| `onSubmit → onQuery → onQueryImpl` | **✅ 镜像** — `runNextInQueue` + `runQueryLoop` (routes/agent.ts:801-1489) |
| `queryGuard` 状态机 | **⚠️ 部分** — `sessionRunning` Set + `sessionControllers` Map,但无 generation token 防 stale finally |
| `for await (const event of query())` | **✅ 镜像** — `for await (const step of stream.next())` (createOpenccRuntime-impl.ts:729-741) |
| `onTurnComplete` | **✅ 镜像** — `runNextInQueue(sessionId)` 在 `runQueryLoop` finally |
| `useScheduledTasks` / cronScheduler | **❌ 不镜像** — server 没挂 cronScheduler,`/loop` 命令在 zai builtin commands 里没实现 |
| `useProactive` | **❌ 不镜像** — server 不知道 proactive tick |
| `useCommandQueue` / `useQueueProcessor` | **⚠️ 部分** — zai 自己有 `sessionQueues` + `runNextInQueue`,但语义不同(只接 HTTP) |
| `useInboxPoller` / `useMailboxBridge` | **❌ 不镜像** — zai 靠 `sessionInbox` + `BashNotifier` 部分覆盖 inbox 协议 |
| `useSessionBackgrounding` | **❌ 不镜像** — 后台 session 整层没接 |

---

## 6. 风险摘要

按严重性排序:

### 严重(用户能直接感知)

1. **Hooks 系统整层空跑** — 用户在 `.claude/settings.json` / vendor settings 配的所有 PreToolUse / PostToolUse / SessionStart / UserPromptSubmit hooks **全部失活**。vendor 重要的扩展点,headless runtime 完全没调。**zai 用户的 hooks 配置 100% 无效**。
2. **Resume 只回 messages,不回"运行上下文"** — file history / worktree / cost / plan / attribution / read file state 全部不恢复。模型看得到历史文字,但文件快照回退 / worktree 切换 / cost 累计 / plan slug 全部丢失。
3. **Tool refresh 时机不对** — REPL 在每轮 prompt submit **之前** 重新 assemble tools + commands + MCP(`useManageMCPConnections` 异步 flush)。createOpenccRuntime 把 `refreshTools` 传给 vendor QueryEngine,但 vendor 触发点是 `defaultQuery` 开始时(query.ts "Refresh tools between turns"),**不是每轮 prompt 提交前**。zai 用户中途 enable 一个 plugin,当轮 query 看不见,要等下一轮才会刷新。

### 中等(影响具体功能)

4. **Permission 协议 mismatch** — REPL 在前端跑 ToolUseConfirm / PermissionRequest / AskUserQuestion / ElicitationDialog 一整套 TUI 对话框,内部协议是 `tool_use:ask_pending` / `tool_use:permission_pending` 等。zai 靠 compat 层把这套协议翻译到 web,但只有 askRegistry + permissionRegistry 两路,**sandbox / worker / elicitation / local JSX commands 全部没出口**。
5. **Background / Swarm / Mailbox 三件套没接** — vendor 的 BackgroundAgent / TaskTool / teammate 系统靠 mailbox 协议 + background daemon 通信,REPL 通过 useInboxPoller + useMailboxBridge + useSessionBackgrounding + useSwarmInitialization 接住。zai server 只手动桥接了一小部分(`__zaiSessionInbox.followup/inject`),BG agent 完成通知、teammate 权限同步、team 初始化整套缺失。
6. **30+ notification hook 不挂载** — rate limit / plugin auto-update / LSP / Chrome extension / 内部 telemetry / API migration / feedback survey / memory survey / post-compact survey / model switch 全没镜像。zai 用户感知不到这些状态变化。

### 结构性(契约上限)

7. **8 方法契约的设计上限** — query / abort / getSession / listSessions / readTranscript / patchSession / removeSession / shutdown + plugins 这套契约,本质是把 vendor CLI 当 RPC 服务,**不暴露** session lifecycle hook / swarm / background / proactive 这类需要长生命周期状态的子模块。如果要把它们都装上,8 方法契约需要扩到至少 15-20 个,且 query 输入需要支持 `effort` / `hooks` / `dynamicMcpConfig` / `proactiveTick` / `scheduledTick` / `mailboxReply` 等。

---

## 7. 修复路径

### 路径 A:补齐 hooks 接入(改动小,覆盖最大盲区)

**目标**:让用户配的 SessionStart / SessionEnd / UserPromptSubmit / PreToolUse / PostToolUse hooks 在 headless runtime 上生效。

**改动点**:
1. `createOpenccRuntime-impl.ts:522` query 入口(`engine.submitMessage` 之前)调 `await processSessionStartHooks('query', { sessionId, agentType, model })`,把返回的 hookMessages 注入 messages。
2. query 出口(`finally` 块)调 `await executeSessionEndHooks('query', ...)`。
3. `removeSession` 路径(impl.ts:783)调 `await executeSessionEndHooks('remove', ...)`。
4. `readTranscript` 后的 user message 提交(由 zai server 的 `appendUserMessageV2` 路径)前调 UserPromptSubmit hooks。
5. vendor 的 tool 执行层(`toolExecution.ts`)已经在调 PreToolUse / PostToolUse hooks,无需 headless 镜像,但需要确认 `toolUseContext.canUseTool` 在 headless 路径传对(目前是 `ctx.permission`)。

**风险**:SessionStart hook 可能阻塞 query 入口;兼容 vendor 的 hook 协议(参数 schema);ErrorModel vs block 行为差异。

### 路径 B:补齐 resume 状态恢复

**改动点**:`createOpenccRuntime-impl.ts:577-625` 的 hydration 路径(目前只灌 `mutableMessages`)扩为完整 restore:
- worktree session:从 JSONL 的 `meta.worktreeSession` 恢复
- file history snapshots:从 JSONL 的 `fileHistorySnapshots` 段恢复
- attribution snapshot:从 JSONL 的 `attribution-snapshot` 段恢复
- plan slug:从 JSONL 的 `meta.plan` 恢复
- cost state:从 disk `cost-tracker.json` 读
- coordinator mode 警告:沿用 vendor 的 `matchSessionMode`

**风险**:与 vendor CLI 共享同一份 JSONL 时的 race condition;`setState(prev => ...)` 路径在 vendor 上下文里需要 `runWithSdkContext` 包裹。

### 路径 C:扩展 OpenccRuntime 契约(治本)

**目标**:8 方法 → 15-20 方法,暴露 hooks / swarm / background / proactive 子模块。

**候选新方法**:
- `onSessionLifecycle(event: 'start'|'end'|'abort', cb): unsubscribe` — 注册 session 边界回调
- `dispatchMailbox(message: MailboxMessage): Promise<void>` — 跨会话邮箱写
- `attachBackgroundSession(taskId, options): BackgroundHandle` — 后台 session 句柄
- `registerProactiveTick(cb: (budget) => void): unsubscribe` — 周期性 tick
- `setDynamicMcpConfig(config: Record<string, ScopedMcpServerConfig>): void` — per-session MCP override
- `refreshToolsNow(): Promise<Tool[]>` — 立即重算工具池(给 plugin 中途 enable 用)
- `triggerPermissionCheck(toolUse, input): Promise<PermissionDecision>` — 同步权限检查(给 batch tool call 用)

**兼容性策略**:
- 新方法做 optional(`OpenccRuntimeV2 extends OpenccRuntime`),旧调用方无感
- zai server 自己的 `OpenccRuntime` 类型扩为 `OpenccRuntimeV2`
- 8 方法契约冻结(已发布的 dist/opencc-core.mjs 行为不能改),新方法在新版本里加

### 路径 D:维持现状,继续手工镜像

zai 当前的状态。每次 vendor 改 REPL,识别需要镜像的点,在 impl.ts 里打 `zai patch` 注释同步。维护负担持续,但不破坏稳定性。

---

## 8. 附录:关键文件位置

| 主题 | 路径 |
|---|---|
| zai server agent 入口 | `packages/zai/src/server/routes/agent.ts:1491` (`runQueryLoop`) |
| zai per-session queue | `packages/zai/src/server/routes/agent.ts:801-1597` (`runNextInQueue` + `sessionQueues`) |
| zai agentRuntime 模块 | `packages/zai/src/server/services/agentRuntime.ts` |
| zai eventBus → SSE | `packages/zai/src/server/services/eventBus.ts` |
| OpenccRuntime 类型契约 | `packages/zn-agent-core/src/opencc-src/server/serverTypes.ts:274-294` |
| OpenccRuntime 实现 | `packages/zn-agent-core/src/opencc-src/server/createOpenccRuntime-impl.ts` |
| vendor REPL 入口 | `packages/zn-agent-core/src/opencc-src/screens/REPL.tsx:615` |
| vendor query 入口 | `packages/zn-agent-core/src/opencc-src/query.ts:1312`(for-await loop)|
| vendor QueryEngine | `packages/zn-agent-core/src/opencc-src/server/QueryEngine.ts` |
| vendor cronScheduler | `packages/zn-agent-core/src/opencc-src/utils/cronScheduler.ts` |
| vendor sessionRestore | `packages/zn-agent-core/src/opencc-src/utils/sessionRestore.ts` |
| vendor hooks 系统 | `packages/zn-agent-core/src/opencc-src/utils/hooks.ts` |
| zai SessionHost 子进程路径 | `packages/zai/src/server/services/sessionHost/SessionRegistry.ts` |
| zai 双轨开关 | `packages/zai/src/server/services/agentRuntime.ts:471-488` |

## 9. 后续 Spec 建议

按优先级:

1. **Hooks 接入 spec** — 路径 A 的具体改动方案 + 兼容性 + 测试矩阵
2. **Resume 状态补齐 spec** — 路径 B 的字段清单 + 错误兜底 + race 处理
3. **OpenccRuntime V2 契约扩展 spec** — 路径 C 的 API 草案 + 迁移策略
4. **Loop / Cron 在 zai server 的镜像 spec** — `/loop` 接入 + cronScheduler 复用 + proactive tick 协议
5. **Tool Refresh 时机修正** — 把 computeTools refresh 提到 query 入口之前(独立小改动)
