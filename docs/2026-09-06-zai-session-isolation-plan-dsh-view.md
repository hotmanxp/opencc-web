# [CliAgent dsh 方案] 从 dsh 内核视角重写 zai session 隔离 plan

## 一句话立场

`docs/2026-09-06-zai-session-isolation-plan.md` 在工程上可行但**根本性选错了战场**——它把整个隔离问题压在 opencc vendor 之内,用 26 处 zai patch + 22 项 hooks 镜像去撬动一个"单进程单 session CLI"的设计前提。dsh 微内核早就用 `SessionStore`(Cordis Service,`@deepseek-ai/dsh-session/src/index.ts:887`)+ 每 session 一个 `Inbox`(`@deepseek-ai/dsh-agent/src/inbox.ts:19`,`private state: { 'next-turn': [], 'next-step': [] }`)+ `agent.followup/steer/inject` 三通道(`@deepseek-ai/dsh-agent-loop/src/agent.ts:147`)原生解决了三维度问题。**三个关键修正**:(a) 应切到 dsh 轨道而非 patch opencc;(b) zai 当前对 vendor 的 22 项 React hooks 镜像(spec §3.2 表)在 dsh 是声明式事件订阅(`ctx.on('session/event', ...)`)+ Cordis 插件加载,无需命令式重写;(c) zai 已有 `SessionInbox`(per-session lane,`packages/zai/src/server/services/sessionInbox.ts:35-108`)就是 dsh `Inbox` 语义的镜像,双轨过渡期这一层可以保留作为 zai 侧 adapter。

## 1. 计划可行度评级

- **评分: 4 / 10**(工程实现可落地,但选错了"在哪个内核上解决 session 隔离")
- 维度拆分:
  - opencc patch 必要性: **2/10** —— vendor 是单 session CLI,硬塞多 session 等于与设计前提打架
  - dsh 替代可行性: **9/10** —— dsh 内核本就以"多 session + event-sourced log + Cordis 插件"为地基,适配成本远低于改 vendor
  - 双轨切换 ROI: **8/10** —— 仓库已规划 `dsh-kernel-batch-00~07`(2026-08-17),`agent.kernel: 'opencc'|'dsh'` 配置、`KernelAdapter` 接口、dsh-bridge 骨架都已写在 plan 里;本 plan 应作为 B1b/T1.6 的子任务而非平行工作

## 2. 我对 dsh 现有 session 隔离机制的发现(独立验证)

### 2.1 dsh 是否已有多 session 隔离

**有,且是设计核心,不是补丁。**

- **dsh 微内核的 session 抽象**:`SessionStore extends Service`(Cordis Service,`@deepseek-ai/dsh-session/src/index.ts:887`),通过 `ctx.sessions.create/get/list/fork`(`README.md:32-36`)对外提供;`create()` 会用 `ctx.effect` 把 lifecycle 绑到当前 fiber(README §Use,line 32-60)。
- **Cordis 框架的 ctx / session 关系**:`SessionStore` 构造里 `ctx.inject(['typert'], ...)` 把 typert 查找器注册进去(`@deepseek-ai/dsh-session/src/index.ts:893-901`),即 `SessionId` 类型在 RPC 调用栈内可被 Cordis context 自动解析。Cordis service 本身没有"per-session 隔离"开关,隔离由 `SessionStore` 这个 service + 每 session 一个 `Session` 实例 + fiber-bound lifecycle 共同保证。
- **dsh-* 子包中负责 session 隔离的包**(逐行溯源,非猜):
  - `@deepseek-ai/dsh-session` —— 核心 store + event-sourced log(`packages/core/session/`)
  - `@deepseek-ai/dsh-agent` —— `Inbox` 类(`packages/core/agent/src/inbox.ts:19-220`),每个 Session 实例自己的 next-turn/next-step 队列
  - `@deepseek-ai/dsh-agent-loop` —— `ReactLoopAgent`(`packages/core/agent-loop/src/agent.ts:70`)+ `wakeDriver()`(`agent.ts:184-205`)+ `phase.maintenance`(line 42-47),把 Inbox 与驱动状态机连起来
  - `@deepseek-ai/dsh-schedule` —— "Agent-scoped durable after, at, and fixed-rate reminders over the session event log"(package.json description),替代 vendor 的 cronScheduler 进程级
- **完全覆盖 plan 三维度**: ✅ 存储(per-session SessionStore + event log)、✅ 生产消费(per-session Inbox + wakeDriver 状态机)、✅ TUI/headless 循环(`ReactLoopAgent.kick()` 是 async generator,`phase: idle | running | maintenance` 三态,本身就是 turn-driven 单循环,不需要 30+ React hooks)。

### 2.2 dsh 与 opencc 的 session 机制对比

| 维度 | opencc | dsh |
|---|---|---|
| 单进程多 session | ❌ 设计前提即单 session(`messageQueueManager.ts:52` 模块级 singleton,`plan:30`) | ✅ `SessionStore: Map<SessionId, SessionEntry>`(`dsh-session/src/index.ts:888`) |
| commandQueue | `let commandQueue: QueuedCommand[] = []` 模块级(`opencc-src/utils/messageQueueManager.ts:52`) | ❌ 不存在;等价物是 `SessionStore` 的 event log + `Inbox.nextTurn/nextStep`(`dsh-agent/src/inbox.ts:24`) |
| inboxPoller | React hook `useInboxPoller.ts`,1000ms tick(`plan:498`) | ❌ 不存在;等价物是 Cordis `ctx.on('session/event', ...)` 订阅 |
| mailboxBridge | 进程级内存 + `appendFileSync` 文件 fallback(`plan:79`) | ❌ 不存在;等价物是 `agent/inbox/spliced` session event(`dsh-agent/src/inbox.ts` 全文),通过 Cordis dispatch 路由 |
| bg-daemon | Unix socket clientId 进程级(`daemon/mailbox.ts:99-105`) | ❌ 不存在;等价物是 `dsh-schedule` 的 agent-scoped 持久化提醒(描述见 package.json) |
| agentId 字段复用做 sessionId | 是(plan §1.4 核心 hack) | ❌ **不需要**;`SessionId` 是 first-class brand type(`dsh-session/src/index.ts:961`),不会"复用"任何字段 |

### 2.3 dsh 上游中现成的可复用模块

任务说 35 个 dsh-* 包,我实际在 `packages/` 扫到 **50+ 顶层 + 100+ 子包**(`packages/{session,subagent,interaction,jobs,spill,schedule,...}` 各 2-10 个嵌套),合 255 个 unique `@deepseek-ai/dsh-*` 命名(`grep -h '"name": "@deepseek-ai/dsh-' | sort -u | wc -l`)。与 session / queue / inbox / message 直接相关的:

- `dsh-session` / `dsh-session-format*` / `dsh-session-persistence*` / `dsh-session-projection*` —— 存储
- `dsh-session-query` / `dsh-session-query-sqlite` —— 倒序回放 query
- `dsh-agent`(`Inbox`)/ `dsh-agent-loop` —— 驱动与 inbox
- `dsh-schedule` —— 替代 vendor cronScheduler 进程级
- `dsh-spill`(`ctx.spillStore`)—— 替代 zai 的 `__zaiBridgeCtx.onYield` 大块文本路径
- `dsh-jobs` / `dsh-jobs-local` —— 长时任务,可替代 zai 的 `BashBackgroundTracker`
- `dsh-subagent-*`(in-process / fork / spawn / acp / claude-code / codex / dsh-sdk)—— 子 agent 全套

**zai 桥接层现状**:`packages/dsh-bridge/` 当前**在源码树里不存在**(只出现在文档 `docs/dsh/extension-cookbook.zh.md:4` 和 plan `docs/superpowers/plans/2026-08-17-dsh-kernel-batch-00..07` 的目标命名中)。仅 `packages/zn-agent-core/src/compat/subagents/dsh/`(`index.ts:1-60`)有 dsh **subagent** 的最小桥接(`spawn ds --profile sdk` 子进程),与 session 隔离无关。

## 3. 我重新设计后的方案

### 3.1 核心方案选择

- 选项 A:在 opencc 上 patch(plan 当前方案)—— **拒绝**
- 选项 B:切到 dsh 轨道(`agent.kernel: 'dsh'`)—— **强烈推荐**
- 选项 C:双轨并行,按场景路由(默认 dsh,遗留/特殊功能回退 opencc)—— **推荐作为过渡形态**

**我推荐: C(过渡)→ B(终态)**。

**理由**:

1. 仓库已有完整双轨骨架 plan(`docs/superpowers/plans/2026-08-17-dsh-kernel-batch-{00..07}.md`),且 `Batch 0` 明确定义 `agent.kernel: 'opencc'|'dsh'` 配置与 `KernelAdapter` 接口(batch-00 §3.2)。本 plan 的 session 隔离问题应作为 `Batch 1b/T1.6` 的子任务,而非平行工作。
2. plan 的 26 处 zai patch 全部针对 vendor 内核调用栈内调用方(`messageQueueManager.ts`、各种 `Task.tsx`),dsh 轨道无 vendor、无 commandQueue、无 React hooks、无 bg-daemon——**根本不存在要 patch 的目标**。
3. zai 已有的 `SessionInbox` per-session lane(`sessionInbox.ts:35-108`)+ `__zaiSessionInbox` globalThis 桥(`agentRuntime.ts:145-150`)+ `inboxBridge.ts`(`compat/inboxBridge.ts` 全文)就是 dsh `Inbox` 的"zai 镜像",双轨期保留 zai 侧 adapter 零代价,新 dsh 轨道直连 dsh `Inbox` 即可。

### 3.2 如果选 dsh(选项 B/C),具体方案

- **dsh 子包使用清单**(zai 侧 `packages/dsh-bridge/src/`):
  - `@deepseek-ai/dsh-session` + `@deepseek-ai/dsh-session-persistence-jsonl`(存储)替代 opencc `commandQueue` + `~/.zai/sessions/<sid>.jsonl`
  - `@deepseek-ai/dsh-agent` + `@deepseek-ai/dsh-agent-loop`(驱动)替代 vendor `createOpenccRuntime`
  - `@deepseek-ai/dsh-schedule`(cron)替代 vendor `cronScheduler.ts`
  - `@deepseek-ai/dsh-subagent-fork-in-process`(子 agent)替代 plan §2.1 的 26 处 vendor `enqueuePendingNotification` patch
  - `@deepseek-ai/dsh-jobs-local`(长任务)替代 `BashBackgroundTracker`(`agentRuntime.ts:285` 注释掉的死代码,plan §6 决策要求修复)
- **zai 桥接层改造**:
  - 在 `packages/dsh-bridge/src/createDshRuntime.ts` 装载 Cordis `Context`,挂上述 5 个包
  - `KernelAdapter.run()`(`packages/zai/src/server/services/kernel/factories/dsh.ts`,新)实现 `ctx.agents.create({ sessionId, ... }) → await agent.whenIdle() → agent.followup() → yield events`(`Batch 1/T1.2`)
  - 把现有 zai `SessionInbox.followup/inject` 桥到 dsh `agent.followup/inject`(语义已对齐:`sessionInbox.ts:1-13` 注释明确"对齐 DSH packages/core/agent-loop/src/agent.ts:113-132")
- **数据迁移**:opencc 轨道 `<sessionId>.jsonl` → dsh `SessionStore` event log;**新装 dsh 轨道,不迁旧 session**(`Batch 1/T1.7` + plan `Batch 0/T0.6` 双 namespace 约定)
- **兼容性策略**:opencc 轨道过渡期 6 个月,`agent.kernel: 'opencc'` 默认不变,新部署可主动切 `'dsh'`;`sessionHost/SessionRegistry.ts`(zai 已有)按 `kernel` 字段分流

### 3.3 如果继续 opencc patch(选项 A),需要修正什么

- **砍章节**: §1.4 "复用 vendor `agentId` 字段做 sessionId"(整个维度 1 核心 hack)、§2.1 全部 26 处 vendor 调用方 patch 列表(改为 §3.5 评估切 dsh)
- **补章节**: §1.5 实施清单的 1.3(bg-daemon clientId per-session)、1.5/1.6(mailbox bridge sessionId)合并为"评估是否切 dsh 替代"
- **可规避风险**: rebase 冲突(全删)、维护成本(全删)、29/30 hook 不一致(无需修,dsh 没有这个问题)

### 3.4 双轨切换 ROI

- **工作量估算**:
  - plan A(26 vendor patch + 22 hook 镜像 + bg-daemon + 8 类 inbox 解析):**~4 人周** + 持续 rebase 维护
  - plan C/B(走 dsh-kernel batch-01/02/03):B1a 1 周(已规划)+ B1b 1 周(事件翻译,SSE)+ 本 plan 仅需追加"B1c session 隔离验证",**~0.5 人周**(因为 dsh 已隔离,只需 e2e 验证)
- **风险对比**:
  - plan A 风险:vendor 上游 rebase、agentId 字段语义污染 React hook test、3 个独立 patch 互相耦合(`toolUseContext.agentId` 改一处影响 26 处)
  - plan C 风险:dsh rc.7 API 可能变(plan A 风险 0,plan B 风险独有,但 dsh-bridge 是隔离层,可独立冻结版本)
- **时间线**:plan A 2-3 周完成 + 持续维护成本;plan C 1-2 周完成 + 零持续维护(由 dsh 维护方承担)

## 4. 我会砍掉的章节

- §1.4"复用 vendor agentId 字段做 sessionId"——理由见 §3.3,这是 plan 的核心 hack,在 dsh 视角下根本不需要
- §2.1"26 个调用方 zai patch 替换"(plan:181-225 整表)——同上,26 处 patch 在 dsh 轨道全部不存在
- §3.4"三个 headless 选项的抉择"(plan:398-406,选项 A/B/C)——zai 主路径选 `createOpenccRuntime` 的"评估"无意义,直接委托 dsh `ReactLoopAgent`
- §6.2"为何不全部 zai 镜像而要 zai patch vendor"(plan:528-535)——这是 plan A 的内部分歧,选 B/C 后整表作废

## 5. 我会新增的章节

- **dsh vs opencc 隔离机制对比**(我已在 §2.2 给出)
- **双轨切换决策矩阵**:`agent.kernel` 字段(已有)+ 何时 `'opencc'` vs `'dsh'`(默认 `'opencc'`,新部署/AI 长任务场景推荐 `'dsh'`)
- **dsh 子包选用清单**(我已在 §3.2 给出 5 个核心 + 3 个替代包)
- **SessionInbox 双轨桥接表**:zai `SessionInbox.followup/inject/wakeHandler` ↔ dsh `agent.followup/inject/wakeDriver` 一一映射(语义已对齐,见 `sessionInbox.ts:1-13` 注释)
- **dsh event log 11 组映射表**(Batch 1/T1.3 提到的 11 组事件 → zai SSE 事件组)——本 plan 完全没提的事件映射,实际是双轨切换的最大工作项

## 6. 实施顺序(我的版本)

1. **Week 0**(并行):完成 dsh-kernel `Batch 0`(已有 plan,无需本 plan 重复);产出 `agent.kernel: 'opencc'|'dsh'` 配置 + `KernelAdapter` 接口
2. **Week 1**:`Batch 1a`(已有 plan);产出 dsh 轨道最小对话闭环
3. **Week 1.5**(本 plan 核心增量):在 `packages/dsh-bridge/src/` 写"session 隔离验证套件"——**不是改 vendor**,是验证 dsh 轨道下多 session 互不窜(2 session × 8 场景 e2e,直接复用 dsh `ctx.sessions.create/get` + `Inbox`)
4. **Week 2**:`Batch 1b`(已有 plan);事件翻译 + SSE + abort
5. **Week 2.5**(可选):把 zai 已有 `SessionInbox` 适配成 dsh `Inbox` 的"zai-side 镜像",让 opencc 轨道下也享受双 lane 语义(已经基本实现,只需注释收口)

## 7. 风险与缓解(我的版本)

- **dsh 切换风险**:rc.7 API 不稳 → `Batch 0/T0.5` 用 `save-exact` 锁版本 + dsh-bridge 是隔离层 + `agent.kernel: 'opencc'` 永远可回退
- **opencc patch 风险**(plan A 独有):26 处 vendor patch rebase 冲突 → 本 plan 不引入
- **双轨过渡期风险**:opencc 与 dsh 数据不互通 → `Batch 0/T0.6` 已定独立 namespace(`tasks-dsh/` vs `tasks/`),不需要本 plan 处理
- **plan A 没识别的新风险**:zai 已有 `SessionInbox` 与 dsh `Inbox` 语义对齐但 **class 名重复**(`SessionInbox` zai 侧 vs `Inbox` dsh 侧),未来 import 时容易混淆,需要 alias `@zn-ai/zai-inbox` ↔ `@deepseek-ai/dsh-agent#Inbox`(本 plan 提此风险,plan A 完全没提)

## 8. 我认为最关键的 3 个判断点

1. **切 dsh vs 留 opencc 的决策点**:`Batch 0/T0.1~T0.7` 已就位(配置、KernelAdapter、dsh-bridge 骨架、双 namespace、engines 升级),**门槛已过**;继续在 opencc 上做 26 处 vendor patch 是在已经造好的桥旁边重新摆渡
2. **双轨如何共存**:`agent.kernel` 字段(已有)+ zai `SessionInbox` ↔ dsh `Inbox` 桥接(语义已对齐,见 `sessionInbox.ts:1-13` 注释),不需新抽象
3. **数据迁移策略**:**不迁**。opencc 旧 session 留在 `~/.zai/projects/<cwd>/<sessionId>.jsonl`,新 dsh session 走 `dsh-sessions/<sessionId>/`(`Batch 0/T0.6` 约定),用户主动 `--kernel=dsh` 时才进新空间
