# 任务工厂（Task Factory）设计

日期：2026-09-01
状态：design-confirmed（经 brainstorming 会话确认）

## 背景与目标

用户需要在 zai 内实现一个「任务工厂」：以文件为载体的任务生命周期管理
（新建 → 队列 → 执行 → 验收 → 完成），配一个专门的 Web 调度面板和一名
**任务任务调度官 Agent**。任务调度官 Agent 负责与用户详细讨论需求（走 brainstorming
skill）、把需求落库为任务文件、分派执行、验收成果。

关键决策（brainstorming 已确认）：

| 决策点 | 结论 |
|---|---|
| 执行机制 | 任务调度官派生执行子 Agent（AgentTool → local_agent 后台任务），子 Agent 在任务目录工作、更新 process.md |
| 暂停/继续 | 原地冻结（任务留 processing，kill 执行子任务，保留其会话）+ resume 原会话重新委派 |
| AI 托管 | 后端事件驱动调度 + 按需唤醒任务调度官做分派/验收；不常驻任务调度官 |
| 页面布局 | 常驻任务调度官对话区 + 任务面板分屏；新建任务弹窗复用任务调度官会话对话流 |
| 执行 Agent | 任务创建时任务调度官写入 index.md 的 `agent` 字段，执行时按此派生 |
| 页面形态 | `/super-tasks` 顶层路由，脱离 Layout、无菜单，只有任务相关 UI |

## 总体架构

```
┌─ Web /super-tasks（顶层路由，脱离 Layout）───────────────┐
│  左: 常驻任务调度官对话区（固定 session，agent=task-factory） │
│      └ 新建任务弹窗 = 对话区内的快捷对话流              │
│  右: 三栏面板 队列 / 执行中 / 已完成 + 操作条           │
│      任务详情抽屉（展示执行子 Agent 过程）              │
└──────────────┬──────────────────────────────────────────┘
               SSE: task_factory.* 事件 + 现有 task 事件
┌─ zai 服务端 ────────────────────────────────────────────┐
│  routes/superTasks.ts   REST API                        │
│  services/taskFactory.ts 文件系统 CRUD + 事件 + 状态机   │
│  任务调度官 session（transcript 持久化）                      │
│    └ 唤醒注入 → 任务调度官用 AgentTool 派生执行子 Agent        │
└──────────────┬──────────────────────────────────────────┘
       ~/.zai/task-factory/
        ├── queue-tasks/<id>/     {index.md, docs/plan.md, docs/spec.md, process.md}
        ├── processing-tasks/<id>/
        └── finished-tasks/<id>/
```

## 任务文件模型

文件系统是唯一事实源。目录位置即状态：

- `~/.zai/task-factory/queue-tasks/<id>/` → 排队（任务池）
- `~/.zai/task-factory/processing-tasks/<id>/` → 执行中 / 已冻结（paused）
- `~/.zai/task-factory/finished-tasks/<id>/` → 完成

`<id>` 形如 `tf-xxxxxxxx`（8 位 hex，参考 `generateTaskId` 的字母表风格）。

### index.md（任务入口，frontmatter 承载元数据）

```markdown
---
id: tf-xxxxxxxx
title: 任务标题
status: queued            # 冗余字段，目录位置才是权威状态
cwd: /abs/to/project      # 任务所在工程目录（绝对路径）；不同任务可落在不同代码工程，
                           # 委派执行子 Agent 时以它作为执行环境的 cwd
agent: claude-code         # 执行子 Agent 用谁（任务调度官创建对话中决定；claude-code/dsh，或内置 agent 名）
createdAt: 2026-09-01T10:00:00+08:00
startedAt: null
completedAt: null
executorTaskId: null      # 任务调度官派生执行子 Agent 后回填的 BackgroundTask id
                           # (供暂停 kill 与详情抽屉订阅执行过程)
parentSessionId: ...       # 可选：创建该任务的任务调度官道话 session
---

# 任务描述

（任务调度官与用户讨论后的一句话/一段目标描述）
```

### 目录内文件

| 文件 | 职责 | 由谁写 |
|---|---|---|
| `index.md` | 任务入口 + 元数据 | 任务调度官（SuperTasksCreate 初始化） |
| `docs/spec.md` | 需求规格（brainstorming 讨论结果落库） | 任务调度官 |
| `docs/plan.md` | 执行计划（拆分步骤） | 任务调度官 / 执行子 Agent 细化 |
| `process.md` | 执行进度日志：时间戳 + 步骤 + 结论，里程碑标记 `## [MILESTONE]` / 结尾 `## [DONE]` | 执行子 Agent 追加 |

`process.md` 的 `[DONE]` 标记是后端判定「完成」的约定信号；`[MILESTONE]` 是
唤醒任务调度官做阶段检查的信号（本期可选，先手动验收）。

## 任务任务调度官 Agent

### 注册

- 新增内置 main agent `task-factory`（如 `mainAgents-taskFactory.ts`），在
  `agentRegistry.loadBuiltinAgents()` 注册（`mainAgents.ts:93` 处加入）。
- `slots.systemPrompt`：描述职责——需求讨论走 brainstorming skill；需求清楚后
  调用 `SuperTasksCreate` 落库；派发执行；按 `process.md` 验收并
  `SuperTasksMarkDone`。
- `slots.tools`：在默认工具基础上新增两个专用工具。

### 委派执行（重要决策：优先 SpawnAgent）

**执行子 Agent 的委派优先走 `SpawnAgent`（外置 CLI agent，`subagent_type`
为 `claude-code` / `dsh`，即 index.md 的 `agent` 字段），`SpawnAgent` 是默认
工具池已有工具**（`compat/tools/opencc/SpawnAgentTool.ts`，输入
`{description, prompt, subagent_type, model?, cwd?, name?, team_name?}`，
异步返回 `task_id`，完成后通知任务调度官）。仅当对应 provider 未注册/不可用时，
回退内置 `AgentTool`（`subagent_type` 用内置 agent 名）。

**执行器工作目录 = 任务的工程目录（index.md 的 `cwd` 字段）**（2026-09-01 用户追加）：
不同任务可落在不同代码工程，创建任务时必须记录工程目录；委派执行子 Agent 时把该
`cwd` 作为执行环境：
- SpawnAgent 路径：`cwd` 参数 = 任务 `cwd`（绝对路径）；
- AgentTool 回退路径：prompt 里显式声明任务 `cwd`（绝对路径）并要求在其中工作。

**执行器 transcript 归拢到任务目录**（`~/.zai/task-factory/processing-tasks/<id>/`）：
core `getAgentTranscriptPath`（`utils/sessionStorage.ts:572`）打小补丁——`transcriptSubdir`
若为绝对路径则直接作为 transcript 根目录（原实现只拼在 `projectDir/sessionId/subagents/`
下，无法指向任务目录）；任务调度官委派时把绝对任务目录作为 transcript 位置传入
（AgentTool 路径传绝对 `transcriptSubdir`；SpawnAgent 路径的 zai 侧 task 记录/output
文件自然落在任务目录附近）。CLI 子 agent（claude-code CLI）自己有独立 transcript
存储，无法被 zai 侧重定向——其 cwd 为任务工程目录，保证工程级隔离。

### 新增工具

| 工具 | 入参 | 行为 |
|---|---|---|
| `SuperTasksCreate` | `{title, description, agent?}` | 唯一入口创建任务：生成 id，创建 `queue-tasks/<id>/` 目录与 `index.md`/`docs/plan.md`/`docs/spec.md`/`process.md` 骨架，emit `task_factory.created` 事件。重复创建由 id 幂等防护 |
| `SuperTasksMarkDone` | `{id}` | 任务调度官验收通过：更新 index.md（status=done、completedAt）、把目录从 processing 移到 finished、emit `task_factory.finished` |

执行中的常规文件操作（写 spec/plan/process.md）直接复用内置 Edit/Write/Bash/Read
——任务目录就是普通文件。brainstorming skill 通过既有 SkillTool 即可调用，无需额外接线。

## 后端服务与路由

### services/taskFactory.ts

纯文件系统 + 事件层，不碰 LLM。**文件操作实现放 core 侧**
（如 `opencc-src/server/taskFactoryFiles.ts`，供 agent 工具与 zai 路由共用——
`SuperTasksCreate`/`SuperTasksMarkDone` 是 core 侧运行的工具，直接调同一个
fs 模块）；SSE 事件经 zai 注册在 `globalThis` 的 bridge 发出（复用
`__zaiBridgeCtx` 模式）：

- `listTasks(): TaskBucket` — 扫三个目录，解析 index.md，返回
  `{ queue, processing, finished }` 三栏 summary
- `createPoolTask(input): TaskInfo` — 建骨架（被 SuperTasksCreate / API 调用）
- `moveTask(id, bucket)` — 目录移动 + index.md 更新
- `markStatus(id, status)` — 更新 index.md 冗余状态
- `deleteTasks(ids[])` — rm -rf，校验：processing 中任务禁止删除
- `getTaskDetails(id)` — 读取任务目录全部文件内容（供详情抽屉渲染 process.md 等）
- 所有变更 emit `task_factory.<action>` SSE 事件（经 bridge）；目录移动走串行队列防护并发

### routes/superTasks.ts

| 端点 | 用途 |
|---|---|
| `GET /api/super-tasks` | 三栏列表 |
| `GET /api/super-tasks/:id` | 任务详情（含 process.md 全文） |
| `POST /api/super-tasks/:id/start` | 手工启动：注入任务调度官会话「执行任务 X」 |
| `POST /api/super-tasks/:id/pause` | kill 执行子任务 + 冻结（任务留 processing） |
| `POST /api/super-tasks/:id/resume` | 注入任务调度官「继续任务 X」→ resume 原会话重新委派 |
| `POST /api/super-tasks/delete` | `{ids}` 批量删除（确认后） |
| `POST /api/super-tasks/managed` | `{enabled}` AI 托管开关 |
| `POST /api/super-tasks/inject` | 内部：向任务调度官会话注入系统指令（复用 runtime query，带 `x-source: system` 头，UI 对话流中不计为普通用户消息或单独渲染） |

SSE：任务事件并入现有 SSE 流（`useEventStream` 已有全局连接），以
`task_factory.*` 事件名下发，面板订阅刷新。

## 任务调度官会话与唤醒机制

- 任务调度官会话：固定 sessionId（如 `task-factory-supervisor`），transcript 持久化，
  mainAgent 恒为 `task-factory`。页面常驻对话区 = 该 session 的消息流 + 输入框；
  新建任务弹窗 = 带主题上下文的同一对话流（弹窗输入的 "请帮我新建任务:XXX" 直接发往该 session）。
- 唤醒：注入前检查会话状态（非 streaming / 非 pendingAsk）；忙则排队，面板状态条
  显示「任务调度官处理中」。注入消息不进入 UI 折叠区（渲染为系统指令气泡，可折叠）。
- 任务调度官会话的 transcript 落盘即任务工厂的「决策日志」，页面可回溯。

## 任务生命周期

```
                    ┌─────────────┐
   讨论(任务调度官+用户)  │  queue-tasks │◄── SuperTasksCreate
   └──────────────►│  (队列/池)   │
                    └──────┬──────┘
            start(注入) / AI托管自动 │ 派遣（优先 SpawnAgent claude-code|dsh，回退 AgentTool）
                    ┌──────▼──────┐
                    │ processing  │──► 执行子 Agent（cwd=任务目录, transcript 归拢任务目录）
                    │ (执行中)    │     职责: 读spec/plan→实现→追加process.md→汇报
                           │ 子 Agent 完成(process.md [DONE] / task 完成事件)
                           │ 唤醒任务调度官验收 → SuperTasksMarkDone
                    ┌──────▼──────┐
                    │ finished    │
                    └─────────────┘
   暂停: kill 执行子任务(保留会话), 任务留 processing, index.md status=paused
   继续: 注入任务调度官「继续任务 X」→ resume 原会话重新委派
   失败: 子 Agent failed → 唤醒任务调度官决策 retry / 标记失败(留 processing, UI 可重试)
```

- **手工启动**：按钮 → inject「执行任务 X」→ 任务调度官读 spec/plan → 首次启动写
  startedAt → 优先 SpawnAgent（claude-code/dsh）派生执行子 Agent，不可用时回退
  AgentTool；执行器 transcript 归拢到任务目录。
- **AI 托管（enabled）**：后端事件循环调度——
  - 队列非空 → 自动注入任务调度官「请按队列顺序派发任务」，不限制仅一个任务执行（不同任务可并行）；
  - 执行子 Agent 完成 → 自动唤醒任务调度官验收（读 process.md `[DONE]` 确认 → SuperTasksMarkDone）。
  - 开关关闭后回到全手工。托管循环对任务调度官会话同样走「空闲才注入、忙则等待」。
- 执行子 Agent = 现有 local_agent 后台任务：全局 SSE task 事件已存在，任务详情
  抽屉直接订阅展示其消息流/工具调用/进度，无需新机制。

## /super-tasks 页面

- 顶层路由（参考 `/desktop`，脱离 Layout、无 Sider/菜单）：`pages/SuperTasks.tsx`。
- 布局：左栏任务调度官对话区（复用 AgentConversation 式组件 + AgentInputBox，固定任务调度官
  session）；右栏任务面板（AntD 三栏/折叠面板 + 顶部操作条）。
- 操作条：AI 托管开关（Switch）、批量删除（多选后确认）、手工启动、暂停/继续、
  新建任务按钮。
- 新建任务弹窗：Modal 内嵌对话流（输入发往任务调度官 session），含**工程目录（cwd）选择**
  （用户指定任务所在代码项目，不同任务可落在不同工程）；任务调度官经 brainstorming
  讨论清楚后 `SuperTasksCreate`（携带 cwd）落库 → 弹窗回显创建结果 → 面板刷新。
- 任务详情抽屉：复用 `TaskDrawer` 的 SSE 订阅与渲染逻辑，展示执行子 Agent 的
  工具调用/消息流 + 任务目录文件（process.md/spec.md/plan.md tabs）。
- 状态标签与现有 `BackgroundTaskStatus` 配色一致（排队/执行中/已暂停/完成/失败）。

## 实例管理入口

- `InstanceDefinition` 增 `app?: 'task-factory'`（launchProfile 语义）。
- `instanceSupervisor` spawn 时若 `def.app === 'task-factory'` 追加
  `--app task-factory` 参数并设 env `ZAI_APP=task-factory`。
- 子实例启动行为：
  - `instanceContext.app === 'task-factory'` → 路由 `/` 与 `/agent` 重定向到
    `/super-tasks`（Layout 无菜单，保持"只有任务 UI"）；
  - mainAgent 解析兜底：`routes/agent.ts` 在 `sessionMainAgent` 为空/默认时若
    env `ZAI_APP=task-factory` 强制解析 `task-factory` agent（实例级锁定，用户
    settings 不得覆盖）。
- `Instances.tsx` 创建表单/页面增加「新建任务工厂实例」入口（创建 + 启动一步走，
  复用现有 waitForRunningInstance 后自动打开 `/super-tasks`）。

## 错误处理与边界

- 任务调度官会话忙：注入排队；面板显示「任务调度官处理中」，事件到达后自动轮询/刷新。
- 执行失败：子 Agent failed → 留 processing、index.md status=failed；UI 提供重试
  （重新 start = 注入任务调度官重新委派，保留已写文件）。
- 目录移动并发：taskFactory 内串行 mutex（单进程内 promise 链即可）。
- 删除约束：processing（含 paused）任务禁止删除（UI 禁用 + 服务端校验）；删除为
  硬删除（rm -rf 前 UI Popconfirm 二次确认）。
- 新建任务必填校验：title 必填；SuperTasksCreate 幂等（同 id 已存在则报错）。

## 测试

- 单元测试（vitest，只跑相关文件）：
  - `services/taskFactory.test.ts`：建/移/删/状态转换（mock fs 或 tmpdir）、
    删除约束、listTasks 解析；
  - `routes/superTasks.test.ts`：各端点参数校验与错误响应；
  - SuperTasksCreate/MarkDone 工具逻辑（骨架初始化、文件内容断言）。
- 真实浏览器验收（强制）：`pnpm --filter @zn-ai/zai dev -- --port <空闲>` 起服务，
  ego-browser 走 `/super-tasks` 全流程：新建任务（弹窗对话 → 任务调度官落库）→ 面板出现
  队列任务 → 手工启动 → 详情抽屉看执行过程 → 完成后移到 finished → 多选删除；
  再验「新建任务工厂实例」入口 → 实例打开即 `/super-tasks` 且 agent 锁定任务调度官。

## 范围外（本期不做）

- 阶段里程碑自动检查（`[MILESTONE]` 唤起任务调度官）——先手动/完成时验收；
- 任务依赖 / 优先级排序 UI（index.md 可预留字段，不做排序交互）；
- 移动端适配 /super-tasks。

> 更正（2026-09-01 用户确认）：**任务并行执行不排除**。每个任务同时只派发一个执行子
> Agent，但不同任务可并行（任务调度官收到 dispatch 指令时按队列顺序派发多个；托管循环不在
> 「无 processing 才派发」上做单任务串行约束）。

> **更正（2026-09-02 用户确认）：新建任务改为独立 intake 会话，废弃「弹窗输入发往
> 任务调度官 session」的原设计**（上文「页面布局 / 任务调度官会话与唤醒机制 / 新建任务弹窗」相关
> 描述以本条为准）：
>
> 1. **新建任务 = 独立 AI 对话窗口**：`NewSuperTaskModal` 不再是表单，打开即建一条
>    独立的临时会话（`POST /api/agent/sessions` 带 `mainAgent: 'task-intake'`，
>    transcript 与任务调度官会话完全隔离），弹窗内嵌 `AgentConversation` 对话流；
>    标题 / cwd / 执行 Agent 等要素全部由对话收集（废弃原「工程目录表单必填」）。
> 2. **新内置 agent `task-intake`**（`mainAgents-taskIntake.ts`）：职责单一 ——
>    brainstorming 聊需求 → `SuperTasksCreate` 落库 → 把讨论纪要写入任务目录
>    `docs/brainstorm.md` → 报告任务 id。tools 槽只追加 SuperTasksCreate
>    （不给 MarkDone/SpawnAgent，不派发不验收）。
> 3. **纪要归档**：落库后纪要永久留在 `<任务目录>/docs/brainstorm.md`（任务调度官派发时
>    与 spec/plan 一并让执行子 Agent 阅读）；临时 intake 会话在用户「完成并关闭」后
>    删除；讨论未完而关闭 → 保留草稿，下次打开弹窗提示「继续 / 新开」。
> 4. **任务调度官会话 id 以服务端 state.json 为唯一事实源**：修复前端 localStorage 随机
>    会话与后端注入 id 不联动的 bug。`POST /api/agent/sessions` 支持 `mainAgent`
>    （任务调度官引导建会话即冻结 `task-factory`）；新增 `POST /api/super-tasks/supervisor`
>    上报任务调度官 sid；`/super-tasks` 页面引导改为读取 `GET /api/super-tasks` 返回的
>    `supervisorSessionId`，命中则沿用，否则新建并上报。托管循环注入的
>    dispatch/accept 指令由此始终落在用户可见的任务调度官会话。
> 5. **`task_factory` SSE 事件接入前端**：shared `ServerEvent` 联合类型新增
>    `TaskFactoryEvent`（`action` + `payload`），`isGlobalEvent` 登记跨 sid 广播；
>    前端 `useEventStream` 路由到 `useSuperTaskStore.applyTaskFactoryEvent`
>    （刷新看板 + 记录 `lastCreatedTaskId` 供弹窗完成条）；3s 轮询保留作兜底。