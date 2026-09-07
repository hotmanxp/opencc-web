# [CliAgent dsh 方案 v2] 从 dsh 内核知识视角客观评估 zai session 隔离 plan

## 一句话立场

本 plan 是一份扎实的 opencc 轨道工程方案,**前提是接受"多 session 服务压单 session CLI"的设计摩擦**;它没有(也不需要)切 dsh 轨道。我从 dsh 内核知识(基于 `docs/superpowers/plans/2026-08-17-dsh-kernel-batch-*.md` 8 份 main-dsh 分支的 plan 设计文档,而非假设 dsh-bridge 在当前 main 上可用)提供两层增量价值:(a) **概念借鉴**——dsh 的 SessionStore / Inbox / wakeDriver 三件套可以作为 zai 当前 `SessionInbox` 抽象的"设计锚",帮 plan 在 vendor patch 之外多一道防线;(b) **未来兼容性评估**——若某天 main-dsh 合入,plan 的 vendor patch 不会"白做",但需要一个明确的"kernel adapter 层"边界。

## 0. 关键事实自检(放在最前)

- 当前 HEAD: `251309eff836a3ea935ffa4aa59d231858fb93b4` on `main`
- working tree 中 `packages/`: `zai/`, `zn-agent-core/`(`ls packages/` 实测)
- `packages/dsh-bridge/` 在当前 main HEAD: **不存在**(`ls packages/dsh-bridge` 报 `No such file or directory`)
- dsh 相关代码所在分支: `main-dsh`(git log 显示存在 `0f2445dd` 等 dsh 轨道 commit);当前 main 没有这些 commit
- plan 文档是否提及 dsh-bridge: 0 匹配(`grep -c "dsh-bridge" docs/2026-09-06-zai-session-isolation-plan.md` = 0;`grep -n "dsh"` 也 0 匹配)
- plan 的核心引文: `docs/2026-09-06-vendor-message-system.md` + spec `2026-08-27-zai-headless-runtime-vs-vendor-repl-comparison.md`,不涉及 dsh

## 1. 计划可行度评级

- **评分: 7 / 10**(在 opencc 轨道约束下,设计自洽;扣分在 vendor patch 风险与未来兼容边界)
- 维度拆分:
  - vendor patch 合理性: **6/10** —— 方案 26 处调用方替换是必要代价,但 patch 维护面不可忽视
  - dsh 概念借鉴度: **8/10** —— plan 已隐含 per-session lane 设计,dsh 的 Inbox 语义可显式对齐
  - 未来兼容性: **5/10** —— 切 dsh 轨道时 `zaiEnqueue` / `toolUseContext.agentId` patch 等层需隔离/替换

## 2. dsh 内核知识对 plan 的客观借鉴

### 2.1 dsh 微内核的 session 隔离设计(只谈设计,不说"应切")

dsh 设计文档(`docs/superpowers/plans/2026-08-17-dsh-kernel-batch-03-session-memory.md` §3 + batch-00 §T0.2)呈现三件套:

- **SessionStore**(Cordis Service,`packages/core/session/`):`ctx.sessions.create/get/list/fork`,event-sourced log 持久化到 `<dataDir>/projects/<cwd>/dsh-sessions/<sessionId>/`,每个 session 独立目录
- **Inbox**(per-session 队列,`@deepseek-ai/dsh-agent/src/inbox.ts`,**`private state: { 'next-turn': [], 'next-step': [] }`**)——**两个 lane,完全对应 zai `sessionInbox.ts:35-108` 的 `nextTurn / nextStep` 双车道**
- **wakeDriver / phase.maintenance**(`@deepseek-ai/dsh-agent-loop/src/agent.ts`):`phase: idle | running | maintenance` 三态机,把 Inbox 中的 `followup / steer / inject` 事件驱动到下一个 turn

**对 plan 的启发**:

- plan §1.2 已正确识别 zai `SessionInbox`(per-session lane)是已实现的关键隔离能力(dsh Inbox 与之同构)
- plan §1.4 "复用 vendor `agentId` 字段做 sessionId" 的核心洞察,在 dsh 设计中对应"session identity 即第一公民"——dsh 不需要复用 vendor agentId,因为 SessionStore 第一类对象就是 Session
- **可借鉴的命名与心智模型**:plan 可在 `sessionInbox.ts` 顶部加一行注释,明确"本模块语义对齐 dsh `Inbox`(per-session next-turn / next-step lanes,followup / steer / inject 事件通道)",便于未来切 dsh 轨道时直接迁移 adapter,不需要重写 zai 侧 lane

### 2.2 plan 的 26 处 vendor patch 方案,从 dsh 设计原则看是否合理

**dsh 原则**:Cordis 插件框架按"能力 seam"切 concern(`create-dsh-plugin` 技能描述:tools/commands/fs/llm/subagent 都通过 ctx 注入),**任何 session-aware 行为通过 ctx scoped 设计,而非全局单例**。

**plan 的对应**:
- **concern 隔离层面**:plan 把"消息队列 session 路由"独立成一个 wrapper(`messageQueueAdapter.ts`),让 26 个调用方通过 wrapper 拿到 sessionId——这是正确的"接口隔离"做法,对应 dsh 的 `ctx.tools` / `ctx.commands` 注入模式
- **`__zaiBridgeCtx` 全局单例 vs ctx scoped**:plan `agentRuntime.ts:178` 暴露的 `__zaiBridgeCtx` 是 globalThis 单例(`agentRuntime.ts:145-150` 的 `__zaiSessionInbox` 也是)。从 dsh 视角看,**全局单例在多 session 服务里是反模式**——但 plan 没有真的在多 session 间共享可变状态:`__zaiBridgeCtx.onYield` 等回调是函数引用,SessionStore 里的 per-session `QueryEngine`(`createOpenccRuntime-impl.ts:577-625`)和 `queryAbortControllers`(`createOpenccRuntime-impl.ts:561-565`)已经按 sessionId 分发——所以全局单例只承载"函数指针 + 不变量",**不承载 session 状态**。这是可接受的妥协,不是设计缺陷
- **vendor patch 粒度**:plan 26 处替换是"调用方替换"(import + 调用名),不改 vendor `enqueuePendingNotification` 签名;这是**侵入面最小化**,符合 dsh 的"extension point"理念(改 1 个 seam,而不是改 N 个内部文件)。**26 这个数字偏大但不可避免**——opencc 设计前提是单 session CLI,vendor 内部把"我正在为哪个 agent 服务"散落在调用方

### 2.3 plan 是否应考虑未来切 dsh 轨道的兼容性

**当前 main 没有 dsh-bridge,但 plan 应预留接口**:
- plan §3.4 提到选项 A "`ZAI_OPENCC_CLI=1` spawn `opencc -p` 子进程"、选项 B "扩展 OpenccRuntimeV2 契约"——这里有一个**没明说的第四选项**:选项 D "未来 `agent.kernel='dsh'` 时,`zaiEnqueue` / SessionInbox 这一层下沉到 dsh bridge"
- 兼容性边界:plan 的 zai 层代码(`messageQueueAdapter.ts` / `sessionInbox.ts` / `inboxMessageHandler.ts` / `inboxReminder.ts` / `subagentNotifier.ts`)**全部可复用**——这些是 session 隔离的"业务侧",与具体 kernel 无关。**vendor patch 部分会在切 dsh 时失效**(不再需要 patch vendor `enqueuePendingNotification`),但补丁是 forward-compatible 的(在 opencc 轨道有效期间一直有效)

## 3. 我重新设计后的方案

### 3.1 核心方案

承认"当前 main HEAD 没有 dsh-bridge",plan 必须用 opencc patch。我会做三处**对 plan 的微调**(不否定主线):

1. **把"vendor patch 替换 26 个调用方"重新框定为"opencc 轨道专属优化"**,在 plan 顶部新增一行 `Kernel 适用范围: opencc(默认);切 dsh 轨道后本节内容作废,但 zai 层 wrapper 保留`
2. **`zaiEnqueue` wrapper 不内嵌到 vendor 调用方替换清单里**——把它作为 **zai 公共层**(`packages/zai/src/server/services/`),未来切 dsh 时由 `dsh-bridge` 提供等价物(`createDshRuntime` 内置 sessionId 路由,不需要 wrapper)
3. **Phase 1.4 的 e2e 测试必须包含"多 session 并发下 zaiEnqueue 不窜"**——plan §Phase 1.4 已经写,但要加一个 assertion:`sessionB` 触发的 bash 完成不能进入 `sessionA` 的 mid-turn drain

### 3.2 dsh 概念借鉴

- **SessionStore per-session lane 设计**:plan 已经隐含(§1.3、§7 的 `SessionInbox` 双车道表);**建议显式标注对齐 dsh Inbox 语义**(`sessionInbox.ts` 头部注释 +1 行)
- **Inbox wakeDriver 状态机**:**不**应作为 plan 的主参考(plan 是 imperative + headless,不跑 dsh 的 React loop agent 状态机);但 `nextTurn / nextStep` 的语义可借鉴——plan §3.5 的 `for await query` 真循环,本身就是 wakeDriver 的简化版
- **wakeDriver 概念的 zai 镜像**:zai `agentRuntime.ts:178` 的 `__zaiBridgeCtx.onYield` 在事件驱动层等价于 wakeDriver 的 `kick()`——当 sessionInbox.lanesFor(sid).nextTurn 不空时,触发 `runNextInQueue(sid)`。plan §3.6 已经在做这件事,无需新设计

### 3.3 未来兼容性

如果未来切 dsh 轨道(`agent.kernel='dsh'`):

- **可复用(零迁移成本)**: `sessionInbox.ts` / `inboxReminder.ts` / `subagentNotifier.ts` / `bashNotifier.ts` / `inboxMessageHandler.ts` / `routes/agent.ts:801 runNextInQueue` / `__zaiBridgeCtx` 框架——这些是 zai 业务侧
- **需要返工**: `messageQueueAdapter.ts` 的 `zaiEnqueue*`(dsh bridge 自带 sessionId 路由)、§2.1 的 26 处 vendor patch(不需要了)、`toolUseContext.agentId = sessionId` patch(由 dsh `toolUseContext` 自然提供)
- **不影响**: zai 前端 React UI(zai web 永远在 zai 侧)、SSE 推流(`__zaiBridgeCtx.onYield` 通道不变,只是 event 来源从 vendor 切到 dsh)

## 4. 我会砍掉的章节

plan 当前没有基于错误前提的章节——它**完全没提 dsh**,这本身就是基于正确前提(plan 知道自己写在 main HEAD 上,main 上没有 dsh-bridge)。**不需要砍**。只需在文档顶部加一句"本方案基于 opencc 轨道;切 dsh 轨道后的兼容边界见 §3.3"。

## 5. 我会新增的章节

- **§0 关键事实自检**(类似本评估文档的 §0,声明 main HEAD / dsh-bridge 不存在 / plan 不依赖 dsh)
- **§3.7 概念对齐说明**:明示 zai `SessionInbox.nextTurn / nextStep` 与 dsh `Inbox` 的对应关系,便于读者用 dsh 心智理解 zai 设计
- **§7 兼容性边界表**:zai 业务侧 vs vendor patch vs bridge 层三栏,标明未来切 dsh 时哪些可复用、哪些需返工

## 6. 实施顺序(基于当前 main 真实状态)

**Phase 1(P0, 1 周)**: `messageQueueAdapter.ts` wrapper(zai 层)+ `toolUseContext.agentId = sessionId` patch(`packages/zn-agent-core/src/compat/repl/createReplSession.ts:486-536`)+ **收敛 26 处调用方 patch 到 Phase 1.5**(单 PR 不易 review,建议拆成 4 个子 PR 按目录:tasks/* + utils/* + hooks/* + commands/components/*)+ Phase 1.4 e2e 测试

**Phase 2(P1, 1-2 周)**: BashNotifier dead code 修复(`packages/zai/src/server/services/bashNotifier.ts`)+ bg-daemon per-session clientId patch(`packages/zn-agent-core/src/opencc-src/utils/daemon/mailbox.ts:99-105`,实测 getReplClientId 是模块级 singleton)+ `useInboxPoller` sessionId 路由(`packages/zn-agent-core/src/opencc-src/hooks/useInboxPoller.ts`,实测文件存在)

**Phase 3(P2, 2 周)**:补 30+ React hooks 镜像或 vendor patch(`useMailboxBridge` 等)+ `OpenccRuntimeV2` 扩展评估

## 7. 风险与缓解

- **zai patch 与 vendor 上游同步冲突**(plan §6.1 已列):**评估同意**;补丁注释 `// zai patch (YYYY-MM-DD, plan Px): ...` 必须机器可解析(`scripts/` 加一个 `vendor-patch-extract.ts` 工具,扫所有 zai patch 注释生成 manifest,rebase 时 git grep 定位)
- **Phase 1.4 e2e 测试 flake**(plan 未列,但实操高发):bash 后台完成的多 session 测试要用 `Promise.race([sessionA turn complete, sessionB midturn event])` 防 race;测试里直接禁用 `cronScheduler`(`disableCronInTest` flag,已在 setupCronScheduler 里有 stub 空间)
- **`toolUseContext.agentId` 改动影响 vendor 主线程判断**(plan §6.1):vendor 主路径(`query.ts:2666-2678`)的 `isMainThread` 判断依赖 `querySource`,zai `querySource='server-repl'` 会让 isMainThread=true,但 zai 的所有 cmd 都有 agentId(`zaiEnqueue` 自动注入),**不**进入 `cmd.agentId === undefined` 分支——plan §2.2 消费者 1 路段已经分析清楚,这条不构成风险
- **`sharedOpenccRuntimeSingleton` 进程级共享**(plan §1.3 `⚠️` 行):实测 `packages/zai/src/server/services/agentRuntime.ts:696` 是模块级 holder,但 query 入口按 sessionId 分发(`createOpenccRuntime-impl.ts:577-625` 每 session 独立 vendor engine),不构成实际隔离风险

**不再谈** "切 dsh 轨道的风险"(当前 main 上不存在);**也不再谈** "26 处 vendor patch 的 vendor 内部行为变更风险"(plan §6.2 已充分讨论)。

## 8. 我认为最关键的 3 个判断点

1. **当前 main 上 plan 是否可行**: **可行**。三维度自洽,vendor patch 粒度合理,Phase 1 4 个 P0 任务可在 1 周内完成。26 处调用方 patch 是大工程,但属于"一次性投资,长期受益"——切 dsh 轨道前一直有效。
2. **dsh 概念借鉴的价值**: **中等**。plan 已经在 vendor 约束下达到当前设计的近似最优(SessionInbox 双车道已经隐含 Inbox 语义);dsh 心智的最大价值是给 plan §7 加一行注释"本模块对齐 dsh Inbox 语义",便于未来维护者切换轨道时识别"哪些是 vendor 临时适配,哪些是 zai 永久抽象"。
3. **未来兼容性边界**: **清晰**。zai 业务侧零迁移,vendor patch 层失效,between 这两层需要新增 `kernelAdapter` 边界——plan §3.4 已隐含这个方向,只需在 §7 加一张表显式声明。

## 评估依据(grep 实测)

- `packages/` 只有 `zai/` `zn-agent-core/`,无 `dsh-bridge/`(`ls packages/` 实测)
- plan 引用文件 7/10 实测存在;`tasks/LocalShellTask/LocalShellTask.tsx`(plan 写的 `LocalShellTask.tsx`)、`utils/task/framework.ts`(plan 写的 `tasks/framework.ts`)、`commands/ultraplan.tsx`(plan 写的 `tasks/ultraplan.tsx`)是真实路径(plan 的简短路径形式不完全精确,但文件确实存在)
- `enqueuePendingNotification` 在 vendor 中实测 18 个文件 42 处调用;plan 数的"26 处"是按"独立调用点(行)"算,实测 grep -c 是文件级 18、调用点级 ~30+,plan 的估算在合理量级
- `messageQueueManager.ts:52` 实测是 `const commandQueue: QueuedCommand[] = []`(模块级 singleton,符合 plan 描述)
- `query.ts:2670-2678` 实测 mid-turn drain 位置准确
- `daemon/mailbox.ts:99-105` 实测是 `getReplClientId()` 模块级 UUID singleton,符合 plan 描述
- `agentRuntime.ts:696` 实测是 `if (!sharedOpenccRuntimeSingleton) sharedOpenccRuntimeSingleton = sharedRuntime`,符合 plan 描述
- `createOpenccRuntime-impl.ts:577-625 / 561-565` 实测是 per-session engines / AbortController Map,符合 plan 描述

未独立验证(标注以避免误导):plan 引用的 `query.ts:708-712` 的 `runExtraReminderProviders(getSessionId())` 与 `query.ts:2660` 的 sleepRan `'later'` 降级——未做行级实读,仅按 plan 描述引用。
