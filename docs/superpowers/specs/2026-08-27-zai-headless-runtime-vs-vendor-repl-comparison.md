# zai headless runtime vs vendor REPL:能力对比与缺失盘点

日期:2026-08-27
状态:探索记录 / 设计输入(非定稿)
> 2026-08-27 代码复核:逐条核验通过,已修正调用链行号(runQueryLoop 实际在 agent.ts:908)、tool refresh 过时论断(QueryEngine.ts:288-295 zai patch 已修复)、QueryEngine/worktree 文件路径、`/loop` 入口符号名、query.ts 行号等 7 处。
> 2026-08-27 二次复核:① UserPromptSubmit / PreToolUse / PostToolUse hooks 实际已生效(QueryEngine.submitMessage → processUserInput 内部触发),失活范围缩小为 SessionStart / SessionEnd;② 新增 §5.8 vendor print.ts 覆盖度对比——print.ts 才是"完整 headless REPL 循环",需要完整循环应优先走双轨路径 A。

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
- **仍然缺失大量能力**:SessionStart/SessionEnd hooks 不调、resume 不恢复 file history/worktree/cost/plan/attribution、background session/swarm/mailbox/sandbox 整层无出口、30+ notification hook 不挂载。(注1:tool refresh 时机滞后问题已由 `QueryEngine.ts:288-295` zai patch 在 `submitMessage` 入口修复。注2:UserPromptSubmit / PreToolUse / PostToolUse hooks 其实**已生效**——UserPromptSubmit 在 `QueryEngine.submitMessage` → `processUserInput`(processUserInput.ts:178-195)内部触发,Pre/PostToolUse 在 `toolExecution.ts` 触发,均无需外壳镜像。)
- **vendor 的"循环"机制**全是定时器 / 事件驱动,不是 while 循环:`/loop` 走 `cronScheduler.ts` 的 `setInterval(check, 1000)`(session cron tasks 存内存 Map),proactive tick 走 `useProactive` 的内部 timer,REPL 主驱动是 React render 周期 + `for await query()` 事件消费。
- **ZAI_OPENCC_CLI=1 双轨路径**(`SessionHostRuntimeAdapter` → spawn `opencc -p` 子进程)是拿 vendor 真 REPL 的官方逃生口,代价是 stdio NDJSON + control_request IPC 复杂度。

---

## 2. zai server → agent-core 调用链路

```
HTTP POST /api/agent/prompt
  → packages/zai/src/server/routes/agent.ts:1491 router.post('/agent/prompt')
    → agent.ts:801 runNextInQueue(sessionId)       // per-session 串行队列 + 串行守卫
      → agent.ts:908 runQueryLoop(cmd):
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
| SessionStart/SessionEnd hooks | hooks.ts | **❌ 缺失**(外壳层不调)|
| UserPromptSubmit hooks | processUserInput.ts:178-195 | **✅ 已生效** — `QueryEngine.submitMessage`(:225)内部 :494 调 `processUserInput`,自动触发 |
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
| 每轮 `computeTools` refresh(built-ins + MCP + 权限过滤) | **✅ 已镜像** — 镜像成 `computeTools` callback(createOpenccRuntime-impl.ts:105-110),且 `QueryEngine.ts:288-295` zai patch 在 `submitMessage` 入口(每轮 prompt 提交前)调 `refreshTools()`,注释明写 "mirroring the REPL's computeTools-per-query";query.ts:2741 的 "Refresh tools between turns" 是 vendor 原生第二触发点 |
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

**关键的"循环"是 vendor `query()`(query.ts:501 生成器入口,model 流式 `for await` 在 :1271 起)**,它内部驱动 LLM tool loop(streamingToolExecutor),一轮 turn 内可能有 N 轮 model → tool → model 的迭代。但 REPL **外层没有循环**,每个 turn 一次性 await 完。

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

- `packages/zai/src/server/routes/agent.ts:836` 的 `runNextInQueue` 在 **`runNextInQueue` 自己的 finally**(`runQueryLoop` 在 :908,由其调用)里调 `void runNextInQueue(sessionId)`
- 这是 zai server 把"REPL 的 onTurnComplete"翻译成"session 队列下一条 prompt"的桥

但 vendor 自己的 `onTurnComplete` **不做**循环启动下一条 — 用户必须**自己手动输入**才会触发下一轮。zai 是显式把队列机制接上。

### 5.4 `/loop` 命令(cron-based 周期循环)

REPL.tsx:4399-4405 的注释明确:"Scheduled tasks from .claude/scheduled_tasks.json (CronCreate/Delete/List) and session-only /loop runs." — **`/loop` 和 cron 走同一个 cronScheduler**。

```
/loop 5m "check builds"          ← 用户输入
   ↓ registerLoopSkill           ← skills/bundled/loop.ts:204
   ↓ CronCreate → addSessionCronTask({  ← utils/cronTasks.ts:212;bootstrap/state.ts session cron store (durable:false)
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
| `onSubmit → onQuery → onQueryImpl` | **✅ 镜像** — `runNextInQueue` + `runQueryLoop` (routes/agent.ts:801 / :908) |
| `queryGuard` 状态机 | **⚠️ 部分** — `sessionRunning` Set + `sessionControllers` Map,但无 generation token 防 stale finally |
| `for await (const event of query())` | **✅ 镜像** — `for await (const step of stream.next())` (createOpenccRuntime-impl.ts:729-741) |
| `onTurnComplete` | **✅ 镜像** — `runNextInQueue(sessionId)` 在 `runQueryLoop` finally |
| `useScheduledTasks` / cronScheduler | **❌ 不镜像** — server 没挂 cronScheduler,`/loop` 命令在 zai builtin commands 里没实现 |
| `useProactive` | **❌ 不镜像** — server 不知道 proactive tick |
| `useCommandQueue` / `useQueueProcessor` | **⚠️ 部分** — zai 自己有 `sessionQueues` + `runNextInQueue`,但语义不同(只接 HTTP) |
| `useInboxPoller` / `useMailboxBridge` | **❌ 不镜像** — zai 靠 `sessionInbox` + `BashNotifier` 部分覆盖 inbox 协议 |
| `useSessionBackgrounding` | **❌ 不镜像** — 后台 session 整层没接 |

---

## 5.8 vendor print.ts(`-p` / SDK headless)覆盖度对比 — "完整 REPL session 循环"的答案

**核心发现**:`cli/print.ts` 有 **5771 行**(比 REPL.tsx 的 5366 行还大),它不是简化 headless,而是把 REPL 外壳职责**全部命令式重实现**了一遍。`createOpenccRuntime`(804 行)相对 REPL 缺的外壳能力,print.ts 几乎全有;而 print.ts 与 `createOpenccRuntime` 用的是**同一个核心**(`QueryEngine` / `ask()`,print.ts:93/:2297)。

| 能力 | print.ts 覆盖 | 证据(print.ts 行号) |
|---|---|---|
| SessionStart hooks | ✅ `processSessionStartHooks('startup')` | :5255, :5372 |
| SessionEnd hooks | ✅ 经 `gracefulShutdown.ts:431/:504` 统一触发 | import :106 |
| Resume 完整恢复 | ✅ `loadConversationForResume` + `restoreSessionStateFromLog` + `restoreAgentFromSession` + `restoreSessionMetadata`(含 worktreeSession)+ content replacements + `matchSessionMode` 警告 + `saveMode` | :5063/:5237, :5119/:5334, :756, :5121-5127, :5109-5114, :5070/:5286 |
| file history rewind | ✅ `--rewind-files` + `fileHistoryRewind` | :784-818, :4677-4705 |
| cron `/loop` | ✅ `createCronScheduler`,注释明写 "Mirrors REPL's useScheduledTasks hook"(enqueue + `void run()` kick) | :2850-2880 |
| proactive tick | ✅ `proactiveModule` 空队列注入 + SDK 控制 `set_proactive` | :373/:2631/:4028-4040 |
| inbox / teammate / swarm | ✅ 注释 "mirrors what useInboxPoller does" + teammateMailbox + UDS inbox 回调 kick run() + team shutdown | :2654-2838, :354-360 |
| 命令队列主循环 | ✅ `while ((command = dequeue(...)))` + 批量合并 + run() mutex(替代 queryGuard) | :2084-2101 |
| sandbox | ✅ `SandboxManager` + failIfUnavailable 守卫 | :631-644 |
| elicitation | ✅ hook 先跑,未命中转发 SDK control_request | :1407-1458 |
| Haiku 标题生成 | ✅ `generateSessionTitle` | :3949 |
| hook 事件流外发 | ✅ hook_started / hook_progress / hook_response 推 SDK | :667-693 |
| 双向流式输入 | ✅ `runHeadlessStreaming` + SdkControlClientTransport | :925 |

**print.ts 也不覆盖的**(与 zai 同缺,REPL 独有):cost state 恢复(`getStoredSessionCosts` 0 命中)、`copyPlanForResume`(0 命中)、`applyPermissionUpdate` / `persistPermissionUpdate`(0 命中)、30+ React 通知 hooks(部分改经 `executeNotificationHooks` :244 + SDK 事件)、queryGuard generation(用 `running` 布尔 + mutex 替代)。

**含义**:若要"完整 REPL session 循环",自建 createOpenccRuntime 外壳等价于重写 print.ts(约 2000-3000 行非 UI 逻辑)。三条路径:

| 路径 | 做法 | 代价 | 评价 |
|---|---|---|---|
| **A. 启用双轨(短期推荐)** | `ZAI_OPENCC_CLI=1` → `SessionRegistry` spawn `opencc -p --input-format stream-json --output-format stream-json`(cliSpawn.ts:49-53 已就位),print.ts 全循环原样获得 | 需把 zai HTTP/SSE 协议对齐 SDK stream-json + control_request(权限 / elicitation / interrupt / set_proactive) | 最完整,零重复实现 |
| B. 移植 print.ts 外壳进 createOpenccRuntime | 镜像队列循环 / resume / cron / inbox 等 | 双份实现,vendor 每次改 print.ts 都产生同步压力 | 不推荐 |
| C. 抽共享 HeadlessSessionEngine | 把 print.ts 的 `run()` 循环重构为可 import 引擎,createOpenccRuntime 变薄壳 | vendor 重构成本高 | 治本,长期方向 |

> §7 路径 C 的候选方法(`dispatchMailbox` / `registerProactiveTick` / `onSessionLifecycle` / cron 接入)本质都是 print.ts 已有逻辑——扩契约自建即"重写 print"。

---

## 6. 风险摘要

按严重性排序:

### 严重(用户能直接感知)

1. **Session 级 hooks 不调** — 用户在 `.claude/settings.json` / vendor settings 配的 **SessionStart / SessionEnd** hooks 在 headless 外壳层没调。**注意(2026-08-27 二复核)**:UserPromptSubmit 在 `QueryEngine.submitMessage` → `processUserInput`(processUserInput.ts:178-195)内部触发,PreToolUse / PostToolUse 在 vendor `toolExecution.ts`(:995 附近)内部触发,headless 走 vendor QueryEngine 时**均已自动生效**,不在缺失范围(见 §8.5)。
2. **Resume 只回 messages,不回"运行上下文"** — file history / worktree / cost / plan / attribution / read file state 全部不恢复。模型看得到历史文字,但文件快照回退 / worktree 切换 / cost 累计 / plan slug 全部丢失。
3. ~~**Tool refresh 时机不对**~~ — **已修复(2026-08-27 复核)**:`QueryEngine.ts:288-295` zai patch 已在 `submitMessage` 入口(每轮 prompt 提交前)调 `refreshTools()`,注释明写 "mirroring the REPL's computeTools-per-query";query.ts:2741 "Refresh tools between turns" 是 vendor 原生第二触发点。原"滞后一轮"论断不再成立。

### 中等(影响具体功能)

4. **Permission 协议 mismatch** — REPL 在前端跑 ToolUseConfirm / PermissionRequest / AskUserQuestion / ElicitationDialog 一整套 TUI 对话框,内部协议是 `tool_use:ask_pending` / `tool_use:permission_pending` 等。zai 靠 compat 层把这套协议翻译到 web,但只有 askRegistry + permissionRegistry 两路,**sandbox / worker / elicitation / local JSX commands 全部没出口**。
5. **Background / Swarm / Mailbox 三件套没接** — vendor 的 BackgroundAgent / TaskTool / teammate 系统靠 mailbox 协议 + background daemon 通信,REPL 通过 useInboxPoller + useMailboxBridge + useSessionBackgrounding + useSwarmInitialization 接住。zai server 只手动桥接了一小部分(`__zaiSessionInbox.followup/inject`),BG agent 完成通知、teammate 权限同步、team 初始化整套缺失。
6. **30+ notification hook 不挂载** — rate limit / plugin auto-update / LSP / Chrome extension / 内部 telemetry / API migration / feedback survey / memory survey / post-compact survey / model switch 全没镜像。zai 用户感知不到这些状态变化。

### 结构性(契约上限)

7. **8 方法契约的设计上限** — query / abort / getSession / listSessions / readTranscript / patchSession / removeSession / shutdown + plugins 这套契约,本质是把 vendor CLI 当 RPC 服务,**不暴露** session lifecycle hook / swarm / background / proactive 这类需要长生命周期状态的子模块。如果要把它们都装上,8 方法契约需要扩到至少 15-20 个,且 query 输入需要支持 `effort` / `hooks` / `dynamicMcpConfig` / `proactiveTick` / `scheduledTick` / `mailboxReply` 等。

---

## 7. 修复路径

### 路径 A:补齐 hooks 接入(改动小,覆盖最大盲区)

**目标**:让用户配的 SessionStart / SessionEnd hooks 在 headless runtime 上生效(UserPromptSubmit / PreToolUse / PostToolUse 已经由 QueryEngine 内部链路自动生效,无需接入)。

**改动点**:
1. `createOpenccRuntime-impl.ts:522` query 入口(`engine.submitMessage` 之前)调 `await processSessionStartHooks('query', { sessionId, agentType, model })`,把返回的 hookMessages 注入 messages。
2. query 出口(`finally` 块)调 `await executeSessionEndHooks('query', ...)`。
3. `removeSession` 路径(impl.ts:783)调 `await executeSessionEndHooks('remove', ...)`。
4. ~~UserPromptSubmit hooks 接入~~ — **不需要**:已在 `QueryEngine.submitMessage`(QueryEngine.ts:225 → :494 `processUserInput` → processUserInput.ts:178-195 `executeUserPromptSubmitHooks`)自动触发。
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

## 8. 附录 A:关键 vendor 代码片段

### 8.1 `cronScheduler.ts` 核心 — 1 秒 setInterval 驱动所有 /loop 与 cron

**位置**:`packages/zn-agent-core/src/opencc-src/utils/cronScheduler.ts:40-370`

```typescript
// cronScheduler.ts:40-44
const CHECK_INTERVAL_MS = 1000
const FILE_STABILITY_MS = 300
const LOCK_PROBE_INTERVAL_MS = 5000

// cronScheduler.ts:62-128 — CronSchedulerOptions 契约
type CronSchedulerOptions = {
  onFire: (prompt: string) => void              // 文件-backed 任务的入口
  isLoading: () => boolean                     // turn 进行中则跳过
  assistantMode?: boolean                       // true 时绕过 isLoading 守卫
  onFireTask?: (task: CronTask) => void         // 拿到完整 task(含 agentId / cron / lastFiredAt)
  onMissed?: (tasks: CronTask[]) => void        // 启动时 missed one-shot 任务
  dir?: string                                  // Agent SDK daemon 用,绕开 bootstrap state
  lockIdentity?: string                         // 锁 owner key;daemon 用稳定 per-process UUID
  getJitterConfig?: () => CronJitterConfig      // REPL 用 GrowthBook 注入,可热调
  isKilled?: () => boolean                      // killswitch,每 tick 轮询
  filter?: (t: CronTask) => boolean             // daemon cron worker 用 `t.permanent` 过滤
}

// cronScheduler.ts:142-156
export function createCronScheduler(options: CronSchedulerOptions): CronScheduler {
  const lockOpts = dir || lockIdentity ? { dir, lockIdentity } : undefined
  // File-backed tasks only. Session tasks (durable: false) NOT loaded here —
  // 它们走 bootstrap state 的 getSessionCronTasks(),check() 每 tick 重读。
  let tasks: CronTask[] = []
  const nextFireAt = new Map<string, number>()
  const missedAsked = new Set<string>()
  const inFlight = new Set<string>()           // 防 async chokidar reload 期间重入

  let enablePoll, checkTimer, lockProbeTimer: ...  // 三个 setInterval
  let watcher: FSWatcher | null = null          // chokidar 监听 scheduled_tasks.json
  let stopped = false, isOwner = false
  // ...
}

// cronScheduler.ts:230-369 — check() 每 1s 执行
function check() {
  if (isKilled?.()) return                              // (1) GrowthBook 守卫
  if (isLoading() && !assistantMode) return             // (2) turn 期间不发
  const now = Date.now()
  const seen = new Set<string>()
  const firedFileRecurring: string[] = []               // 批量写盘累积
  const jitterCfg = getJitterConfig?.() ?? DEFAULT_CRON_JITTER_CONFIG

  function process(t: CronTask, isSession: boolean) {
    if (filter && !filter(t)) return                    // daemon 过滤 non-permanent
    seen.add(t.id)
    if (inFlight.has(t.id)) return                      // inFlight 防重入

    let next = nextFireAt.get(t.id)
    if (next === undefined) {
      // 首次见到 → 从 lastFiredAt ?? createdAt 锚定下一个 fire time
      next = t.recurring
        ? (jitteredNextCronRunMs(t.cron, t.lastFiredAt ?? t.createdAt, t.id, jitterCfg) ?? Infinity)
        : (oneShotJitteredNextCronRunMs(t.cron, t.createdAt, t.id, jitterCfg) ?? Infinity)
      nextFireAt.set(t.id, next)
    }

    if (now < next) return

    if (onFireTask) onFireTask(t)                       // 走 task 路径(可路由 teammate)
    else onFire(t.prompt)                                // 走 prompt 字符串路径

    const aged = isRecurringTaskAged(t, now, jitterCfg.recurringMaxAgeMs)
    if (aged) { /* log + 走一次性删除 */ }

    if (t.recurring && !aged) {
      // recurring: 从 now 重锚定下一个 fire(避免 catch-up),jitter 偏移 :00
      const newNext = jitteredNextCronRunMs(t.cron, now, t.id, jitterCfg) ?? Infinity
      nextFireAt.set(t.id, newNext)
      if (!isSession) firedFileRecurring.push(t.id)    // 批量 markCronTasksFired
    } else if (isSession) {
      // 一次性 session task: 同步从内存删除
      removeSessionCronTasks([t.id])
      nextFireAt.delete(t.id)
    } else {
      // 一次性 file task: 异步删除, inFlight 守护
      inFlight.add(t.id)
      void removeCronTasks([t.id], dir).finally(() => inFlight.delete(t.id))
      nextFireAt.delete(t.id)
    }
  }

  if (isOwner) {                                        // 仅 owner 跑 file task
    for (const t of tasks) process(t, false)
    if (firedFileRecurring.length > 0) {
      for (const id of firedFileRecurring) inFlight.add(id)
      void markCronTasksFired(firedFileRecurring, now, dir)
        .finally(() => { for (const id of firedFileRecurring) inFlight.delete(id) })
    }
  }
  // session tasks 路径:每 tick 从 getSessionCronTasks() 重新读, 走 process(t, true)
  // (与 isOwner 守卫无关)
}
```

**关键常量与决策**:
- `CHECK_INTERVAL_MS = 1000`:1 秒 tick — 任何"准实时"调度都有最多 1 秒延迟
- `inFlight: Set<string>`:task 级防重入,覆盖 `removeCronTasks` 异步删除期间 chokidar reload
- `tryAcquireSchedulerLock`(`cronTasksLock.ts`):cwd 级排他锁,防多个 OpenCC 实例同时跑同一份 scheduled_tasks.json
- `getCronJitterConfig()`(`cronJitterConfig.ts`):GrowthBook 注入,运维可热调 jitter 窗口分散 `:00` 流量
- `isKilled`:`() => !isKairosCronEnabled()`,每 tick 检查,翻转立即停止

### 8.2 `useScheduledTasks.ts` + `useProactive` — REPL 侧的循环入口

**位置**:`packages/zn-agent-core/src/opencc-src/hooks/useScheduledTasks.ts:42-130`

```typescript
// useScheduledTasks.ts:42-130
export function useScheduledTasks({ isLoading, assistantMode = false, setMessages }: Props): void {
  const isLoadingRef = useRef(isLoading)
  isLoadingRef.current = isLoading

  useEffect(() => {
    if (!isKairosCronEnabled()) return              // GrowthBook 门控

    const enqueueForLead = (prompt: string) =>
      enqueuePendingNotification({                  // 入队到 commandQueue,priority='later'
        value: prompt,
        mode: 'prompt',
        priority: 'later',                          // turn 结束后才 drain
        isMeta: true,                               // 模型可见 / UI 隐藏
        workload: WORKLOAD_CRON,                    // billing attribution
      })

    const scheduler = createCronScheduler({
      onFire: enqueueForLead,
      onFireTask: task => {
        // teammate 路由:有 agentId → 投递给对应 teammate
        if (task.agentId) {
          const teammate = findTeammateTaskByAgentId(task.agentId, store.getState().tasks)
          if (teammate && !isTerminalTaskStatus(teammate.status)) {
            injectUserMessageToTeammate(teammate.id, task.prompt, setAppState)
            return
          }
          // teammate 死了 → 清理孤儿 cron,否则 recurring 会一直 fire 到 nowhere
          void removeCronTasks([task.id])
          return
        }
        const msg = createScheduledTaskFireMessage(`Running scheduled task (${formatCronFireTime(new Date())})`)
        setMessages(prev => [...prev, msg])
        enqueueForLead(task.prompt)
      },
      isLoading: () => isLoadingRef.current,        // ref 取最新值,避免 stale closure
      assistantMode,
      getJitterConfig: getCronJitterConfig,         // GrowthBook 注入
      isKilled: () => !isKairosCronEnabled(),
    })
    scheduler.start()
    return () => scheduler.stop()
  }, [assistantMode])                              // assistantMode session 寿命内稳定
}
```

**Proactive tick**(REPL.tsx:4424-4440):

```typescript
useProactive?.({
  isLoading: isLoading || initialMessage !== null,
  queuedCommandsLength: queuedCommands.length,
  hasActiveLocalJsxUI: isShowingLocalJSXCommand,
  isInPlanMode: toolPermissionContext.mode === 'plan',
  onSubmitTick: (prompt: string) =>
    handleIncomingPrompt(prompt, { isMeta: true }),        // 立即插队提
  onQueueTick: (prompt: string) =>
    enqueue({ mode: 'prompt', value: prompt, isMeta: true }) // 入队等 turn 结束
})
```

**架构差异**:
- `/loop` → `useScheduledTasks` → `cronScheduler` → 1 秒 tick → `enqueuePendingNotification` → `commandQueue` → turn 结束 drain → `handleIncomingPrompt` → `onSubmit`
- Proactive tick → `useProactive` → 立即/入队 → `handleIncomingPrompt` / `enqueue`
- 两条路最终都汇入同一个 `handleIncomingPrompt` + `onSubmit`

### 8.3 REPL 提问链 — onQuery / onQueryImpl

**位置**:`packages/zn-agent-core/src/opencc-src/screens/REPL.tsx:3109-3314` (onQuery) + `2915-3108` (onQueryImpl)

```typescript
// REPL.tsx:3109-3140 — onQuery 入口
const onQuery = useCallback(async (newMessages, abortController, shouldQuery, additionalAllowedTools, mainLoopModelParam, onBeforeQueryCallback?, input?, effort?) => {
  // teammate mark active
  if (isAgentSwarmsEnabled()) {
    const teamName = getTeamName(), agentName = getAgentName()
    if (teamName && agentName) void setMemberActive(teamName, agentName, true)
  }

  // queryGuard 状态机原子进入 running(generation token 防并发)
  const thisGeneration = queryGuard.tryStart()
  if (thisGeneration === null) {
    // 并发兜底:把 user 文本入队,不让 query 抢占
    newMessages.filter(m => m.type === 'user' && !m.isMeta).forEach(msg => {
      enqueue({ value: getContentText(msg.message.content), mode: 'prompt' })
    })
    return false
  }
  try {
    resetTimingRefs()
    resetCurrentTurn()
    setMessages(old => [...old, ...newMessages])    // 同步把新 message 写入 messagesRef
    responseLengthRef.current = 0
    snapshotOutputTokensForTurn(input ? parseTokenBudget(input) ?? getCurrentTurnTokenBudget() : getCurrentTurnTokenBudget())
    setStreamingToolUses([]); setStreamingText(null)
    const latestMessages = messagesRef.current      // 已含 newMessages
    if (input) await mrOnBeforeQuery(input, latestMessages, newMessages.length)
    if (onBeforeQueryCallback && input) {
      const ok = await onBeforeQueryCallback(input, latestMessages)
      if (!ok) return
    }
    await onQueryImpl(latestMessages, newMessages, abortController, shouldQuery, additionalAllowedTools, mainLoopModelParam, thisGeneration, effort)
  } finally {
    if (queryGuard.end(thisGeneration)) {           // generation match 才结束
      clearQueryProfile()
      setLastQueryCompletionTime(Date.now())
      skipIdleCheckRef.current = false
      resetLoadingState()
      await mrOnTurnComplete(messagesRef.current, abortController.signal.aborted)  // zai 镜像成 runNextInQueue
      sendBridgeResultRef.current()                  // mobile bridge 通知 turn 结束
      // tungsten / budget / cache stats / auto-restore(用户 cancel 时回滚)
    }
    // 自动回滚:用户 cancel + 没新 query + 输入框空 + 队列空 + 没在 teammate view
    if (abortController.signal.reason === 'user-cancel' && !queryGuard.isActive && inputValueRef.current === '' && getCommandQueueLength() === 0 && !store.getState().viewingAgentTaskId) {
      const lastUserMsg = messagesRef.current.findLast(selectableUserMessagesFilter)
      if (lastUserMsg && messagesAfterAreOnlySynthetic(messagesRef.current, lastIndex)) {
        removeLastFromHistory()
        restoreMessageSyncRef.current(lastUserMsg)
      }
    }
  }
}, [...deps])

// REPL.tsx:2915-3108 — onQueryImpl 真正调 vendor query()
const onQueryImpl = useCallback(async (messages, newMessages, abortController, shouldQuery, additionalAllowedTools, mainLoopModelParam, thisGeneration, effort) => {
  if (shouldQuery) {
    const freshClients = mergeClients(initialMcpClients, store.getState().mcp?.clients)
    void diagnosticTracker.handleQueryStart(freshClients)
    const ideClient = getConnectedIdeClient(freshClients)
    if (ideClient) void closeOpenDiffs(ideClient)
  }
  void maybeMarkProjectOnboardingComplete()

  // 第一条 user message 时,Haiku 抽标题(已 resumed session 跳过)
  if (!titleDisabled && !sessionTitle && !agentTitle && !haikuTitleAttemptedRef.current) {
    const text = newMessages.find(m => m.type === 'user' && !m.isMeta)?.message.content
    if (text && /* 跳过 <local-command-stdout> / <command-message> / <command-name> / <bash-input> 合成 */) {
      haikuTitleAttemptedRef.current = true
      void generateSessionTitle(text, new AbortController().signal).then(t => t ? setHaikuTitle(t) : haikuTitleAttemptedRef.current = false)
    }
  }

  // slash-command-scoped allowedTools 写 store
  store.setState(prev => { /* alwaysAllowRules.command = additionalAllowedTools */ })

  if (!shouldQuery) {                                // /compact 等不 query 的命令
    if (newMessages.some(isCompactBoundaryMessage)) {
      setConversationId(randomUUID())
      // proactiveModule?.setContextBlocked(false)
    }
    resetLoadingState(); setAbortController(null)
    return
  }

  const toolUseContext = getToolUseContext(messages, newMessages, abortController, mainLoopModelParam, thisGeneration)
  if (effort !== undefined) {
    // 临时把 effort 包成 per-turn AppState getter override,不污染全局
    const prev = toolUseContext.getAppState
    toolUseContext.getAppState = () => ({ ...prev(), effortValue: effort })
  }

  // 并发加载 system prompt / user context / system context
  const [, , defaultSystemPrompt, baseUserContext, systemContext] = await Promise.all([
    checkAndDisableBypassPermissionsIfNeeded(toolPermissionContext, setAppState),
    checkAndDisableAutoModeIfNeeded(toolPermissionContext, setAppState, store.getState().fastMode),
    getSystemPrompt(freshTools, mainLoopModelParam, Array.from(toolPermissionContext.additionalWorkingDirectories.keys()), freshMcpClients),
    getUserContext(),
    getSystemContext(),
  ])
  const userContext = {
    ...baseUserContext,
    ...getCoordinatorUserContext(freshMcpClients, isScratchpadEnabled() ? getScratchpadDir() : undefined),
  }
  const systemPrompt = buildEffectiveSystemPrompt({ mainThreadAgentDefinition, toolUseContext, customSystemPrompt, defaultSystemPrompt, appendSystemPrompt })
  toolUseContext.renderedSystemPrompt = systemPrompt

  // 真正调 vendor query() — 唯一的 for-await 循环
  for await (const event of query({
    messages,
    systemPrompt,
    userContext,
    systemContext,
    canUseTool,
    toolUseContext,
    querySource: getQuerySourceForREPL(),
  })) {
    onQueryEvent(event)
  }

  // 内部 API metrics 采集
  if (isAntEmployee() && apiMetricsRef.current.length > 0) { /* OTPS / TTFT / hook 耗时 */ }

  resetLoadingState()
  logQueryProfileReport()
  await onTurnComplete?.(messagesRef.current)
}, [...deps])
```

### 8.4 `createOpenccRuntime-impl.query()` — zai 侧的镜像点

**位置**:`packages/zn-agent-core/src/opencc-src/server/createOpenccRuntime-impl.ts:522-751`

```typescript
// createOpenccRuntime-impl.ts:522-549 — query 入口与 permissionMode
async *query(input) {
  if (closed) throw new Error('openccRuntime: shutdown')
  turnIndex += 1
  if (input.permissionMode) {
    // per-query permission mode → AppState.setState (追齐 REPL.transitionPermissionMode)
    ctx.appState.setState(prev => {
      const current = prev.toolPermissionContext.mode
      if (current === input.permissionMode) return prev
      const next = transitionPermissionMode(current, input.permissionMode, prev.toolPermissionContext)
      return { ...prev, toolPermissionContext: { ...next, mode: input.permissionMode } }
    })
  }

// createOpenccRuntime-impl.ts:561-565 — per-query AbortController(Mirror vendor print.ts:2282)
const queryAbortController = createAbortController()
if (input.abortSignal) {
  if (input.abortSignal.aborted) queryAbortController.abort(input.abortSignal.reason)
  else input.abortSignal.addEventListener('abort', () => queryAbortController.abort(input.abortSignal.reason), { once: true })
}

// createOpenccRuntime-impl.ts:577-627 — resume hydration(镜像 REPL useState(initialMessages))
let engine = engines.get(input.sessionId)
if (!engine) {
  let initialMessages: Message[] | undefined
  try {
    const jsonl = await sessions.readTranscript(input.sessionId)
    if (jsonl.trim().length > 0) {
      const entries: Message[] = []
      for (const line of jsonl.split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          const e = JSON.parse(t)
          // 仅 transcript 形态(type=user/assistant/attachment/system)参与 chain,
          // 其他(session-meta / file-history-snapshot 等)不能灌回 vendor mutableMessages
          if (e?.type === 'user' || e?.type === 'assistant' || e?.type === 'attachment' || e?.type === 'system') {
            entries.push(e as Message)
          }
        } catch { /* 跳过损坏行 */ }
      }
      if (entries.length > 0) initialMessages = deserializeMessages(entries)
    }
  } catch (err) { /* 新会话 / 文件不存在 / 读失败 → 当作全新对话 */ }
  // zai patch (2026-08-20): 按会话恢复的 mainAgent 构建 engine
  engine = createEngine(initialMessages, input.mainAgent)
  engines.set(input.sessionId, engine)
}
engine.replaceAbortController(queryAbortController)
queryAbortControllers.set(input.sessionId, queryAbortController)

// createOpenccRuntime-impl.ts:638-642 — per-query bridge ctx(替代 REPL onQueryImpl 里的本地变量)
const prevBridge = (globalThis as any).__zaiBridgeCtx
;(globalThis as any).__zaiBridgeCtx = { ...(prevBridge ?? {}), sessionId: input.sessionId }

// createOpenccRuntime-impl.ts:656-693 — model override + submitMessage
if (input.model) {
  engine.setModel(input.model)
  ctx.appState.setState(prev => ({ ...prev, mainLoopModel: input.model }))   // zai patch
}
const stream = engine.submitMessage(input.prompt, {
  uuid: randomUUID(),                                       // 不用 sessionId 当 uuid,避免 dedup 跳过
  ...(input.isMeta ? { isMeta: true } : {}),
  ...(input.providerOverride ? { providerOverride: input.providerOverride } : {}),
  ...(input.providerId ? { providerId: input.providerId } : {}),
})

// createOpenccRuntime-impl.ts:708-741 — 套 runWithSdkContext + translateSdkToRuntime 包 SDK Message
const sdkCtx = input.sessionId ? { sessionId: input.sessionId, sessionProjectDir: null, cwd, originalCwd: cwd } : null
const adapterMeta = { sessionId: input.sessionId, turnIndex, eventCounter: 0, toolNameByUseId: new Map(), streamedBlockIndices: new Set() }
while (true) {
  const step = sdkCtx ? await runWithSdkContext(sdkCtx, () => stream.next()) : await stream.next()
  if (step.done) break
  for (const ev of translateSdkToRuntime(step.value, adapterMeta)) yield ev as any
  adapterMeta.eventCounter++
}

// createOpenccRuntime-impl.ts:742-750 — finally 清理
} finally {
  if (prevBridge === undefined) delete (globalThis as any).__zaiBridgeCtx
  else (globalThis as any).__zaiBridgeCtx = prevBridge
  if (typeof input.sessionId === 'string') queryAbortControllers.delete(input.sessionId)
}
```

**镜像对比表**:

| REPL 写法 | zai 镜像写法 | 备注 |
|---|---|---|
| `useState(initialMessages)` (useState-based React state) | `mutableMessages = deserializeMessages(JSON.parse(jsonl))` | zai 走 disk hydration,无 React state |
| `for await (const event of query({messages, systemPrompt, userContext, systemContext, canUseTool, toolUseContext, querySource}))` | `engine.submitMessage(prompt, opts)` + `for await (const step of stream.next())` 包 `translateSdkToRuntime` | zai 多一层 SDK event 翻译 |
| `setAbortController(abortController)` per turn | `Map<sessionId, AbortController>` | zai 无 queryGuard generation token |
| `transitionPermissionMode` 调用通过 `setAppState` | `ctx.appState.setState(prev => transitionPermissionMode(...))` | zai 显式调 |
| `computeTools` 在 onQueryImpl 入口现算 | `refreshTools: engineComputeTools` 由 QueryEngine `submitMessage` 入口触发(QueryEngine.ts:288-295 zai patch)+ query.ts:2741 turn 间第二触发点 | 已对齐每轮提交前刷新 |

### 8.5 hooks 系统入口 — zai 完全没接

**位置**:`packages/zn-agent-core/src/opencc-src/utils/hooks.ts` + `sessionStart.ts`

```typescript
// sessionStart.ts — REPL 每次 prompt 都调
const hookMessages = await processSessionStartHooks('resume' | 'fork', {
  sessionId, agentType: mainThreadAgentDefinition?.agentType, model: mainLoopModel
})
// hook 返回的 messages push 进 messages,跟普通 user/assistant message 一样处理

// hooks.ts — REPL session 切换时调
await executeSessionEndHooks('resume', {
  getAppState: () => store.getState(),
  setAppState,
  signal,                                  // createCombinedAbortSignal 包装的 timeout 信号
  timeoutMs: getSessionEndHookTimeoutMs()  // 默认几秒
})
```

**REPL 触发点**:
- `REPL.tsx:1949-1957` — resume 时 fire SessionEnd for current session,再 processSessionStartHooks for target
- vendor `toolExecution.ts` 内部 PreToolUse / PostToolUse 钩子(工具执行前后自动触发,无需 headless 镜像)
- `UserPromptSubmit` 钩子在 `processUserInput`(processUserInput.ts:178-195 `executeUserPromptSubmitHooks`)触发

**zai 现状**(2026-08-27 二复核修正):
- **不调** 的只有 `processSessionStartHooks` / `executeSessionEndHooks`(外壳层职责)
- **UserPromptSubmit 已生效**:`QueryEngine.submitMessage`(QueryEngine.ts:225)在 :494 调 `processUserInput`,内部即触发 UserPromptSubmit hooks——zai 经 `engine.submitMessage` 提交,该链路自动覆盖
- PreToolUse / PostToolUse 走 `toolExecution.ts` 内部触发,同样已生效
- `__zaiBridgeCtx` 桥接了 AskUserQuestion 的 onYield
- 结论:用户 hooks 配置中仅 **SessionStart / SessionEnd 两类失活**,其余全部生效

### 8.6 computeTools / refreshTools 模式

**位置**:`packages/zn-agent-core/src/opencc-src/server/createOpenccRuntime-impl.ts:105-110, 197-216`

```typescript
// createOpenccRuntime-impl.ts:105-110 — 镜像 REPL 的 computeTools
const computeTools = () => {
  const state = ctx.appState.getState()
  const permissionContext = state.toolPermissionContext
  const assembled = assembleToolPool(permissionContext, state.mcp?.tools ?? [])
  return mergeAndFilterTools(ctx.tools, assembled, permissionContext.mode)
}

// createOpenccRuntime-impl.ts:197-216 — per-engine 工具池(主 Agent tools 槽)
const createEngine = (initialMessages?: Message[], mainAgentName?: string) => {
  const agent = resolveSessionMainAgent(mainAgentName)
  const engineComputeTools = () =>
    agent?.tools ? agent.tools(computeTools()) : computeTools()  // 主 agent 可白名单 / 注入
  return new QueryEngine({
    cwd,
    tools: engineComputeTools(),
    commands: ctx.mcp.commands,
    mcpClients: ctx.mcp.clients,
    includePartialMessages: true,                                  // SDK 流事件透明
    refreshTools: engineComputeTools,                             // vendor QueryEngine 触发
    systemPromptSlot: agent?.systemPrompt,                         // 主 agent systemPrompt 槽
    agents: ctx.appState.getState().agentDefinitions.activeAgents,
    canUseTool: ctx.permission,
    getAppState: ctx.appState.getState,
    setAppState: wrapTaskAwareSetState(...),                       // 桥接 AgentTool → agentTaskBridge
    readFileCache: new FileStateCache(100, 25 * 1024 * 1024),
    abortController: initialAbortController,
    query: customQuery,                                            // options.query 包装
    ...(initialMessages?.length ? { initialMessages } : {}),
  })
}
```

**REPL 的 computeTools 触发时机对比**(2026-08-27 复核更新):
- REPL: `onQueryImpl` 入口重算 `tools` + `mcpClients`(每轮 prompt 提交前),`useManageMCPConnections` 异步 flush 新 MCP
- headless: `QueryEngine.ts:288-295` zai patch 在 `submitMessage` 入口调 `refreshTools()`(即每轮 prompt 提交前),另有 query.ts:2741 "Refresh tools between turns" turn 间触发 → 中途 enable plugin 当轮可见

### 8.7 sessionRestore 入口 — zai 完全没接

**位置**:`packages/zn-agent-core/src/opencc-src/utils/sessionRestore.ts` + `sessionStorage.ts`

```typescript
// sessionRestore.ts — REPL resume() 调用
const messages = deserializeMessages(log.messages)
const { computeStandaloneAgentContext, restoreAgentFromSession,
        restoreSessionStateFromLog, restoreWorktreeForResume,
        exitRestoredWorktree } = require('../utils/sessionRestore.js')

// restoreAgentFromSession:从 log.agentSetting 恢复 AgentDefinition
const { agentDefinition: restoredAgent } = restoreAgentFromSession(
  log.agentSetting, initialMainThreadAgentDefinition, agentDefinitions)
setMainThreadAgentDefinition(restoredAgent)

// restoreSessionStateFromLog:恢复 file history / attribution / bash tools
restoreSessionStateFromLog(log, setAppState)

// restoreWorktreeForResume:从 log.worktreeSession 切 worktree
exitRestoredWorktree()       // 先退出当前 worktree
restoreWorktreeForResume(log.worktreeSession)
adoptResumedSessionFile()    // 把 transcript 文件指针切到 resumed session

// getCurrentWorktreeSession 在 utils/worktree.ts:157;saveWorktreeState 在 utils/sessionStorage.ts:3244
```

**zai 镜像**(createOpenccRuntime-impl.ts:577-625):
- 仅 `deserializeMessages(JSON.parse(jsonl))` 反序列化 messages
- worktree / file history / attribution / plan / cost / agent setting 全部不恢复
- coordinator mode warning 不生成

### 8.8 30+ REPL notification hooks 全清单

**位置**:`packages/zn-agent-core/src/opencc-src/screens/REPL.tsx:835-867`

```
useModelMigrationNotifications()                  # API 迁移提醒
useCanSwitchToExistingSubscription()              # 订阅切换提醒
useIDEStatusIndicator({...})                       # IDE 状态
useMcpConnectivityStatus({...})                   # MCP 连接状态
useAutoModeUnavailableNotification()               # auto 模式不可用
usePluginInstallationStatus()                      # plugin 安装状态
usePluginAutoupdateNotification()                 # plugin 自动更新
useSettingsErrors()                                # settings 错误
useRateLimitWarningNotification(mainLoopModel)     # 429 限流警告
useFastModeNotification()                          # fast mode 通知
useDeprecationWarningNotification(mainLoopModel)  # 弃用 API 警告
useInstallMessages()                               # 安装消息
useChromeExtensionNotification()                   # Chrome 扩展通知
useLspInitializationNotification()                 # LSP 初始化
useTeammateLifecycleNotification()                 # teammate 生命周期
useLspPluginRecommendation()                       # LSP 推荐
useClaudeCodeHintRecommendation()                  # Claude Code 提示推荐
usePromptsFromClaudeInChrome(...)                  # Chrome MCP 提示
useSkillsChange(...)                               # skill 文件 hot-reload
useManagePlugins(...)                              # plugin 装载
useTasksV2WithCollapseEffect()                     # task list v2
useSwarmInitialization(...)                        # swarm 团队初始化
useBackgroundTaskNavigation()                      # 后台 task 导航
useTeammateViewAutoExit()                          # teammate view 自动退出
useSessionBackgrounding({...})                    # session 后台化
useInboxPoller({...})                              # inbox 轮询
useMailboxBridge({...})                            # mailbox bridge
useScheduledTasks({...})                           # cron / /loop
useProactive?.({...})                              # proactive tick
useAssistantHistory(...)                           # 助手历史
useApiKeyVerification()                            # API key 验证
useCostSummary()                                   # cost 摘要
useFpsMetrics()                                    # FPS metrics
useAfterFirstRender()                              # first render hook
useDeferredHookMessages({...})                     # 延迟 hook messages
useIdeLogging({...})                               # IDE 日志
useIdeSelection({...})                             # IDE 选择
useFileHistorySnapshotInit(...)                    # file history init
useKickOffCheckAndDisableBypassPermissionsIfNeeded() # bypassPermissions killswitch
useKickOffCheckAndDisableAutoModeIfNeeded()        # auto mode killswitch
usePromptsFromClaudeInChrome(...)                  # Chrome MCP 提示
useAwaySummary()                                   # 离开摘要
useMemorySurvey()                                  # 内存 survey
usePostCompactSurvey()                             # post-compact survey
useSkillImprovementSurvey()                        # skill 改进 survey
useFeedbackSurvey()                                # 反馈 survey
useTaskListWatcher({...})                          # task list watcher (内部)
useIdleReturnDialog / CostThresholdDialog          # 对话框组件
useChromeExtensionNotification()                   # Chrome 扩展
useInstallMessages()                               # 安装消息
useIssueFlagBanner()                               # issue flag banner
useCustomShortcuts (keybindings)
```

**zai 镜像**:**全部 ❌** — 一个都没挂载。意味着:
- rate limit 警告:zai server 自己 emit `runtime.error` 但没对应的通知 UI
- plugin auto-update / MCP status:用户在 web UI 看不到
- LSP / Chrome / IDE 集成状态:全无
- survey 类(feedback / memory / post-compact):全无
- keybinding 显示:无关(web 是鼠标)

### 8.9 关键 vendor 常量与决策(便于对齐)

| 常量 / 决策 | 来源 | 值 / 含义 |
|---|---|---|
| `CHECK_INTERVAL_MS` | cronScheduler.ts:40 | `1000` — /loop 最多 1 秒延迟 |
| `FILE_STABILITY_MS` | cronScheduler.ts:41 | `300` — chokidar 文件稳定检测 |
| `LOCK_PROBE_INTERVAL_MS` | cronScheduler.ts:44 | `5000` — 非 owning session 探锁间隔 |
| `recurringMaxAgeMs` | cronJitterConfig.ts | recurring 任务自动过期时间 |
| `HARD_TIMEOUT_MS` | routes/agent.ts:124 | `2 * 60 * 60 * 1000` — zai 兜底超时(原本 5min 太短) |
| `SESSION_RATE_LIMIT_COOLDOWN_MS` | routes/agent.ts:744 | `30_000` — 429 后会话级冷却 |
| `PROMPT_SUPPRESSION_MS` | REPL.tsx:1082 | `1500` — 用户输入期间不弹中断对话框 |
| `RECENT_SCROLL_REPIN_WINDOW_MS` | REPL.tsx:319 | `3000` — 用户滚轮后不强制回到底部 |
| `IDLE_THINKING_AUTO_HIDE_MS` | REPL.tsx:947 | `30_000` — thinking 流式结束后 30s 自动隐藏 |
| `queryGuard` generation | REPL.tsx:994 | 每 turn 一个 generation token,stale finally 不误清状态 |
| `recurring task anchor` | cronScheduler.ts:264 | 从 `lastFiredAt ?? createdAt` 锚定,防止 daemon child despawn 重锚过期 |
| `assistantMode no --proactive` | useScheduledTasks.ts:25 | #20425 起 assistant mode 不再 force --proactive,isLoading 走 normal REPL 节奏 |

---

## 9. 附录 B:关键文件位置

| 主题 | 路径 |
|---|---|
| zai server agent 入口 | `packages/zai/src/server/routes/agent.ts:1491` (`router.post('/agent/prompt')`) → `:908` (`runQueryLoop`) |
| zai per-session queue | `packages/zai/src/server/routes/agent.ts:734` (`sessionQueues`) + `:801` (`runNextInQueue`) |
| zai agentRuntime 模块 | `packages/zai/src/server/services/agentRuntime.ts` |
| zai eventBus → SSE | `packages/zai/src/server/services/eventBus.ts` |
| OpenccRuntime 类型契约 | `packages/zn-agent-core/src/opencc-src/server/serverTypes.ts:274-294` |
| OpenccRuntime 实现 | `packages/zn-agent-core/src/opencc-src/server/createOpenccRuntime-impl.ts` |
| vendor REPL 入口 | `packages/zn-agent-core/src/opencc-src/screens/REPL.tsx:615` |
| vendor query 入口 | `packages/zn-agent-core/src/opencc-src/query.ts:501`(生成器入口;model 流式 for-await 在 :1271)|
| vendor QueryEngine | `packages/zn-agent-core/src/opencc-src/QueryEngine.ts` |
| vendor cronScheduler | `packages/zn-agent-core/src/opencc-src/utils/cronScheduler.ts` |
| vendor sessionRestore | `packages/zn-agent-core/src/opencc-src/utils/sessionRestore.ts` |
| vendor hooks 系统 | `packages/zn-agent-core/src/opencc-src/utils/hooks.ts` |
| vendor print.ts(headless 全循环) | `packages/zn-agent-core/src/opencc-src/cli/print.ts`(5771 行,见 §5.8) |
| zai SessionHost 子进程路径 | `packages/zai/src/server/services/sessionHost/SessionRegistry.ts` + `cliSpawn.ts:49-53`(`-p --input-format stream-json`) |
| zai 双轨开关 | `packages/zai/src/server/services/agentRuntime.ts:460-493` |

## 10. 后续 Spec 建议

按优先级:

1. **Hooks 接入 spec** — 路径 A 的具体改动方案 + 兼容性 + 测试矩阵(范围缩小为 SessionStart / SessionEnd;UserPromptSubmit / PreToolUse / PostToolUse 已生效)
2. **双轨路径 A 对齐 spec**(§5.8)— zai HTTP/SSE 协议 ↔ SDK stream-json + control_request(权限 / elicitation / interrupt / set_proactive)映射,替代自建外壳
3. **Resume 状态补齐 spec** — 路径 B 的字段清单 + 错误兜底 + race 处理(可直接参考 print.ts:5063-5130 的恢复序列)
4. **Loop / Cron 在 zai server 的镜像 spec** — `/loop` 接入 + cronScheduler 复用 + proactive tick 协议(print.ts:2850-2880 / :2631 有现成命令式范式)
5. ~~**Tool Refresh 时机修正**~~ — 已落地(`QueryEngine.ts:288-295` zai patch 在 `submitMessage` 入口刷新),无需再立 spec
