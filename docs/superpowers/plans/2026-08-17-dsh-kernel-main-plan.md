# opencc-web 内核双轨改造主计划（deepseek-harness 内核集成 · B 方案）

> 日期：2026-08-17
> 状态：**B6-B7 收口完成，待 G2/G3 决策**（2026-08-22 更新）
> 关联文档：G2 决策 [`2026-08-17-dsh-kernel-decision.md`](2026-08-17-dsh-kernel-decision.md) / 维护契约 [`../2026-08-17-dsh-maintenance-contract.md`](../2026-08-17-dsh-maintenance-contract.md) / vendor 退役评估 [`../2026-08-17-dsh-vendor-retirement.md`](../2026-08-17-dsh-vendor-retirement.md) / 发布说明 [`../2026-08-17-dsh-release-notes.md`](../2026-08-17-dsh-release-notes.md)
> 相关调研：`docs/zn-harness-transformation.md`（历史工作文档）、本仓库 `AGENTS.md`
> 目标内核：`deepseek-harness`（`@deepseek-ai/dsh-*`，rc.7，下称 **dsh**）
> 现有内核：opencc 0.20.0 vendor 拷贝（`packages/zn-agent-core/src/opencc-src/`，下称 **opencc 内核**）

---

## 0. TL;DR

将 opencc-web（zai）的 agent 内核从「opencc 0.20.0 vendor 拷贝」迁移到「deepseek-harness」，采用**双轨并行 + 配置切换**：

- **保留现状**：`createOpenccRuntime` 路径（默认内核，`agent.kernel = 'opencc'`），现有行为零改动。
- **新增轨道**：`createDshRuntime` 路径（`agent.kernel = 'dsh'`），DSH 内核以长驻服务形式在 zai 进程内运行，通过 `KernelAdapter` 抽象暴露同一套能力面。
- **分批落地**：Batch 0-7，每批独立合入、独立可回滚、每批有对等验收。
- **最终决策门**：全部批次通过后，才讨论是否把默认内核切到 dsh；切换前保留 `'opencc'` 作为 kill switch。

约束红线（修订版）：
- 两条轨道不得互相污染数据（任务 store 也必须独立 namespace）。
- 配置**持久化即时**（写盘返回即可），**内核切换**必须通过**重启 zai 服务**生效——避免在 SSE 长连接运行期切换造成 globalThis/订阅/未 flush 事件泄漏。
- 任何批次不得破坏默认内核（`agent.kernel='opencc'`）路径。
- 在 dsh 模式下，**整个 zai 进程**的 Node 版本必须满足 `^22.19.0 || >=24.0.0`（dsh 代码用了 Node 22+ 的 API；动态 import 只延迟加载，不会让 Node 20 进程获得 Node 22 语义）。这是 dsh 模式准入检查，B-1 尖峰验证。

---

## 1. 背景与动机

### 1.1 为什么换内核

| 现状痛点（opencc vendor 内核） | dsh 内核的对应优势 |
|---|---|
| `opencc-src/` 是 verbatim 拷贝，升级需手动 vendor 同步 + compat 适配 | 独立 npm 包（`@deepseek-ai/dsh-*`），升级即换依赖 |
| compat 垫片承载 zai 专属能力（background / commands / mcp / memory / permissions / plugins / tools / transcript / skills 等，`skills` 实际分布在 `compat/runtime/skills-*` 与 `compat/tools/opencc/SkillTool.ts`），与 vendor 深度耦合 | Cordis 插件统一接口（`ctx.plugin()` / `ctx.tools.register()`），能力可插拔 |
| REGISTRY 会话元信息内存驻留，重启即失 | 事件溯源 Session（`dsh-session`），全状态可重放、可分叉 |
| 工具调度单循环（vendor `streamingToolExecutor`） | `ToolRuntime` + `ScopedLayers`，可按作用域路由工具 |
| 多 Agent 单层（BackgroundRuntime + JsonTaskStore） | ScopedLayers 父子作用域嵌套，子 agent 继承父 scope |
| 生命周期隐式 | 显式 hook（`agent/pre-step` / `agent/post-step` / `tool/before` / `tool/after`） |
| 测试无覆盖率硬门禁 | per-file 100% 覆盖率门禁（强约束） |

### 1.2 为什么双轨而非一步切换

1. **风险控制**：dsh 是 rc.7 预发布，API 可能有破坏性变更；且 dsh 明确「SESSION_FORMAT_VERSION = 0，无磁盘兼容承诺，后端可拒绝旧格式」（DSH AGENTS.md「Pre-release stance: foundation over blast radius」）。双轨允许默认轨道不受影响、随时回退。
2. **行为对等**：zai 有 190+ 测试文件 / 1400+ 用例 + ego-browser 验收要求。只有同进程双轨才能逐场景 A/B 对比。
3. **渐进迁移**：compat 层能力集（见 §2.1）无法一次迁移完，双轨让每个能力在 dsh 侧有明确落点后可单独合入。
4. **配置即开关**：`agent.kernel` 让用户（和 CI）可在无代码改动前提下验证 dsh 轨道。

### 1.3 边界（不在本计划内）

- 不重构 zai 的 React 前端 / SSE 契约 / Express 服务层（契约是稳定面，内核在它之下）。
- 不引入 DSH 的 web 栈（`dsh-host-webserver` / `dsh-host-apiproxy`）——那是 C 方案，本计划明确不做。
- 不冻结 opencc 内核的维护：双轨期两条轨道都维护，默认轨道优先。
- 不承诺 dsh 内核 100% 行为等价：以「zai 用户可见能力面」为对等基准（见 §8）。

---

## 2. 现状盘点（双内核事实表）

### 2.1 opencc 内核（现状，保留不动）

- 入口：`packages/zn-agent-core/src/bundle-entry.ts` → esbuild 单文件 `dist/opencc-core.mjs`，主入口 `@zn-ai/zn-agent-core`。
- 创建点：`packages/zai/src/server/services/agentRuntime.ts:334-355` `createOpenccRuntime({ dataDir, runtimeId, defaultCwd, defaultModel, connectMcp:false, interactive })`。
- 事件链：vendor `RuntimeEvent` → `routes/agent.ts` `translateRuntimeEvents()` → `shared/events.ts` `ServerEvent` → SSE。**ServerEvent 实际是 11 组 discriminatedUnion**（见 `shared/events.ts:356-368`）：Runtime / Session / Job / Prompt / System / State / Instance / Queue / Command / StreamError / Projection（不是「六通道」——这是主计划草稿的早期错误计数，B1 翻译时按 11 组对齐）。
- 服务面（zai 侧依赖）：`getRuntime()`、`queryModelWithStreaming`、`createHeadlessContext`、`createSessionFacade`、`streamingToolExecutor`、`bashTracker`、`taskListStore`、`runWithSessionId`、TranscriptStore、memory watcher、plugins registry、skills loader（实现位于 `compat/runtime/skills-*` 与 `compat/tools/opencc/SkillTool.ts`）、MCPClientPool、`globalThis` 桥（`__zaiEventBus` / `__zaiBridgeCtx` / `__zaiCurrentSessionId`，见 `agentRuntime.ts:75-88, 397-404`）。
- 持久化：`${dataDir}/projects/<sanitized-cwd>/<sessionId>.jsonl` + 内存 REGISTRY；任务走 `~/.zai/tasks/<taskId>.json`。
- **配置系统实情**：`zaiSettingsStore` 当前**只读写用户级 `~/.zai/settings.json`**（无项目级覆盖实现）；`shared/settings.ts` 的 `ZaiSettings` 也无 `agent.*` 字段。B0 必须新增项目级覆盖层或确认只用用户级。
- 测试：`pnpm -r test`（vitest）；开发规则要求「core 改动先 build:core」「ego-browser 验收」。

### 2.2 dsh 内核（目标，待接入）

- 形态：Cordis 微内核（vendor 拷贝于 `deepseek-harness/vendor/cordis`），一切能力都是插件 `{ name, inject, Config, apply }`。
- 关键包：`dsh-headless`（bundle，无 Host/HTTP 层）、`dsh-agent`、`dsh-agent-loop`（`ReactLoopAgent`）、`dsh-session`、`dsh-session-persistence-jsonl`、`dsh-tools`、`dsh-scope`、`dsh-system-prompt`、`dsh-user-approval`、`dsh-tool-ask-user`、`dsh-user-questions`、`dsh-subagent`、`dsh-fs`、`dsh-shell`、`dsh-mcp`（待确认存在性）等。
- 驱动模型（`packages/bundle/headless/src/index.ts:96-134`）：`agents.create({ sessionId, meta, agentOptions, setup })` → **首次 `await agent.whenIdle()`（等待 loader 完成挂载）** → 记 `firstSeq = agent.session.seq` → `agent.followup(createUserMessage(...))` → `await agent.whenIdle()` → `sessions.flush(agent.session)`。事件流 `agent.session.events`（`SessionEventMap`，merge-extensible）。
- 会话：事件溯源，`SESSION_FORMAT_VERSION = 0`，**无兼容承诺**（DSH 官方明确「Backends reject old on-disk formats」，AGENTS.md「Pre-release stance」一节）。B6 迁移工具必须锁定 dsh 版本 + 幂等 + 校验 + 回滚。
- 引擎要求：Node `^22.19.0 || >=24.0.0`，pnpm 11.7.0，ESM only。
- 测试文化：per-file 100% 覆盖率门禁、snapshot 测试（keyless 回放）、要求产品可见插件必须配 real-composition 测试。
- 运行示例：`pnpm dsh --profile headless "task"`（需 `DEEPSEEK_API_KEY`）。

### 2.3 核心差距（决定批次划分）

| # | 差距 | 现状（opencc） | 目标（dsh） | 归属批次 |
|---|---|---|---|---|
| G1 | 进程模型 | 常驻服务进程，多 session 并发 | headless 单次运行即退出 | Batch 1 |
| G2 | 事件模型 | `ServerEvent` **11 组**（Runtime/Session/Job/Prompt/System/State/Instance/Queue/Command/StreamError/Projection） | `SessionEventMap`（turn/assistant/agent/tool/…，merge-extensible） | Batch 1（B1b 事件/SSE 子阶段） |
| G3 | 工具注册 | `buildDefaultTools()` + MCPClientPool + skillTool | `ctx.tools.register(defineTool)` + capability seam | Batch 2 |
| G4 | 会话格式 | `<sessionId>.jsonl`（zai 语义） | 事件溯源 log（dsh 语义，独立目录） | Batch 3 |
| G5 | 交互/权限 | approveRegistry + askRegistry + requestApproveTool | `dsh-user-approval` / `tool-ask-user` / `user-questions` | Batch 4（依赖 Batch 2 工具面） |
| G6 | 多 Agent | BackgroundRuntime + JsonTaskStore + SubagentNotifier | ScopedLayers + `dsh-subagent`（独立 namespace） | Batch 5 |
| G7 | 配置 | `~/.zai/settings.json`（zaiSettingsStore，**当前只用户级**）+ 需新增项目级覆盖层 | cordis.yml Profile/Bundle/Patch | Batch 0（桥接 + 项目级配置实现） |
| G8 | 引擎版本 | Node ≥20 | dsh 代码用 Node 22+ API，**dsh 模式下整个 zai 进程需 Node ≥22.19** | Batch 0 + B-1 尖峰前置验证 |

---

## 3. 目标架构

```
┌────────────────────────────── zai 服务层（不变）──────────────────────────────┐
│ routes/*（HTTP/SSE）· services/* · web/（React）· shared/events.ts              │
│ 只依赖 KernelAdapter，不 import 任何具体内核符号                                 │
└──────────────────────────────────┬────────────────────────────────────────────┘
                                   │
                      ┌────────────▼────────────┐
                      │  KernelAdapter（新抽象）  │  packages/zai/src/server/services/kernel/
                      │  createKernel(cfg)       │  adapter.ts + factories/
                      └───┬────────────────┬────┘
                          │                │
              ┌───────────▼───┐     ┌──────▼────────────┐
              │ opencc 轨道    │     │ dsh 轨道（新）     │
              │ createOpenccR- │     │ createDshRuntime  │
              │ untime         │     │ (dsh-bridge)      │
              │ (现状，原样)    │     │ 长驻 Cordis ctx   │
              └───────────────┘     └───────────────────┘
     选择器：agent.kernel（settings.json，'opencc' | 'dsh'）
```

### 3.1 KernelAdapter 能力面（接口草案）

```ts
// packages/zai/src/server/services/kernel/kernelAdapter.ts
export interface KernelAdapter {
  readonly kernel: 'opencc' | 'dsh'

  // 生命周期（B-1 尖峰验证 shutdown 显式 drain 顺序）
  start(): Promise<void>
  shutdown(): Promise<void>  // 必须显式：拒绝新请求 → flush 当前 turn → dispose Cordis ctx → 清 globalThis 桥

  // 会话
  createSession(opts: { cwd: string; sessionId?: string }): Promise<AgentSession>
  resumeSession(opts: { cwd: string; sessionId: string }): Promise<AgentSession>
  listSessions(opts: { cwd: string }): Promise<SessionMeta[]>
  deleteSession(opts: { cwd: string; sessionId: string }): Promise<void>

  // 单轮驱动（流式）
  run(opts: { session: AgentSession; prompt: string }): AsyncIterable<KernelEvent>
  abort(opts: { session: AgentSession; reason?: string }): Promise<void>  // 已有 SSE 中断场景需用

  // transcript 修补 / 续读（替代现有 compat/transcript/* 入口）
  patchTranscript(opts: { session: AgentSession; entries: TranscriptPatch[] }): Promise<void>
  readTranscript(opts: { session: AgentSession; sinceSeq?: number }): AsyncIterable<TranscriptEntry>

  // 工具副作用回调（ask / approve）
  onAsk(cb: (req: AskRequest) => Promise<AskResponse>): void
  onApprove(cb: (req: ApproveRequest) => Promise<ApproveResponse>): void

  // 状态桥：cwd / bash_task / v2_task 等 ServerEvent.state.* 推送源
  subscribeState(cb: (event: StateChangeEvent) => void): () => void

  // 队列与指标（routes/agent.queue.ts 等使用）
  enqueue?(opts: { session: AgentSession; payload: QueuePayload }): Promise<void>
  metrics(): KernelMetrics

  // 后台任务 / 子 agent
  startBackgroundTask(opts: {...}): Promise<BackgroundTaskHandle>
  notifySubagentDone(...): void
}
```

`KernelEvent` 是对 `ServerEvent` 11 组的最小投影，由各轨道各自的 translator 产出；zai 侧 `routes/agent.ts` 只消费 `KernelEvent`。`patchTranscript` / `readTranscript` 替代 `compat/transcript/persistence.ts` 现有入口。

### 3.2 dsh 轨道装配（dsh-bridge）

新增 workspace `packages/dsh-bridge`（推荐，理由见 §3.3）。**因为 dsh 以 npm 包方式使用（node_modules 内不可改、上游升级即换版本），一切对 dsh 内核的定制都必须以 Cordis 插件包形式在 dsh-bridge 内增补，严禁直接修改 dsh 包本体**（详见 §3.2.1 插件包设计）：

```
packages/dsh-bridge/
  package.json            # deps: @deepseek-ai/dsh-headless + core 包；engines: node ^22.19；save-exact
  src/createDshRuntime.ts # 长驻 Cordis ctx 组装：loader 装载 bundle + 按需装载 zai 补丁插件
  src/plugins/            # ★ zai 侧补丁插件包（Cordis 插件形态，见 §3.2.1）
    zai-lifecycle/        #   生命周期：shutdown drain 顺序、globalThis 桥注册/清理
    zai-model/            #   模型桥：zai settings → installModelSelection
    zai-tools-core/       #   bash/fs/ripgrep 核心工具（对齐 zai 行为）
    zai-tools-mcp/        #   MCPClientPool 桥
    zai-tools-skill/      #   skill 加载
    zai-interaction/      #   approval/ask-user → zai registry 回调
    zai-session-store/    #   持久化走 zai 数据目录（隔离子目录）
    zai-memory/           #   AGENTS.md / rules → 系统提示装配
    zai-state-bridge/     #   state.* 事件推送（cwd/bash_task/v2_task）
    zai-subagent/         #   子 agent / 后台任务桥
  src/translate/
    sessionEvents.ts      # SessionEventMap → KernelEvent
  src/index.ts            # createDshRuntime 导出
```

#### 3.2.1 dsh 插件包设计（npm 包方式下的定制层）

**为什么必须插件方式**：
1. npm 安装的包在 `node_modules` 内不可直接修改（pnpm 校验文件完整性，直接改会被覆盖/报错）；
2. dsh 官方理念明确「Plugins, not loop changes: new behavior goes on documented extension points」（DSH AGENTS.md）——改扩展点是唯一被上游接受的形态，升级 dsh 版本时插件包可无损跟随；
3. 插件包随 dsh-bridge 一起版本化、可测试、可回滚，比改包本体可控。

**插件包规范**（对齐 dsh 的 Cordis 插件约定）：
```ts
// 每个 zai-* 插件都是标准 Cordis 函数插件：{ name, inject, Config, apply }
// - 可选服务用 ctx.get(name) 读取（不声明 inject），注入的用 ctx.<name>
// - 注册一律走 ctx.effect() / ctx.on()，register() 返回 disposer
// - 工具用 ctx.tools.register(defineTool)；hook 用 ctx.on('agent/pre-step') 等
export const name = 'zai-tools-core'
export const inject = ['tools', 'agents']
export interface Config { /* 来自 zai settings 的可配项 */ }
export const Config = z.object({ ... })
export function apply(ctx: Context, config: Config): void { ... }
```

**插件清单与职责**（对应 G1-G8 差距与 zai 特有行为）：

| 插件包 | 职责 | 增补的 dsh 扩展点 | 归属批次 |
|---|---|---|---|
| `zai-lifecycle` | 长驻生命周期：start 时注册 globalThis 桥（`__zaiEventBus` 等）、shutdown 时显式 drain → dispose → 清 globalThis | `ctx.on('dispose')`、launcher/appExit 等价物 | B1a |
| `zai-model` | zai settings 的 provider/model 解析结果注入 dsh | `installModelSelection(agentCtx, selected)`（headless 同款用法） | B1a |
| `zai-tools-core` | bash/fs/ripgrep 核心工具，行为对齐 zai（cwd 跟踪、后台通知） | `ctx.tools.register(defineTool)` + `dsh-shell` capability seam 补丁 | B2 |
| `zai-tools-mcp` | 复用 zai `MCPClientPool`，按需连接 | `ctx.tools.register()` | B2 |
| `zai-tools-skill` | 复用 `loadSkillsFromDirs()` 解析 + `SkillTool` | `ctx.tools.register()` | B2 |
| `zai-interaction` | approval/ask-user → zai approveRegistry/askRegistry 回调 | `dsh-user-approval` / `tool-ask-user` seam 的 Consumer 实现 | B4 |
| `zai-session-store` | 会话持久化到 `${dataDir}/projects/<cwd>/dsh-sessions/` | `SessionPersistence` provider 实现 | B3 |
| `zai-memory` | AGENTS.md / rules 内容注入系统提示 | `dsh-system-prompt` 装配点 / session 请求头 | B3 |
| `zai-state-bridge` | cwd/bash_task/v2_task 状态变化 → `state.*` 事件 | `ctx.on('agent/…')` + 工具结果监听 | B5 |
| `zai-subagent` | 子 agent/后台任务 → 任务 store（独立 namespace） | `dsh-scope` ScopedLayers + `dsh-subagent` seam | B5 |

**修改 dsh 包本体的边界**（明确禁止/兜底）：
- **禁止**：直接改 `node_modules/@deepseek-ai/*` 源码（会被 pnpm 校验覆盖）。
- **兜底**：某行为无法通过扩展点表达时，用 `pnpm patch`（`pnpm patch @deepseek-ai/dsh-xxx` → 修改 → `pnpm patch-commit`）把补丁持久化到仓库 `.pnpm-patches/`，提交到 git。**每个 patch 必须有注释说明为什么无法用插件表达**，且升级 dsh 时逐个重审。
- **上游路线**：确属 dsh 缺陷时，向 `deepseek-ai/deepseek-harness` 提 PR；合并前用 patch 兜底，合并后移除 patch。
- 判断顺序：**补丁插件 → pnpm patch → 上游 PR**，逐级升级，禁止跳级直接改包。

### 3.3 关键决策：独立 workspace 而非塞进 zn-agent-core

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 塞进 `zn-agent-core` | 单一主入口 | 污染 vendor 构建；DSH Node ≥22.19 与 core 的 Node ≥20 冲突；dsh 升级牵扯 core 发版 | ✗ |
| **独立 `packages/dsh-bridge`** | 引擎要求隔离；可独立发版/回滚；zn-agent-core 保持纯 opencc | 多一个 workspace 构建产物 | ✓ 推荐 |
| 独立 git 仓库 | 完全解耦 | 跨仓调试成本高，与 zai 同仓测试难 | ✗ |

---

## 4. 双轨设计

### 4.1 运行模型

- 同一 zai 进程内**同一时刻只激活一条轨道**（由 `agent.kernel` 决定），不做同进程双内核并发——并发共享 `globalThis` 桥（`__zaiEventBus` / `__zaiBridgeCtx` / `__zaiCurrentSessionId`）会互相污染。
- **配置持久化即时、内核切换靠重启**：
  - `agent.kernel` 写盘后立即持久化（`zaiSettingsStore.flush`），用户可立即看到配置已生效。
  - **内核实际切换必须重启 zai 服务**——运行期 SSE 长连接活跃 prompt/审批/后台任务，切内核需走 drain / dispose 顺序（见 §7 R8）。重启后启动时读取配置 → 走对应轨道的 `createKernel`。
  - 配置变更的 UI/CLI 反馈：「配置已保存，重启 zai 后生效」。
- `agent.kernel` 解析顺序（B0 实现）：项目级 `<cwd>/.zai/settings.json` > 用户级 `~/.zai/settings.json` > 默认 `'opencc'`。**当前 `zaiSettingsStore` 只支持用户级**，B0 必须新增项目级覆盖层（最简实现：`<cwd>/.zai/settings.json` 存在时合并到用户级之上）。

### 4.2 数据隔离

| 数据 | opencc 轨道路径（现状） | dsh 轨道路径（新增） |
|---|---|---|
| 会话 | `${dataDir}/projects/<cwd>/<sessionId>.jsonl` | `${dataDir}/projects/<cwd>/dsh-sessions/<sessionId>/`（事件溯源 log） |
| 任务 | `~/.zai/tasks/<taskId>.json`（前缀未命名） | `~/.zai/tasks/dsh-<taskId>.json` 或独立子目录 `~/.zai/tasks-dsh/`，**禁止两轨共享同一文件**——ID 空间、schema、续读语义均不同 |
| 插件/技能来源 | `~/.zai/plugins/`、`~/.agents/skills/` | 复用同一来源，dsh 侧由补丁插件解析（Batch 2/5） |
| 模型/凭据 | env + zai settings | 通过 zai 设置 → dsh `installModelSelection`，不单独落盘 |

原则：**同 cwd 下两条轨道各自独立目录/前缀，互不读取对方格式；迁移工具（Batch 6）是唯一允许跨格式读写的代码，且默认 dry-run。**

### 4.3 依赖与引擎隔离

- `@deepseek-ai/dsh-*` 全部装进 `packages/dsh-bridge`（npm 依赖，**不**用 `workspace:*`，避免触发 deepseek-harness workspace；锁定版本 `0.1.0-rc.7`，用 `save-exact`）。
- **关键约束：dsh 模式下整个 zai 进程的 Node 必须 ≥22.19**——动态 `import()` 只延迟 ESM 加载，不会让 Node 20 进程获得 Node 22 语义（`Promise.withResolvers` 等 ES2024 API 在 Node 20 下运行时崩溃）。**「zai 主服务保持 ≥20 + dsh-bridge 单独 ≥22.19」的早期设想不成立**。
  - 启动流程：B0 在 `createKernel` 之前检查 `process.version`，满足 dsh 模式（`agent.kernel === 'dsh'`）但 Node < 22.19 时**立即报错**（含修复指引：「请在 Node ≥22.19 下启动 zai，或临时切换 `agent.kernel='opencc'`」）。
  - 仓库级 `package.json.engines` 提升为 `^22.19.0 || >=24.0.0`（B0 提交里同步修改），放弃 Node 20 支持——这是 dsh 模式的硬约束，opencc 模式实际也兼容新 Node。
- **安装策略**：根 `pnpm install` 会解析所有 `packages/*` 的 deps，所以 dsh-bridge 的 deps 在 opencc-only 用户机器上也会被拉取（B-1 尖峰验证包大小与时间）。轻量做法：dsh-bridge 只声明 `@deepseek-ai/dsh-headless` + 必需 core 包；headless 的 peerDependencies（`@deepseek-ai/dsh-cmdline`、`@deepseek-ai/dsh-code-runtime-worker-thread`、`@deepseek-ai/schemastery` 等）需 `pnpm peerDependencyRules.allowAny` 或显式列在 dependencies（B0 T0.5 决定）。
- 构建：`pnpm --filter @zn-ai/dsh-bridge build` 产出 `lib/index.js`；zai 通过动态 `import('@zn-ai/dsh-bridge')` 加载，仅在 `agent.kernel === 'dsh'` 时才解析（运行期隔离，默认轨道不会触发 dsh 代码执行）。
- **定制策略**：DSH 官方理念「Plugins, not loop changes」（AGENTS.md）——所有定制写在 dsh-bridge 补丁插件里，**不直接修改 dsh 包本体**。万不得已时用 `pnpm patch` 记录对 node_modules 的补丁（持久化、可提交、可回滚），优先于 fork 上游。

### 4.4 能力面对齐矩阵（双轨对照，验收依据）

| zai 用户可见能力 | opencc 轨道（现状） | dsh 轨道（目标） | 对等基准 |
|---|---|---|---|
| 对话流式输出（11 组 ServerEvent 全覆盖） | ✓ | ✓ | Batch 1（B1b）验收 |
| 工具调用（bash/fs/edit/write） | ✓ | ✓ | Batch 2 验收 |
| MCP 服务器工具 | ✓ | ✓ | Batch 2 验收 |
| Skill 动态加载（`compat/runtime/skills-*` + SkillTool） | ✓ | ✓ | Batch 2 验收 |
| 权限审批 / AskUserQuestion | ✓ | ✓ | Batch 4 验收 |
| 会话持久化 / 历史列表 | ✓ | ✓ | Batch 3 验收 |
| 后台任务 / 子 agent（独立 namespace） | ✓ | ✓ | Batch 5 验收 |
| 插件市场 | ✓ | ✓ | Batch 5 验收 |
| 记忆（AGENTS.md / rules watcher） | ✓ | ✓ | Batch 3 验收 |
| Slash 命令 | ✓ | ✓ | Batch 5 验收 |

---

## 5. 批次划分总览

| 批次 | 主题 | 核心产出 | 依赖 |
|---|---|---|---|
| **B-1** | 可行性尖峰（前置） | Node ≥22.19 验证、packed-install 验证、headless peers 处理、长驻 Cordis teardown 实测、globalThis 清理协议定稿；任一失败 → 计划暂停 | — |
| **B0** | 基座与双轨骨架 | `agent.kernel` 配置 + 项目级覆盖层、`KernelAdapter` 接口（含 abort / transcript patch / 状态桥 / 队列 / metrics）、工厂分叉、opencc 轨道原样封装、dsh-bridge workspace 骨架 | B-1 |
| **B1** | dsh 运行时适配（**内分 B1a 生命周期/模型 + B1b 事件/SSE**） | `createDshRuntime` 长驻装配、模型桥；11 组 ServerEvent → KernelEvent 翻译；最小对话闭环 | B0 |
| **B2** | 工具与 MCP | dsh 侧 bash/fs/核心工具、MCPClientPool 桥、skill 加载 | B1a（B1b 不阻塞 B2） |
| **B3** | 会话与记忆 | dsh 会话持久化（隔离目录）、transcript 桥、memory watcher 桥 | B1a |
| **B4** | 交互与权限 | approval/ask-user 桥（dsh 交互 seam → zai registry） | **B2**（审批触发点在工具执行） |
| **B5** | 多 Agent 与插件 | 子 agent/后台任务（ScopedLayers）、任务 store（独立 namespace）、插件市场、slash 命令 | B2+B3+B4 |
| **B6** | 对等验收与切换 | 双轨 parity 测试（11 组事件）、ego-browser 双轨验收、会话迁移工具（幂等/校验/回滚）、kill switch 演练 | B0-B5 |
| **B7** | 决策与清理 | 默认内核切换决策门、vendor 退役（可选）、文档收口 | B6 |

### 5.1 依赖 DAG

```
B-1 ──> B0 ──> B1a ──┬──> B2 ──┐
              │       │        ├──> B4 ──┐
              │       ├──> B3 ──┘        ├──> B5 ──> B6 ──> B7
              │       │                 │
              └─> B1b（事件/SSE，可在 B2/B3/B4 之后合入，不阻塞功能）
```

- B1 内部分 B1a（生命周期/装配/模型桥）与 B1b（事件翻译/SSE 接线）——**B1b 不阻塞 B2/B3/B4**（可后并入）。
- **B4 依赖 B2**（审批触发点在工具执行，不能在工具面空缺时实现）——这是对主计划草稿的修正。
- B5 需要 B2+B3+B4 齐备。

### 5.2 合入策略

- 每批一个独立 PR（或 PR stack），**默认内核保持 `'opencc'`**，任何批次不触碰 opencc 轨道的行为路径。
- dsh 轨道代码在批次内以 feature 分支 + worktree 开发（沿用仓库 worktree 习惯），合入前跑相关单测 + 该批的 ego-browser 场景。
- 每批验收必须包含「opencc 轨道回归通过」（防止双轨改造污染默认路径）。

---

## 6. 验收总标准（B6 全轨验收）

1. **配置切换**：`agent.kernel = 'opencc' | 'dsh'` 均可启动 zai（B0 验证可达 + 报错路径；B1 后验证完整启动）；切换后会话列表可见各自轨道数据。
2. **能力面 100% 对齐**：§4.4 矩阵全部 ✓，逐项有对应测试/演示。
3. **对等测试**：同一场景脚本（对话、工具调用、审批、后台任务）在双轨各跑一遍，**归一化事件流后产出 diff 报告**——必须覆盖全部 11 组 ServerEvent 类型；已知差异要有记录（§6.1）。
4. **回归**：opencc 轨道 1400+ 用例全绿（`pnpm -r test`）。
5. **真实浏览器**：双轨各走一遍核心用户路径（发起对话、工具执行、权限弹窗、后台任务 drawer、会话历史恢复）——ego-browser 强制项。
6. **可回滚**：kill switch 演练——`dsh` 轨道出现线上问题时可一配置切回 `opencc`，无数据损坏，含 drain/dispose 顺序验证。
7. **构建**：`pnpm run build`（core → zai 链路）+ `pnpm --filter @zn-ai/dsh-bridge build` 全绿；Node ≥22.19 下全链路通过。

### 6.1 已知差异记录（预期允许，须显式文档化）

| 差异 | 影响 | 处置 |
|---|---|---|
| dsh 会话事件溯源格式 ≠ zai jsonl | 历史会话在 dsh 轨道不可直接续读 | B6 迁移工具（锁定 dsh 版本 + 幂等 + 校验 + 回滚 + 默认 dry-run）；未迁移会话在 dsh 轨道列表隐藏并提示 |
| dsh 对工具 schema 更严格（JSON Schema 校验） | 个别非标准工具 schema 可能被拒 | B2 记录并适配 |
| 模型选择：dsh 走 `installModelSelection` | zai 的 provider/model 路由覆盖需要桥接 | B1 处理 |
| 双轨引擎要求不同 | Node < 22.19 用户无法启用 dsh 模式 | 启动时 fail loud（§4.3）；不静默回退 |
| SESSION_FORMAT_VERSION=0 无兼容承诺 | 上游 dsh 升级可能拒绝旧 log | 迁移器绑定 dsh 版本；升级走独立批次 + 回滚预案 |
| Cordis 是 vendor 拷贝 | dsh 升级涉及 Cordis ABI 风险（双重升级链） | dsh-bridge 不依赖 Cordis 私有 API；Cordis 升级走 dsh 上游节奏 |

---

## 7. 风险登记册

| # | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | dsh rc.7 API 破坏性变更 | 高 | 中 | 锁定版本（`save-exact`）；dsh-bridge 依赖收敛到 core 包；升级走独立批次 |
| R2 | dsh 模式需 Node ≥22.19；早期设想「zai ≥20 + dsh-bridge ≥22.19」不成立 | 高 | 高 | 启动前 `process.version` 检查 + fail loud；仓库 engines 升至 ≥22.19；B-1 尖峰前置验证 |
| R3 | 事件翻译遗漏导致 UI 行为差异（11 组而非 6 组） | 高 | 高 | B1b 先建全量事件映射清单 + 对等测试；B6 ego-browser 全场景 |
| R4 | 会话/任务格式不兼容导致数据误解 | 中 | 高 | 数据隔离目录 + 任务 store 独立 namespace；迁移工具只读不写原格式（dry-run 默认） |
| R5 | dsh 工具执行与 zai 权限模型冲突 | 中 | 高 | B4 交互桥先行设计；approve/ask 走统一 registry；B2 在 B4 完成前 bypass 仅在显式开启时生效 |
| R6 | 双轨维护成本上升 | 高 | 中 | 能力面矩阵驱动；默认轨道优先；明确「双轨是过渡态，不是终态」 |
| R7 | 全量测试 + ego-browser 验收成本高 | 中 | 中 | 每批只跑相关单测（AGENTS.md 规则）+ 该批场景的 ego 验收；全量仅在 B6 收口 |
| R8 | SSE 长连接下切换内核的 drain/dispose 缺失 | 中 | 高 | 「配置持久化即时、内核切换靠重启」统一语义；`createKernel.shutdown()` 实现显式 drain（拒绝新请求、flush 当前 turn、dispose Cordis ctx、清空 `__zaiEventBus/__zaiBridgeCtx/__zaiCurrentSessionId` globalThis 桥）；B-1 尖峰验证 |
| R9 | Cordis vendor 双重升级链（dsh 升级可能带动 Cordis ABI 变化） | 中 | 中 | dsh-bridge 仅用 Cordis 公开 API；升级走 dsh 上游节奏 |
| R10 | `globalThis` 桥在测试/重启残留 | 中 | 中 | 启动序列初始化 + 关闭序列显式 `delete globalThis.__zai*`；B-1 尖峰验证 |
| R11 | dsh 默认 dsh-sessions 目录对 opencc 模式不可见 | 低 | 低 | UI 跨模式提示；B6 迁移器入口 |

---

## 8. 决策门（Gate）

| Gate | 触发点 | 决策 | 通过条件 |
|---|---|---|---|
| G-1 | **B-1 尖峰完成** | 计划是否继续 | 节点引擎要求 + packed install + headless peers + 长驻 Cordis teardown + globalThis 清理协议全部验证通过 |
| G0 | B0 合入 | 双轨骨架可达 | opencc 轨道正常启动 + 行为零变化；`agent.kernel='dsh'` 启动时按预期失败并报错清晰；项目级配置覆盖可用 |
| G1 | B1 合入 | dsh 最小对话闭环 | dsh 轨道能完成一次流式对话并落盘；事件翻译覆盖核心子集 |
| G2 | B6 完成 | 是否推进默认切换 | §6 验收全绿 + 已知差异可接受 + 维护团队确认 |
| G3 | B7 完成 | dsh 升为默认内核 / vendor 退役 | G2 通过 + 无未解高风险 |

**G0 期望修订**：原表述「双值均可启动」与 B0「dsh 启动必然显式失败」互斥。**修正**：G0 仅验证「可达」（opencc 启动 + dsh 桩报错清晰），把「双值完整启动」挪到 G1 之后逐步达成。

**G2 未通过时的兜底**：dsh 轨道保留为可选内核（`agent.kernel='dsh'`），opencc 保持默认，B7 仅做文档收口与双轨维护策略调整。本计划不预设「必须切换」。

---

## 9. 交付物清单

| 产物 | 位置 | 批次 |
|---|---|---|
| KernelAdapter 接口 | `packages/zai/src/server/services/kernel/kernelAdapter.ts` | B0 |
| 配置 schema 扩展 | `packages/zai/src/server/services/zaiSettingsStore.ts`（`agent.kernel`） | B0 |
| 工厂分叉 | `packages/zai/src/server/services/agentRuntime.ts` | B0 |
| dsh-bridge workspace | `packages/dsh-bridge/` | B0（骨架）→ B1-B5（填充） |
| 事件映射表 | `packages/dsh-bridge/src/translate/` + `docs/` | B1 |
| 会话迁移工具 | `packages/zai/src/server/services/kernel/migrate.ts` | B6 |
| 对等测试 harness | `packages/zai/test/kernel/parity/` | B6 |
| 本批次子计划 | `docs/superpowers/plans/2026-08-17-dsh-kernel-batch-*.md` | 各批 |

---

## 10. 附录

### 10.1 子计划索引

- [B0 基座与双轨骨架](2026-08-17-dsh-kernel-batch-00-baseline-dual-track.md)
- [B1 dsh 运行时适配](2026-08-17-dsh-kernel-batch-01-runtime-adapter.md)
- [B2 工具与 MCP](2026-08-17-dsh-kernel-batch-02-tools-mcp.md)
- [B3 会话与记忆](2026-08-17-dsh-kernel-batch-03-session-memory.md)
- [B4 交互与权限](2026-08-17-dsh-kernel-batch-04-interaction-permission.md)
- [B5 多 Agent 与插件](2026-08-17-dsh-kernel-batch-05-subagent-plugins.md)
- [B6 对等验收与切换](2026-08-17-dsh-kernel-batch-06-parity-acceptance.md)
- [B7 决策与清理](2026-08-17-dsh-kernel-batch-07-flip-cleanup.md)

### 10.2 关键文件索引（双内核）

**opencc 内核（zai 侧）**
- `packages/zai/src/server/services/agentRuntime.ts` — runtime 创建点
- `packages/zai/src/server/routes/agent.ts` — `translateRuntimeEvents`（1690 行，事件翻译主战场）
- `packages/zai/src/shared/events.ts` — `ServerEvent` schema（**11 组** discriminatedUnion）
- `packages/zn-agent-core/src/bundle-entry.ts` — 单一 bundle 入口
- `packages/zn-agent-core/src/compat/` — 8+ 子模块垫片

**dsh 内核（外部依赖）**
- `deepseek-harness/packages/bundle/headless/src/index.ts` — 驱动模型范例
- `deepseek-harness/packages/core/agent-loop/src/agent.ts` — `ReactLoopAgent`
- `deepseek-harness/packages/core/tools/src/index.ts` — 工具注册/执行管道
- `deepseek-harness/packages/session/session-persistence-jsonl/` — 持久化 provider
- `deepseek-harness/packages/interaction/` — approval/ask-user seam
- `deepseek-harness/docs/architecture.md`、`docs/cordis-primer.md` — 架构与 Cordis 速览

### 10.3 术语

- **轨道（track）**：同一能力面下的一整套内核实现（opencc 轨道 / dsh 轨道）。
- **KernelAdapter**：zai 服务层与具体内核之间的抽象接口。
- **capability seam**：DSH 的「Service Definition / Provider / Consumer」三段式能力封装。
- **kill switch**：`agent.kernel='opencc'` 配置即回退能力。
