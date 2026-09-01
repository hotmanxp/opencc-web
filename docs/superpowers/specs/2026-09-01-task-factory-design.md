# 任务工厂（Task Factory）设计

日期：2026-09-01
状态：design-confirmed（经 brainstorming 会话确认）

## 背景与目标

用户需要在 zai 内实现一个「任务工厂」：以文件为载体的任务生命周期管理
（新建 → 队列 → 执行 → 验收 → 完成），配一个专门的 Web 调度面板和一名
**任务主管 Agent**。主管 Agent 负责与用户详细讨论需求（走 brainstorming
skill）、把需求落库为任务文件、分派执行、验收成果。

关键决策（brainstorming 已确认）：

| 决策点 | 结论 |
|---|---|
| 执行机制 | 主管派生执行子 Agent（AgentTool → local_agent 后台任务），子 Agent 在任务目录工作、更新 process.md |
| 暂停/继续 | 原地冻结（任务留 processing，kill 执行子任务，保留其会话）+ resume 原会话重新委派 |
| AI 托管 | 后端事件驱动调度 + 按需唤醒主管做分派/验收；不常驻主管 |
| 页面布局 | 常驻主管对话区 + 任务面板分屏；新建任务弹窗复用主管会话对话流 |
| 执行 Agent | 任务创建时主管写入 index.md 的 `agent` 字段，执行时按此派生 |
| 页面形态 | `/super-tasks` 顶层路由，脱离 Layout、无菜单，只有任务相关 UI |

## 总体架构

```
┌─ Web /super-tasks（顶层路由，脱离 Layout）───────────────┐
│  左: 常驻主管对话区（固定 session，agent=task-factory） │
│      └ 新建任务弹窗 = 对话区内的快捷对话流              │
│  右: 三栏面板 队列 / 执行中 / 已完成 + 操作条           │
│      任务详情抽屉（展示执行子 Agent 过程）              │
└──────────────┬──────────────────────────────────────────┘
               SSE: task_factory.* 事件 + 现有 task 事件
┌─ zai 服务端 ────────────────────────────────────────────┐
│  routes/superTasks.ts   REST API                        │
│  services/taskFactory.ts 文件系统 CRUD + 事件 + 状态机   │
│  主管 session（transcript 持久化）                      │
│    └ 唤醒注入 → 主管用 AgentTool 派生执行子 Agent        │
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
agent: claude-code         # 执行子 Agent 用谁（主管创建对话中决定；claude-code/dsh，或内置 agent 名）
createdAt: 2026-09-01T10:00:00+08:00
startedAt: null
completedAt: null
executorTaskId: null      # 主管派生执行子 Agent 后回填的 BackgroundTask id
                           # (供暂停 kill 与详情抽屉订阅执行过程)
parentSessionId: ...       # 可选：创建该任务的主管道话 session
---

# 任务描述

（主管与用户讨论后的一句话/一段目标描述）
```

### 目录内文件

| 文件 | 职责 | 由谁写 |
|---|---|---|
| `index.md` | 任务入口 + 元数据 | 主管（SuperTasksCreate 初始化） |
| `docs/spec.md` | 需求规格（brainstorming 讨论结果落库） | 主管 |
| `docs/plan.md` | 执行计划（拆分步骤） | 主管 / 执行子 Agent 细化 |
| `process.md` | 执行进度日志：时间戳 + 步骤 + 结论，里程碑标记 `## [MILESTONE]` / 结尾 `## [DONE]` | 执行子 Agent 追加 |

`process.md` 的 `[DONE]` 标记是后端判定「完成」的约定信号；`[MILESTONE]` 是
唤醒主管做阶段检查的信号（本期可选，先手动验收）。

## 任务主管 Agent

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
异步返回 `task_id`，完成后通知主管）。仅当对应 provider 未注册/不可用时，
回退内置 `AgentTool`（`subagent_type` 用内置 agent 名）。

**执行器工作目录 = 任务的工程目录（index.md 的 `cwd` 字段）**（2026-09-01 用户追加）：
不同任务可落在不同代码工程，创建任务时必须记录工程目录；委派执行子 Agent 时把该
`cwd` 作为执行环境：
- SpawnAgent 路径：`cwd` 参数 = 任务 `cwd`（绝对路径）；
- AgentTool 回退路径：prompt 里显式声明任务 `cwd`（绝对路径）并要求在其中工作。

**执行器 transcript 归拢到任务目录**（`~/.zai/task-factory/processing-tasks/<id>/`）：
core `getAgentTranscriptPath`（`utils/sessionStorage.ts:572`）打小补丁——`transcriptSubdir`
若为绝对路径则直接作为 transcript 根目录（原实现只拼在 `projectDir/sessionId/subagents/`
下，无法指向任务目录）；主管委派时把绝对任务目录作为 transcript 位置传入
（AgentTool 路径传绝对 `transcriptSubdir`；SpawnAgent 路径的 zai 侧 task 记录/output
文件自然落在任务目录附近）。CLI 子 agent（claude-code CLI）自己有独立 transcript
存储，无法被 zai 侧重定向——其 cwd 为任务工程目录，保证工程级隔离。

### 新增工具

| 工具 | 入参 | 行为 |
|---|---|---|
| `SuperTasksCreate` | `{title, description, agent?}` | 唯一入口创建任务：生成 id，创建 `queue-tasks/<id>/` 目录与 `index.md`/`docs/plan.md`/`docs/spec.md`/`process.md` 骨架，emit `task_factory.created` 事件。重复创建由 id 幂等防护 |
| `SuperTasksMarkDone` | `{id}` | 主管验收通过：更新 index.md（status=done、completedAt）、把目录从 processing 移到 finished、emit `task_factory.finished` |

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
| `POST /api/super-tasks/:id/start` | 手工启动：注入主管会话「执行任务 X」 |
| `POST /api/super-tasks/:id/pause` | kill 执行子任务 + 冻结（任务留 processing） |
| `POST /api/super-tasks/:id/resume` | 注入主管「继续任务 X」→ resume 原会话重新委派 |
| `POST /api/super-tasks/delete` | `{ids}` 批量删除（确认后） |
| `POST /api/super-tasks/managed` | `{enabled}` AI 托管开关 |
| `POST /api/super-tasks/inject` | 内部：向主管会话注入系统指令（复用 runtime query，带 `x-source: system` 头，UI 对话流中不计为普通用户消息或单独渲染） |

SSE：任务事件并入现有 SSE 流（`useEventStream` 已有全局连接），以
`task_factory.*` 事件名下发，面板订阅刷新。

## 主管会话与唤醒机制

- 主管会话：固定 sessionId（如 `task-factory-supervisor`），transcript 持久化，
  mainAgent 恒为 `task-factory`。页面常驻对话区 = 该 session 的消息流 + 输入框；
  新建任务弹窗 = 带主题上下文的同一对话流（弹窗输入的 "请帮我新建任务:XXX" 直接发往该 session）。
- 唤醒：注入前检查会话状态（非 streaming / 非 pendingAsk）；忙则排队，面板状态条
  显示「主管处理中」。注入消息不进入 UI 折叠区（渲染为系统指令气泡，可折叠）。
- 主管会话的 transcript 落盘即任务工厂的「决策日志」，页面可回溯。

## 任务生命周期

```
                    ┌─────────────┐
   讨论(主管+用户)  │  queue-tasks │◄── SuperTasksCreate
   └──────────────►│  (队列/池)   │
                    └──────┬──────┘
            start(注入) / AI托管自动 │ 派遣（优先 SpawnAgent claude-code|dsh，回退 AgentTool）
                    ┌──────▼──────┐
                    │ processing  │──► 执行子 Agent（cwd=任务目录, transcript 归拢任务目录）
                    │ (执行中)    │     职责: 读spec/plan→实现→追加process.md→汇报
                           │ 子 Agent 完成(process.md [DONE] / task 完成事件)
                           │ 唤醒主管验收 → SuperTasksMarkDone
                    ┌──────▼──────┐
                    │ finished    │
                    └─────────────┘
   暂停: kill 执行子任务(保留会话), 任务留 processing, index.md status=paused
   继续: 注入主管「继续任务 X」→ resume 原会话重新委派
   失败: 子 Agent failed → 唤醒主管决策 retry / 标记失败(留 processing, UI 可重试)
```

- **手工启动**：按钮 → inject「执行任务 X」→ 主管读 spec/plan → 首次启动写
  startedAt → 优先 SpawnAgent（claude-code/dsh）派生执行子 Agent，不可用时回退
  AgentTool；执行器 transcript 归拢到任务目录。
- **AI 托管（enabled）**：后端事件循环调度——
  - 队列非空 → 自动注入主管「请按队列顺序派发任务」，不限制仅一个任务执行（不同任务可并行）；
  - 执行子 Agent 完成 → 自动唤醒主管验收（读 process.md `[DONE]` 确认 → SuperTasksMarkDone）。
  - 开关关闭后回到全手工。托管循环对主管会话同样走「空闲才注入、忙则等待」。
- 执行子 Agent = 现有 local_agent 后台任务：全局 SSE task 事件已存在，任务详情
  抽屉直接订阅展示其消息流/工具调用/进度，无需新机制。

## /super-tasks 页面

- 顶层路由（参考 `/desktop`，脱离 Layout、无 Sider/菜单）：`pages/SuperTasks.tsx`。
- 布局：左栏主管对话区（复用 AgentConversation 式组件 + AgentInputBox，固定主管
  session）；右栏任务面板（AntD 三栏/折叠面板 + 顶部操作条）。
- 操作条：AI 托管开关（Switch）、批量删除（多选后确认）、手工启动、暂停/继续、
  新建任务按钮。
- 新建任务弹窗：Modal 内嵌对话流（输入发往主管 session），含**工程目录（cwd）选择**
  （用户指定任务所在代码项目，不同任务可落在不同工程）；主管经 brainstorming
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

- 主管会话忙：注入排队；面板显示「主管处理中」，事件到达后自动轮询/刷新。
- 执行失败：子 Agent failed → 留 processing、index.md status=failed；UI 提供重试
  （重新 start = 注入主管重新委派，保留已写文件）。
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
  ego-browser 走 `/super-tasks` 全流程：新建任务（弹窗对话 → 主管落库）→ 面板出现
  队列任务 → 手工启动 → 详情抽屉看执行过程 → 完成后移到 finished → 多选删除；
  再验「新建任务工厂实例」入口 → 实例打开即 `/super-tasks` 且 agent 锁定主管。

## 范围外（本期不做）

- 阶段里程碑自动检查（`[MILESTONE]` 唤起主管）——先手动/完成时验收；
- 任务依赖 / 优先级排序 UI（index.md 可预留字段，不做排序交互）；
- 移动端适配 /super-tasks。

> 更正（2026-09-01 用户确认）：**任务并行执行不排除**。每个任务同时只派发一个执行子
> Agent，但不同任务可并行（主管收到 dispatch 指令时按队列顺序派发多个；托管循环不在
> 「无 processing 才派发」上做单任务串行约束）。