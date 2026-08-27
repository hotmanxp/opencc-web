# 改造规划:ZAI_OPENCC_CLI 轨道改为 in-process 多 session print 运行时

日期:2026-08-27
状态:规划(待评审)
关联 spec:`docs/superpowers/specs/2026-08-27-zai-headless-runtime-vs-vendor-repl-comparison.md`(§5.8)

## 0. 需求与结论

**需求**:
1. 保持双轨:`ZAI_OPENCC_CLI=1` 轨道从「spawn `opencc -p` 子进程」改为「**in-process 调用本地 print.ts vendor 模块**」,拿到完整 REPL session 循环能力(hooks/cron/resume 全恢复/rewind/proactive/inbox)。
2. 原 print.ts 是"一进程一 session、跑完退进程"模型——改造后**支持每个 sessionId 一个"REPL 等价实例",带完整生命周期(创建/销毁)**。

**可行性结论:支持,但必须先给 print.ts 做"进程级副作用脱钩"手术。**

- ✅ 天然可实例化:`runHeadless`(print.ts:459)是普通 async 函数;`structuredIO`/`running`/`inputClosed`/`run()` mutex/`cronScheduler` 全是 per-call 局部变量;store 是注入参数(`getAppState/setAppState`, :461-462);`ask()`(QueryEngine.ts:1455)每 turn 新建 QueryEngine,并发安全——与 zai 用的是同一套核心。
- ❌ 四个进程级 blocker(必须 patch):
  1. **输出硬绑 `process.stdout`**:structuredIO.ts:465 → process.ts:28;`installStreamJsonStdoutGuard`(streamJsonStdoutGuard.ts:10-12)进程级 monkey-patch 单例
  2. **`runHeadless` 末尾无条件 `gracefulShutdownSync`**(print.ts:1029)→ `process.exit`(gracefulShutdown.ts:383/423/456),且 `shutdownInProgress` 全局互斥,第二个并发 session 的 shutdown 直接 no-op
  3. **进程级 registry**:cleanupRegistry(gracefulShutdown.ts:39)、`AsyncHookRegistry.pendingHooks` module Map(AsyncHookRegistry.ts:28)跨 session 耦合
  4. **module-level 泄漏状态**:`receivedMessageUuids` Set(print.ts:399-400)、`settingsChangeDetector.subscribe` 无退订(print.ts:525)、`process.on('SIGINT')` 不移除(print.ts:1181)
- ⚠️ 次级风险:cwd/sessionId 等 AsyncLocalStorage 上下文(zai 已有 `runWithSdkContext` 机制可复用);多实例共享 cwd 级 cron 文件锁(owner 独占文件任务,session-only 任务私有,不双 fire)。

## 1. 总体架构

```
routes/agent.ts (零改动)
   ↓ OpenccRuntime 8 方法契约 (serverTypes.ts:274)
agentRuntime.ts:460-493 三态开关
   ├─ "off"(默认)      → createOpenccRuntime(现有轻量 headless,保留)
   ├─ "inproc"(新)     → createPrintRuntime ★ 本次新增
   └─ "spawn"(legacy)  → SessionRegistry 子进程路径(代码保留,不再默认)
                            ↓
              createPrintRuntime-impl(新文件,对齐 createOpenccRuntime-impl 形态)
                Map<sessionId, PrintSessionInstance>   ← 每 session 一个"REPL 等价实例"
                getOrCreate(sid) → printFactory.createSession({ sink, hooks... })
                destroy(sid)     → instance.dispose()
                            ↓
              print.ts 抽出的 createHeadlessSession(deps)  ← vendor 手术产物
                deps: { writeOutput, onComplete, disposeBag, sessionId... }
                runHeadless 退化为薄壳:sink=stdout, onComplete=gracefulShutdownSync
```

**双轨对上接口不变**:`PrintRuntime` 实现同一 `OpenccRuntime` 契约(query/abort/getSession/listSessions/readTranscript/patchSession/removeSession/shutdown + plugins);session CRUD 直接复用两条支路共享的 sessionFacade(参照 RuntimeAdapter.ts:24-86);SDK message → RuntimeEvent 翻译**复用现成的** `translateSdkToRuntime`(compat/runtime/sdkEventAdapter.ts:46-314)。

## 2. Phase 0:vendor 手术——print.ts 抽出 `createHeadlessSession`

> 原则:CLI(`opencc -p`)行为逐字节不变;所有改动打 `// zai patch` 注释。改动全在 `packages/zn-agent-core/src/opencc-src/`(允许修改,改后 `build:core`)。

### 2.1 输出 sink 参数化
- `StructuredIO.write` 的落点从 `writeToStdout` 抽象为可注入 `writeOutput: (line: string) => void`(structuredIO.ts:459-467 附近)
- `runHeadless` 内直写 stdout 的散点(print.ts:817, 981-999, 5013)改走同一 sink
- `installStreamJsonStdoutGuard` 仅在 `sink === stdout 默认实现` 时安装(in-process 模式跳过)

### 2.2 shutdown 解耦
- print.ts:1029 的 `gracefulShutdownSync(...)` 改为 `await deps.onComplete(lastMessage)`,默认实现 = 现在的 gracefulShutdownSync;in-process 实现 = resolve 本轮 promise + 标记 idle,**不退出进程**
- `process.exit`(print.ts:507)同理收口到 deps

### 2.3 生命周期资源收口(dispose bag)
- 新类型 `DisposeBag { add(fn) }`,`runHeadless` 内所有注册统一登记:
  - `settingsChangeDetector.subscribe`(:525)→ 退订函数入 bag
  - `process.on('SIGINT')`(:1181)→ in-process 模式改注册到 engine 自带 abortController,不加进程 listener
  - heartbeat interval(:626/:971)、cronScheduler.stop(:4276)、skillChangeDetector 退订(:1972/:2830)→ 入 bag
- 抽出 `createHeadlessSession(deps): { run(input?: string | AsyncIterable<string>), enqueue(prompt, priority), interrupt(reason), abort(reason), dispose(): Promise<void> }`:
  - `run()` = 现在的常驻主循环(print.ts:2084 `while ((command = dequeue(...)))` + enqueue 唤醒),**一轮 prompt 结束不退出**,等下一条(内存队列 / sink pull)
  - `enqueue()` = 暴露 print 现成 `enqueue`(带 priority;`:2006-2009` 的 `'now'` 抢占语义原样保留)——支撑 steering,见 §9.2
  - `interrupt()` = `abortController.abort('interrupt')`(print.ts:1177 同款)
  - `dispose()` = 排空 bag + `executeSessionEndHooks('remove')` + finalize 本 session 的 async hooks

### 2.4 全局状态实例化
- `receivedMessageUuids` / `receivedMessageUuidsOrder`(print.ts:399-400)→ session 实例字段
- `AsyncHookRegistry`:pendingHooks 记录加 `sessionId` 维度,`finalizePendingAsyncHooks(sessionId?)` 支持按 session 过滤;进程退出路径仍 finalize 全部(不破坏 CLI)
- cleanupRegistry 拆 `registerSessionCleanup(sessionId, fn)` / `registerProcessCleanup(fn)`

### 2.5 session ctx 隔离
- 每个实例 `run()` 用 zai 现有 `runWithSdkContext({ sessionId, cwd, ... })`(createOpenccRuntime-impl.ts:708-714 同款)包裹,隔离 AsyncLocalStorage 里的 sessionId/cwd,避免并发实例互串

## 3. Phase 1:zai 侧 `createPrintRuntime` 工厂

新文件 `packages/zn-agent-core/src/opencc-src/server/createPrintRuntime-impl.ts`(+ types,对齐现有 createOpenccRuntime 的文件形态,从主入口 `@zn-ai/zn-agent-core` 导出):

```ts
createPrintRuntime(options) → OpenccRuntimeV2   // = OpenccRuntime(8) + enqueue + interrupt
```

| 契约方法 | 实现 |
|---|---|
| `query(input)` | `getOrCreateInstance(sid)` → `instance.enqueue(prompt, priority)` → 从实例输出队列 pull SDK message → `translateSdkToRuntime` → yield RuntimeEvent;`runWithSdkContext` 包裹 |
| `enqueue(sid, prompt, priority)` | **steering 核心**:直通 print `enqueue`;`'now'` 触发 `:2006-2009` 抢占打断当前轮,`'next'/'later'` 排队合批 |
| `interrupt(sid, reason)` | `instance.interrupt(reason)` → `abort('interrupt')`(print.ts:1177);turn 自动续跑靠 `:1316-1329` |
| `abort(sid)` | `instance.abort(reason)`(走 engine AbortController,不杀实例) |
| `getSession/listSessions/readTranscript/patchSession/removeSession` | 复用 sessionFacade(与 spawn 支路同源) |
| `removeSession` / `shutdown` | `instance.dispose()`(destroy 语义,见 §4) |
| `getSessionState(sid)` | 返回该实例 `store.getState()` 只读投影(Q1,见 §9.1) |
| `plugins` | 委托 vendor plugin 子系统(print.ts 本就走同一套) |

实例创建入参:`createHeadlessSession({ sessionId, cwd, resume: sid(首建时从盘 hydrate,print.ts:5063 loadConversationForResume 全套), sink: 内存队列, store: per-session appState(用 main.tsx:2715 createAppStateStore 同款工厂,**每实例一个,不再共享 ctx.appState**), canUseTool: zai permissionRegistry, ... })`

**开关**:`agentRuntime.ts` 的 `ZAI_OPENCC_CLI` 升级为三值 `off | inproc | spawn`(默认 off;旧值 `1/true` → `inproc`,兼容现有部署)。settings.runtime.openccCli 同步。

## 4. 实例生命周期(需求 2 的直接回答)

```
getOrCreate(sid):
  miss → new PrintSessionInstance(resume hydrate:messages+worktree+fileHistory+
          attribution+plan+cost+mode+matchSessionMode 警告,全部走 print.ts 现成恢复链)
  hit  → 复用(等价于子进程 track 的常驻进程)

query 期间:实例内 while(dequeue) 主循环消费;同 session 串行,异 session 并行
           (print 局部 mutex,非全局)

destroy(三入口):
  a) removeSession / delete session API → dispose():abort 活动 turn →
     SessionEnd hooks → finalize pending hooks(sid) → cron/订阅/interval 退订 →
     out queue 丢弃 → map 删除
  b) runtime.shutdown() → 并行 dispose 全部 → 最后进程级 gracefulShutdown
  c) idle TTL(新增,修 spawn track 已知的"无回收泄漏"):idle > N 分钟(默认 30,可配
     ZAI_PRINT_IDLE_TTL_MIN)→ dispose;transcript 已落盘(去掉 --no-session-persistence),
     下次 query 重新 hydrate,用户无感
```

并发上限:新增 `ZAI_PRINT_MAX_SESSIONS`(默认 8),超限按 LRU-evict idle 实例;全实例共享一个进程级 cronScheduler(fire 按 task.sessionId 路由 enqueue 到对应实例,实例不在则 hydrate-on-fire 或丢弃记日志)。

## 5. Phase 2:能力对齐与出口

- **用户交互三分路由**(评审补充——AskUserQuestion / 权限 / elicitation 是三条不同通道,必须显式区分):

  | 通道 | 载体 | zai 出口 | 响应 shape |
  |---|---|---|---|
  | AskUserQuestion(**主方案:compat 包装器**) | `compat/tools/opencc/AskUserQuestionTool.ts` 经 `filteredTools=[...tools,…]`(print.ts:891)注入,同名覆盖 vendor 工具;call-time 读 `__zaiBridgeCtx.onYield` → `tool_use:ask_pending` | **askRegistry → QuestionCard**(与轻量 track 同一条已验证链路;包装器本就按并发 session 设计) | answers 直接进 tool result,无 control_request |
  | AskUserQuestion(兜底:vendor 原生) | vendor 工具 `checkPermissions → behavior:'ask'` → `control_request{subtype:'can_use_tool', tool_name:'AskUserQuestion'}`——**与 Bash 权限同通道不同载荷** | 出口层按 `tool_name` 判别分流到 QuestionCard | `{behavior:'allow', updatedInput:{answers:{…}}}`(区别于 allow/deny) |
  | 普通权限(Bash/Edit…) | `control_request{can_use_tool}` | permissionRegistry(headlessPermissionBridge 复用) | allow/deny(+updatedInput 可选) |
  | MCP elicitation | `ElicitRequestSchema`(print.ts:1479),hook 先跑(:1443) | askRegistry 扩展形态 | ElicitResult |

  P1 验证点:print 每轮重建工具池时 compat 同名覆盖必须保持(盯 `assembleToolPool` 合并顺序);`--dangerously-skip-permissions` 在 inproc track 不使用(spawn track Phase A 因此丢失 AskUserQuestion,inproc 不允许重蹈——cliSpawn.ts:17 教训)。
  **✅ 已落地(P0.5,2026-08-27)**:compat 包装器 `resolveAskBridgeCtx` 使 sessionId **ALS 优先、全局指针回退**(轻量 track 行为不变);`startHeadlessPrintSession` 在 `runWithPrintSession` 内叠 `runWithSessionId(sessionId)`,整条 runHeadless 链(含 AskUserQuestion 执行与 `prompt.ask`/`prompt.permission` bridge)按异步链取自身 sessionId;zai `bridgeAskPendingToPromptAsk`/`bridgePermissionPendingToPromptPermission` 同步改 ALS 优先。测试:`test/unit/compat/askBridgeCtx.als.test.ts`(5 例,含双并发链)。工具池注入(`getOpenccBuiltinTools` 的 `tools[idx]=wrapper` 同名覆盖,createHeadlessContext-impl.ts:250)P1 接线时验证。
- **权限**:不再 `--dangerously-skip-permissions`;`canUseTool` 注入 zai `permissionRegistry`(headlessPermissionBridge 复用),三分路由见上表
- **非 turn 异步事件**(cron fire / proactive tick / inbox):原 spawn track 直接丢弃(SessionHost.ts:318-325);in-proc 下 sink 队列常驻可读 → 经 eventBus 推 SSE,补 runtime 事件类型
- **hooks 全层**:SessionStart 在实例创建时 fire(print.ts:5255 同款 `'startup'` 语义 → 自定义 `'resume'`),SessionEnd 在 dispose 时 fire——顺带解决 spec §7 路径 A 的缺口(此轨道天然覆盖)
- **`--rewind-files`/rewind**:print.ts:784-818/:4677-4705 现成逻辑挂到 session 实例方法,`removeSession` 之外新增 zai 路由 `/api/agent/rewind`(可后置)

## 6. 分阶段交付

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | vendor 手术:sink/onComplete/dispose-bag/全局态实例化,抽 `createHeadlessSession`;runHeadless 变薄壳 | `pnpm run build:core`;CLI 回归(`opencc -p` stream-json 输出 diff 一致);新增 vitest:两实例并发 run/abort/dispose 互不串 |
| P1 | `createPrintRuntime` 工厂 + 三态开关 + sessionFacade 复用 + translateSdkToRuntime 接线 + **steering 一期落地**(`OpenccRuntimeV2` +10 方法:`enqueue`/`interrupt`;routes/agent.ts inproc 轨道队列直通;前端 turn 中可输入+插话/打断按钮) | 10 方法契约单测;两 sessionId 并发 query 隔离(各自 permissionMode/model 不串);**turn 中 `'now'` 插话抢占 + interrupted-turn 自动续跑端到端用例** |
| P2 | destroy 三入口 + idle TTL + 并发上限 | removeSession 后 listener/timer 归零(leak 检测:process._getActiveHandles 前后对比);TTL 驱逐后再 query 自动 hydrate |
| P3 | 权限/elicitation 桥 + **用户交互三分路由**(§5 表:ask_pending→askRegistry / can_use_tool+AskUserQuestion→QuestionCard(updatedInput.answers)/ can_use_tool→permissionRegistry / elicitation→askRegistry)、cron 进程级单例路由、非 turn 事件出口、**空闲 CPU 断言**(§9.5) | /ego-browser 真机:两浏览器 tab 两会话并发对话、**并发 session 各自弹出 AskUserQuestion QuestionCard 互不串**、中途 enable plugin 当轮可见、配 SessionStart hook 验证触发 |
| P4(可选) | rewind 路由、proactive set_proactive 控制面 | 按需 |

## 7. 关键文件

| 动作 | 文件 |
|---|---|
| 手术 | `packages/zn-agent-core/src/opencc-src/cli/print.ts`(459/525/626/981/1029/1181/1972/2084/2857/3949/5063-5130/5255/5376 附近) |
| 手术 | `packages/zn-agent-core/src/opencc-src/cli/structuredIO.ts`(:459-467)、`utils/process.ts`、`utils/streamJsonStdoutGuard.ts`、`utils/gracefulShutdown.ts`(:39/:383/:413)、`utils/hooks/AsyncHookRegistry.ts`(:28/:281) |
| 新增 | `packages/zn-agent-core/src/opencc-src/server/createPrintRuntime-impl.ts` + types;`src/bundle-entry.ts` 导出 |
| 修改 | `packages/zai/src/server/services/agentRuntime.ts`(:65-69 三态解析、:460-493 分支) |
| 复用 | `compat/runtime/sdkEventAdapter.ts:46-314`、sessionFacade(RuntimeAdapter.ts:24-86)、permissionRegistry/askRegistry、`runWithSdkContext` |
| 退役不删 | `packages/zai/src/server/services/sessionHost/*`(spawn 模式保留) |

## 8. 风险与缓解

1. **print.ts 顶层 import 副作用**(LSP/plugin hooks/MACRO)假设单实例 → P0 先以双实例并发测试暴露;MACRO stub 已在 zai-server enableOpenccConfigs 预置,无需动
2. **store 不再共享** → permission mode / MCP 连接等跨 session 语义变化,需在 P1 单测显式覆盖"两会话不同 permissionMode";MCP client 连接池仍进程级共享(ctx.mcp)避免 N×连接风暴
3. **dispose 中途崩溃** → SessionEnd hooks 有 timeout 守卫(复用 getSessionEndHookTimeoutMs);dispose 幂等
4. **vendor 同步压力** → 所有 patch 带 `// zai patch` 注释锚点,升级 opencc 版本时按注释回放
5. **in-proc 无进程隔离**,一个实例 OOM/死循环影响整 server → idle TTL + 并发上限 + turn 级超时(复用 routes/agent.ts HARD_TIMEOUT 机制);保留 `spawn` 模式作为逃生口

## 9. 能力边界讨论(评审追加:状态获取 / 打断插入 / 隔离)

### 9.1 每个 REPL 状态的获取 —— ✅ 支持

- `AppState` store 是注入式:`runHeadless(input, getAppState, setAppState, ...)`(print.ts:461-462),由 main.tsx:2715 `createAppStateStore(...)` 建后传入,不读进程全局
- 只要 P1 落实"每 session 一个 store",`instance.getState()` 即返回该实例完整状态(messages / tasks / permissionMode / mcp / fileHistory / effort / cost…)
- 顺带修掉现 createOpenccRuntime 共享 `ctx.appState` 的跨 session 权限串扰问题
- `PrintRuntimeAdapter` 契约扩展:`getSessionState(sid): AppStateSnapshot`(只读投影,复用现有 profileProjection 序列化)

### 9.2 会话打断 / 插入(steering)—— ✅ 支持(print 强项,需扩契约)

print.ts 现成机制(正是 createOpenccRuntime 缺失的):
- **打断**:`abortController.abort('interrupt')`(print.ts:1177/:2009);SDK 下行 `subtype:'interrupt'`(:2982)
- **插队抢占**:`priority:'now'` 到达 → `getCommandsByMaxPriority('now')` 命中即 abort 当前轮(:2006-2009)
- **队列合批**:`enqueue/dequeue`(带 priority :4259)+ `while ((command = dequeue()))`(:2084)+ `canBatchWith`(:447)
- **打断续跑**:Auto-resuming interrupted turn(:1316-1329,interrupted_prompt 重入队)

**契约影响**(评审已决策:**第一期即启用 steering**):8 → 10 方法(`OpenccRuntimeV2 extends`):新增 `enqueue(sid, prompt, priority)` 与 `interrupt(sid, reason)`。zai `routes/agent.ts` 的 `sessionQueues`(turn-end drain-only)在 inproc 轨道下改为**直通实例队列**(facade 按 `'enqueue' in runtime` 探测分流):turn 中新 prompt 默认入实例队列 priority `'next'`,用户显式"插话"走 `'now'` 抢占打断;前端(P1)turn 进行中输入框不禁用,新增打断按钮。off/spawn 轨道维持现行为不变。

### 9.3 消息循环 / 后台任务 / 后台 Agent / 异步 Agent 隔离 —— ⚠️ 部分支持,一处硬坑

| 对象 | 载体 | 隔离性 |
|---|---|---|
| 消息循环 | `while(dequeue)` per-call 局部(print.ts:2084) | ✅ 天然 per-instance |
| 后台 bash | BashTool `run_in_background` 子进程,状态在 `AppState.tasks` | ✅(前提 per-instance store);dispose 须 cascade kill |
| 后台/异步 Agent | AgentTool `run_in_background`/`isAsync`(AgentTool.tsx:101/:232)→ `LocalAgentTask` in `AppState.tasks` | ✅ store 隔离,promise 绑实例 abortController |
| BackgroundRuntime 桥 | `globalThis.__zaiBackgroundRuntime` 单例(agentTaskBridge.ts:235) | ⚠️ 可共享——按 taskId 索引、事件带 parentSessionId,前提是 sessionId 传递不串 |
| **currentSessionId 桥** | **`globalThis.__zaiCurrentSessionId` 单指针**(agentTaskBridge.ts:221-224) | ❌ **并发覆盖**:A 会话后台 agent 完成时指针可能已切到 B → parentSessionId fallback 错拿、`<task-notification>` 回流错会话 |
| AsyncHookRegistry | module Map 全局 finalize(AsyncHookRegistry.ts:28/:281) | ❌ 跨 session 耦合(P0 已列 patch:加 sessionId 维度) |

**P0/P3 追加要求**:
1. `mirrorAttachTaskToBg` 的 parentSessionId fallback 从"读全局指针"改为**读 AsyncLocalStorage**(`runWithSdkContext({ sessionId })` 包裹每个 turn/agent loop;createOpenccRuntime-impl.ts:708-714 同款机制)——ALS 天然按异步链隔离,无覆盖问题
2. `dispose()` 的 cascade 定义(替代 spawn track"kill 进程一了百了"的免费隔离):
   - abort 实例 abortController → 传导至 in-flight ask()/toolExecution
   - kill `AppState.tasks` 中本实例所有 running 后台 bash 子进程与 async agent(复用 killAsyncAgent / TaskStop 路径)
   - `finalizePendingAsyncHooks(sessionId)`(P0 patch 后)
   - 后台任务未终态 → 标 `cancelled` 并 emit(前端 dock 不残留 running)
3. idle TTL 驱逐策略修正:**有 running 后台任务的实例不驱逐**(否则 dispose cascade 会杀掉还在跑的任务,与 TTL"用户无感"矛盾)——只驱逐全 idle 实例

### 9.4 结论

三问全部可在本方案内满足:Q1/Q2 依赖 P1 的 per-instance store + 契约扩到 10 方法;Q3 的硬坑只有两处(currentSessionId 全局指针、AsyncHookRegistry 全局 finalize),分别用 ALS 替代与 sessionId 维度化解决;后台任务隔离由 dispose cascade + "有任务不驱逐"策略兜底。

### 9.5 空闲 CPU 语义(评审追问:"退进程被干掉后 while(true) 会不会烧 CPU")

**不会。** 主等待是推模式挂起,不是忙等:

- `print.ts:3017 for await (structuredIO.structuredInput)` → `structuredIO.ts:242 for await (block of this.input)` → P0 工厂的 `createLineQueue()` 空闲时 `next()` 返回 **pending Promise**——无 timer、无轮询,epoll 挂起,CPU 0%
- `run()` 只在消息到达时被 `void run()` kick;turn 结束后回到 :3017 挂起
- 文件内唯二轮询循环都**有活动才存在**::2718 `while(true)`(仅 team-lead + 活跃 teammates,500ms sleep,停即 break)与 :2590 `do…while(waitingForAgents)`(仅有 running 后台任务/排队命令时 100ms sleep)——与 REPL 交互模式等价,spawn track 子进程同样在跑
- 常驻定时器风险清单:heartbeat(工厂默认不传 `heartbeatIntervalMs` → 不启动)、`Bun.gc` interval(Node-direct 下 `typeof Bun === 'undefined'` 不触发)、cronScheduler(P0 已 per-instance,**P1 改为进程级单例挂一次 1s tick**,按 sessionId 路由 fire,N session ≠ N tick)
- 空闲成本对比:inproc ≈ 挂起 Promise + store(几百 KB);spawn ≈ 常驻进程(~50-80MB RSS + 3 FD)——inproc 反而更省
- **P1 验收补一条**:双实例空闲 30min,进程 CPU 时间增量 ≈ 0(用 `process.cpuUsage()` delta 断言),且无意外活跃 handle(`process.getActiveHandlesInfo?.()` / 心跳 timer 计数)
