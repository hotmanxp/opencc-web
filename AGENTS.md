# AGENTS.md - opencc-web

## 项目概述

**opencc-web** 是 zai 的本地开发与运行工具集,在 `packages/zai`(Express + SSE server + React/Zustand/AntD 前端)与 `packages/zn-agent-core`(Agent 运行时核心库)两个 workspace 中实现 Agent 对话、流式 UI、命令/Skill/插件等能力。zai 仅监听 localhost,不依赖外部鉴权。

## 技术栈

| 层 | 技术 | 版本 |
|----|------|------|
| 语言 | TypeScript | ^5.6 |
| 运行时 | Node-direct(tsx + bun-protocol) / Bun 可选(`dev:bun`) | `^22.19.0 \|\| >=24.0.0`(仓库级 engines;`.nvmrc` 写 20 已过期 — 以 engines 为准) |
| zai 前端 | React + Zustand + AntD + Vite + React Router + Tailwind + CodeMirror + react-markdown | 18.3 / 4.5 / 5.22 / 8.1.5 / 6.28 / 3.4 / 14 langs / 10.1 |
| zai 服务端 | Express + SSE + Zod + ws + sharp + commander + `@anthropic-ai/sdk` | ^4.21 / ^3.23 / ^8.18 / ^0.33.5 / ^12.1 / ^0.52 |
| dsh-bridge | `@deepseek-ai/cordis` + 35 个 `@deepseek-ai/dsh-*`(Phase 4 新增 `dsh-subagent` / `dsh-subagent-spawn-in-process` / `dsh-subagent-in-process-driver` / `dsh-agent-presets` / `dsh-brand` / `dsh-invariants` / `dsh-session-persistence` / `dsh-user-questions`) + `@modelcontextprotocol/sdk` | 4.0.1 / 0.1.0-rc.8 / ^1.0 |
| zn-agent-core vendor | opencc 0.20.0(Bun 兼容(un-stripped))+ ripgrep vendor 二进制(darwin-arm64/x64、win32-x64) | — |
| 测试 | Vitest | zai/dsh-bridge/根 `^4.1`;zn-agent-core `^2.1`(子包隔离,跨包勿混引) |

## 目录

| 目录 | 职责 |
|------|------|
| `packages/zai/` | `src/server/` 路由 + service,`src/web/` UI + store,`src/shared/` zod schema |
| `packages/zn-agent-core/` | `compat/`(verbatim 移植的 zai 兼容垫片)+ `opencc-src/`(opencc 0.20.0 拷贝,Bun 兼容(un-stripped));`scripts/bundle-opencc.ts` 把 `src/bundle-entry.ts` 编成单一 `dist/opencc-core.mjs`(esbuild bundle)。**运行时与 types 都从主入口 `@zn-ai/zn-agent-core` 导出**(2026-08-16 起废除全部 subpath);`dist/bundle-entry.d.ts` 由 `bundle-opencc.ts` 机械生成,与 bundle 同步 |
| `packages/dsh-bridge/` | **B0 新增** — zai → deepseek-harness 桥接 workspace。详见下方「双轨改造 (dsh 内核集成)」段落 |
| `docs/` | 设计/参考/操作指南;`docs/superpowers/specs/` 是各特性 spec,`docs/superpowers/plans/` 是实施计划;`docs/2026-08-17-dsh-*.md` 是 dsh 主线文档(已知差异 / 维护契约 / vendor 退役 / 发布说明) |
| `scripts/` | `release.mjs`(`pnpm release:*` 主入口)+ `generate-rpc-client.ts`(Zod → `api.generated.ts` codegen)+ `kill-switch-drill.sh`(季度演练,见下方「关键命令」段)+ `zn-ai` / `zn-ai.bat`(zn-env 环境检测脚本) |
| `examples/` | `mcp-smoke/` — MCP 冒烟测试(stdio server + `MCPClientPool` 接入验证) |
| 根 `.zai/` | ⚠️ **本仓库用户态数据影子目录**(与运行时 `~/.zai/` 同布局)— 仅用于本地 dev 与 IDE 感知,生产读写都走真实 `~/.zai/`,不要把根 `.zai/` 路径写进代码 |

## 双轨改造 (dsh 内核集成 · B 方案)

> **状态**（2026-08-22）：**全 plan 收口完成 + Phase 4 收口** — P0/P1/P2 全部真实化，Phase 4(dsh-subagent 上游 `SubagentRuntime.start`)完成，handoff §6 已知缺口 1-5 已关闭。dsh-bridge **135 测试** / zai 2192 测试 / zn-agent-core 382 测试全绿。详细状态见 `packages/dsh-bridge/IMPLEMENTATION_STATUS.md`。
> **目标**：zai agent 内核从 opencc vendor 迁移到 deepseek-harness（`@deepseek-ai/dsh-*`），采用双轨并行 + 配置切换。
> **G2 决策**：评审记录见 [`docs/superpowers/plans/2026-08-17-dsh-kernel-decision.md`](docs/superpowers/plans/2026-08-17-dsh-kernel-decision.md)；维护契约见 [`docs/2026-08-17-dsh-maintenance-contract.md`](docs/2026-08-17-dsh-maintenance-contract.md)；已知差异见 [`docs/2026-08-17-dsh-known-differences.md`](docs/2026-08-17-dsh-known-differences.md)。

### 轨道选择

zai 同时支持两条 agent 内核轨道，由 `agent.kernel` 配置切换：

| 轨道 | 包 | 何时使用 |
|------|----|-----------|
| `opencc`（默认） | `@zn-ai/zn-agent-core`（opencc 0.20.0 vendor 拷贝） | 现状默认；任何 Node 版本；行为零变化 |
| `dsh` | `@zn-ai/dsh-bridge` + `@deepseek-ai/dsh-*` | 显式配置；要求 **Node >=22.19**；B0 桩抛 `NotImplementedError`，B1a 起逐步落地 |

**配置**：

```json
// ~/.zai/settings.json   (用户级)
{
  "agent": { "kernel": "opencc" }   // 或 "dsh"
}

// <cwd>/.zai/settings.json (项目级 — 优先级 > 用户级)
{
  "agent": { "kernel": "dsh" }
}
```

解析顺序：项目级 > 用户级 > 默认 `'opencc'`。非法值 fail loud（不静默回落）。

> **dsh 真实数据目录**（Phase 1.1 收口）：`${dataDir}/dsh-sessions/<projectKey(cwd)>/<encoded sessionId>/` — 通过 `ctx.plugin(JsonlSessionPersistence, { root })` 注入。`projectKeyForCwd` 与 dsh-side `projectKey()` 算法一致（`/Users/x/y` → `--Users-x-y--`）。`dshSessionsRootAbs(dataDir)` 是 zai 侧唯一来源；`dshSessionsRoot(dataDir, cwd)` 已 deprecated。

> **dsh subagent 任务目录**：`~/.zai/tasks-dsh/<taskId>.json`（独立子目录，禁止与 opencc `~/.zai/tasks/<taskId>.json` 共用文件）。

> **dsh-subagent 上游化**（Phase 4，2026-08-22 收口）：改走 dsh 上游 `@deepseek-ai/dsh-subagent` 的 `SubagentRuntime.start('spawn', req)` —— 上游托管父子 scope / `subagent/start` / `subagent/end` 生命周期 / `run.result` Promise / `run.dispose()` 释放。**不再绕过去实现父子 turn 解耦**（之前自实现的 `<task-notification>` followup 注入会等下次提问才被消费 — 用户报 sess-1787409759412-aoh5xpnw sub-agent 一直没返回直到再次提问）。Phase 4 配套：`createDshRuntime` 装载 `SubagentRuntime` + spawn-in-process provider (`inheritsParentContext: false`,子 agent 不继承父 prompt history,cwd/provider/model 经 `agentOptions` 注入);`createDshSubagentScope` 保留 export 名做向后兼容,但函数体已退化为 `{ ctx, dispose: () => {} }` stub —— 子 scope 由 `SubagentRuntime` 内部 `bindScopeParent` 自动建立,dsh-bridge 不再显式 createScope。

> **dsh-mcp 退避**（Phase 3.2）：`MCP_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000]`（5 步指数退避），`MCP_HEALTH_CHECK_INTERVAL_MS = 30_000`。上游 `@deepseek-ai/dsh-mcp` 未发布，自实现对齐 zai `MCPClientPool` 行为。

### 引擎要求（B-1 + B0 T0.7）

仓库根 `package.json.engines` 升至 `^22.19.0 || >=24.0.0`（B0 T0.7）：
- **dsh 模式**：`createKernel` 启动前调 `nodeSupportsDsh()`，Node < 22.19 立即 fail loud 并给修复指引。
- **opencc 模式**：在 Node ≥22.19 下行为兼容（验证 opencc 单测全绿）。

### 数据隔离（双轨不互相污染）

| 数据 | opencc 轨道 | dsh 轨道 |
|------|-------------|----------|
| 会话 | `${dataDir}/projects/<cwd>/<sessionId>.jsonl` | `${dataDir}/dsh-sessions/<projectKey(cwd)>/<encoded sessionId>/` |
| 任务 | `~/.zai/tasks/<taskId>.json` | `~/.zai/tasks-dsh/<taskId>.json`（独立子目录） |
| 插件/技能来源 | `~/.zai/plugins/`、`~/.agents/skills/` | 复用同一来源 |
| 模型/凭据 | env + zai settings | 通过 zai 设置 → dsh `installModelSelection` |

**禁止两轨共享同一文件** — B6 迁移工具是唯一允许跨格式读写的代码，且默认 dry-run。

### 关键命令

```bash
pnpm --filter @zn-ai/dsh-bridge run typecheck    # dsh-bridge 类型检查
pnpm --filter @zn-ai/dsh-bridge run build        # 编译 dsh-bridge（合入 zai 前必跑；core 改动时）
pnpm --filter @zn-ai/dsh-bridge run test         # dsh-bridge 单测（135 用例 — Phase 4 taskStore.test.ts 新增 11）

# zai 侧 kernel 相关测试
pnpm --filter @zn-ai/zai test src/server/services/kernel/

# 双轨 parity harness（11 组 ServerEvent 全覆盖；B6 交付）
pnpm --filter @zn-ai/zai test test/kernel/parity/

# kill switch 演练脚本（季度执行；含 SSE drain + globalThis 桥清理）
# 默认端口 8102/7715；用空闲端口避免与正式服务冲突：
ZAI_DRILL_PORT=8107 ZAI_DRILL_API_PORT=7724 bash scripts/kill-switch-drill.sh
```

### dsh-bridge 出口（zai-side factories 使用）

`packages/dsh-bridge/src/index.ts` 暴露给 zai-side factories 调用的 API（通过 `@zn-ai/dsh-bridge` 主入口）：

```ts
import {
  createDshRuntime,           // B1a 长驻 ctx 装配
  runOnce,                    // B1a run() 驱动
  translateSessionEvent,      // B1a 核心子集事件翻译
  subscribeDshInternalEvents, // B1b agent/status → instance.status
  listDshSessions,            // B3 会话列表
  readDshSessionHeader,       // B3 单 session header
  flushDshSession,            // B3 落盘
  spawnDshSubagent,           // B5 子 agent(Phase 4: 走 dsh-subagent 上游 SubagentRuntime.start)
  createDshSubagentScope,     // Phase 4 stub: 子 scope 由上游 SubagentRuntime 托管,保留 export 仅为向后兼容
  installSlashCommands,       // B5 slash 命令
  StateBridge,                // B5 状态桥
  abortDshTurn,               // P0-4 abort
  // 等等 — 详见 packages/dsh-bridge/src/index.ts
} from '@zn-ai/dsh-bridge'
```

**重要**：`@zn-ai/dsh-bridge` 主入口**也 re-export** 关键 dsh-side 符号（避免 zai 直接依赖 `@deepseek-ai/*`）：

```ts
import {
  SessionId,           // from @deepseek-ai/dsh-session
  createUserMessage,   // from @deepseek-ai/dsh-llm
  type Session,
  type SessionEvent,
  type SessionEventType,
} from '@zn-ai/dsh-bridge'
```

**kernel 切换配置**：

```bash
zai config set agent.kernel dsh         # 切到 dsh 轨道
zai config set agent.kernel opencc      # 切回 opencc 轨道（kill switch）
# 切完后必须重启 zai 服务（运行期切换不允许 — main-plan §4.1 红线）
```

**启动期 CLI 覆盖 — `--kernel <id>`**：

```bash
zai dev --kernel=dsh                    # 不改 settings.json,本次启动强制 dsh
zai start --kernel=dsh                  # 同上,生产模式
zai dev --kernel=opencc                 # 临时回退到 opencc(无论 settings 写什么)
```

适用场景：

- 临时切轨验证(ego-browser 跑 dsh 模式工具渲染,不用动 `~/.zai/settings.json`)
- 排查"切了 dsh 后出问题"——单次启动回 opencc,不动配置
- 多 cwd 工作流(同一个 zai 二进制,不同项目目录不同默认 kernel)

行为细节：

- 优先级：`--kernel` > 项目级 `settings.json` > 用户级 `settings.json` > 默认 `'opencc'`
- **不写持久化配置** — env `ZAI_KERNEL_OVERRIDE` 仅本进程生效,关掉 zai 自然消失
- **运行期不允许切换** — 启动后改 env 不会让已加载的 adapter 换轨(主计划 §4.1 红线)
- 非法值(`--kernel=bogus`)在 boot 阶段 fail loud,抛 `InvalidAgentKernelError` 退出码 1
- 实现：`cli/index.ts` 选项 → `runDev/runStart` → `createApp({ kernelOverride })` → `process.env.ZAI_KERNEL_OVERRIDE` → `projectSettings.ts:resolveAgentKernel` 顶部 `readKernelOverride()` 命中

**会话迁移工具（B6 T6.3）**：

```bash
zai migrate --kernel dsh --dry-run                                # dry-run 验证（默认）
zai migrate --kernel dsh --target-dsh-version 0.1.0-rc.7          # 真实迁移（锁定版本）
```

### 实例级 kernel 选择

除了 CLI 启动期覆盖 + 全局 settings，每个 zai 实例（`/instances` 管理的 supervisor-spawned child）也可以独立锁定 kernel。三态语义镜像 `startPort`：

| 值 | 含义 |
|----|------|
| `undefined`（POST 缺省 / PATCH 缺省） | 继承全局：实例 supervisor spawn child 时**不**加 `--kernel`，子进程自己走 `resolveAgentKernel` 优先级 |
| `'opencc' \| 'dsh'` | supervisor spawn child 时加 `--kernel <id>`，与全局 settings 解耦 |
| `null`（仅 PATCH） | 清回"继承全局"，等价于 `undefined` |

UI（`packages/zai/src/web/src/pages/Instances.tsx`）：创建 Modal 有"实例内核"Select（默认"继承全局"）；卡片 Descriptions 第一行显示 kernel Tag（`opencc`=default、`dsh`=purple、"继承全局"=default）。

API（`packages/zai/src/server/routes/instances.ts`）：

```bash
# 创建：选 dsh
curl -X POST http://localhost:9200/api/instances \
  -H "Content-Type: application/json" \
  -d '{"name":"demo","cwd":"/path","kernel":"dsh"}'

# PATCH：清回继承
curl -X PATCH http://localhost:9200/api/instances/inst_xxx \
  -H "Content-Type: application/json" \
  -d '{"kernel":null}'

# /start per-call 覆盖（仅本次启动，不写 def）
curl -X POST http://localhost:9200/api/instances/inst_xxx/start \
  -H "Content-Type: application/json" \
  -d '{"kernel":"opencc"}'
```

实现：`shared/instances.ts` `InstanceDefinition.kernel?: InstanceKernel | null` → `instanceSupervisor.ts` `doStart` spawn args 拼 `if (effectiveKernel) args.push('--kernel', effectiveKernel)` → 子进程 `cli/start.ts` 接收 → `createApp({ kernelOverride })` → 上面"启动期 CLI 覆盖"段链路。

数据隔离：双轨 instance 各自走 cwd 的项目级 `settings.json` + `~/.zai/settings.json`；dsh 实例的 sessions/tasks 自动落到 `${dataDir}/dsh-sessions/<projectKey(cwd)>/` 与 `~/.zai/tasks-dsh/`。共享同 `instances.json`（仅持久化 instance 定义，不含 session 数据）。

### KernelAdapter 抽象

`packages/zai/src/server/services/kernel/kernelAdapter.ts` 定义 `KernelAdapter` 接口；zai 服务层只依赖此接口，不 import 任何 vendor/dsh 符号。两条轨道各自实现 `createKernelKernelAdapter`：

- `packages/zai/src/server/services/kernel/factories/opencc.ts`（B0 已交付，stub run/abort/patchTranscript）
- `packages/zai/src/server/services/kernel/factories/dsh.ts`（B0 桩，B1a 替换为真实 dsh 长驻装配）

工厂分叉：`createKernel({ cwd, dataDir, settings })` → 解析 `agent.kernel` → 引擎检查 → 动态 `import()` 对应轨道。

## 本机数据目录 `~/.zai/`

zai 把用户级配置、plugin 元数据、任务持久化等放在 `~/.zai/`(根目录常量 `ZAI_DIR = join(homedir(), '.zai')`,见 `packages/zai/src/server/services/paths.ts:23`)。**plugin 元数据/缓存全部在此目录**;`~/.claude/plugins/` 只是历史遗留的 Claude Code 副本,迁移后不再改动。

| 路径 | 职责 |
|------|------|
| `~/.zai/plugins/` | **plugin 元数据 + 缓存根**。`installed_plugins.json`(V2 schema)在这里;实际 plugin 文件在 `cache/<marketplace>/<plugin>/<version>/`,`<version>/.in_use/` 空目录标记当前使用版本。**改 plugin 走这里**,不要回 `~/.claude/plugins/cache/`。 |
| `~/.zai/projects/` | 项目级数据(per-cwd,按 cwd 路径分段命名) |
| `~/.zai/agents/` `~/.zai/skills/` | 用户级 agent/skill 定义(zai CLI 的 `agents`/`skills` 子命令来源;`ZAI_SKILLS_DIRS=''` 显式禁用) |
| `~/.zai/settings.json` | 用户级 zai 设置(全局);**项目级** 走 `<cwd>/.zai/settings.json`,不要混 |
| `~/.zai/tasks/` | 任务定义持久化 |
| `~/.zai/plans/` | plan 文件持久化 |

**关键陷阱**:
- **plugin 改文件走 `~/.zai/plugins/cache/claude-plugins-official/<name>/<version>/`**,不要去 `~/.claude/plugins/cache/`(迁移后 zai 不读)。
- **LSP/MCP 类 plugin**(typescript-lsp / pyright-lsp / context7 / chrome-devtools-mcp / ralph-loop / code-review)在 `~/.zai/plugins/cache/` 下有缓存但 zai 的 `/api/plugins` 不返回——要么缺 `.claude-plugin/plugin.json`、要么走 LSP/MCP 路径被静默排除。
- **`~/.zai/zn-assets/`** 是 `paths.ts:7-17` 注释里描述的预期 layout,当前未部署,实际 `@zn-ai/plugin` 资源走 `~/.agents/skills`(见 `agentRuntime.ts:285`)。

## dsh 相关问题优先查 vendor 源码

**调查 dsh-021 等 dsh 内核集成问题时,优先去 deepseek-harness 主仓库看 vendor 源码,再回看 dsh-bridge / zai 这边的调用链**。只在本仓库里 grep `reasoning` / `thinking` 会漏掉真正的 root cause —— dsh-side 才是语义定义的源头,本仓库只是消费者。

**主仓库路径**:`/Users/ethan/code/deepseek-harness/packages/`

| 包 | 关键目录 | 用途 |
|---|---|---|
| `llm/llm-pi-ai/src/` | `stream.ts` / `adapter.ts` / `catalog.ts` / `config.ts` / `context.ts` | pi-ai ↔ dsh 适配层 — profileOptions / resolveReasoningLevel / resolveModelReasoning / PiAiProviderProfile schema |
| `llm/llm/src/` | `assembler.ts` / `types.ts` / `message.ts` | dsh-side StreamChunk → ContentBlock 累积、ContentBlock/ReasoningBlock 类型 |
| `session/lib/types/` | `types.d.ts` / `chunk-rows.js` | SessionEvent / AssistantMessage / packChunkRuns / decodeStorageRecord |
| `session/session-persistence-jsonl/lib/` | `index.js` | JsonlSessionPersistence 写盘 / 读盘 / loadStored |
| `llm/llm-pi-ai/tests/` | `adapter.spec.ts` / `catalog.spec.ts` | dsh 内部验证,看 `forwards common stream options and profile reasoning` 这类测试能确认字段语义 |

**已构建 vendor 路径**(`pnpm` 实际跑的代码,确认与主仓库版本一致):
- `node_modules/.pnpm/@deepseek-ai+dsh-llm-pi-ai@<ver>/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/`
- `node_modules/.pnpm/@deepseek-ai+dsh-llm@<ver>/node_modules/@deepseek-ai/dsh-llm/lib/`
- `node_modules/.pnpm/@deepseek-ai+dsh-session@<ver>/node_modules/@deepseek-ai/dsh-session/lib/`
- `node_modules/.pnpm/@deepseek-ai+dsh-session-persistence-jsonl@<ver>/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/`

**dsh-bridge 出口对照**(本仓库 → 主仓库字段语义):
- `DshProviderProfile.defaultReasoningEffort` → 主仓库 `PiAiProviderProfile.reasoning`(`config.ts:146`),被 `profileOptions(profile, reasoning, apiKey)`(`adapter.ts:87-104`)读,缺省时 streamSimple 不发 `thinking: { type: 'enabled' }` 给 anthropic API
- `DshModelEntry.reasoningEfforts: string[]` → pi-ai dict `{ level: wireValue }`,经 `resolveModelReasoning`(`catalog.ts:667-721`)转 `thinkingLevelMap`
- `DshReasoningLevel`(`'off'|'minimal'|'low'|'medium'|'high'|'xhigh'`)↔ pi-ai `ModelThinkingLevel`(多一个 `'max'`,见 `catalog.ts:74-82 THINKING_LEVEL_GATE`)
- dsh `ReasoningBlock`(`{ type: 'reasoning', text }`)↔ pi-ai `ReasoningBlock` 同形,replay 阶段重写为 `{ type: 'thinking', thinking }`(`dsh-llm-pi-ai/src/replay.ts:193-198`)

**dsh-021 教训**:`zai` 配字段 → `dsh-bridge/buildProviderEntries` 静默丢弃(没消费) → `dsh-llm-pi-ai` 拿不到默认值,streamSimple 不发 thinking 参数 → API 默认关闭 thinking → UI 无 ThinkingBlock。这种"上游字段被中游丢弃"的 bug 只能从 vendor 入口配置(`PiAiProviderProfile.reasoning`)往回追到 zai 配置,反向 grep 找不到。

## 强制开发规则

- **真实浏览器验收**:任何问题修复或特性新增,完成前必须用 `/ego-browser` skill 启动真实 zai 实例并走完用户路径(页面加载、按钮点击、表单提交、截图等)。**禁止**用 Chrome DevTools MCP、Playwright、Puppeteer、`curl + WebFetch` 或单元测试替代。环境阻塞时必须显式报告。**注意**:`/ego-browser` 测试本地功能时,不要 kill 920x 端口所在的服务进程——920x 是 zai 正式服务端口, kill 后会导致真实实例不可用,应改为让 ego 使用另一个可用端口(如 8101 起)访问,或用 `pnpm --filter @zn-ai/zai dev` 启动独立开发服务。**ego-browser 在 zai dev 跑着时(SSE 长连接)实际可用**——通过 `browser-operator` skill 调真实浏览器(ego-browser)即可。早期 `feedback-ego-browser-sse-blocked` memory 已过时,不要因为旧经验跳过视觉验证。
- **移动端路由访问路径**:zai 提供两条独立路径,验证 mobile-only 功能(`MobileQuickDrawer` / `MobileAgent.tsx` / `useBashRepl` 在 drawer 内的 toast 等)时务必切到 `/m`,不要在 `/agent` 上靠缩窗口判断:
  - **`/agent`** → PC 端(`Layout.tsx` + `AgentConversation.tsx`,左侧 Sider + 右侧分屏 tab)。
  - **`/m`** → 移动端(`pages/MobileAgent.tsx`,整页重写为顶部 hamburger + 底部输入 + Drawer)。
  - 视口宽度 `< 768`(`useIsMobile.ts` `MOBILE_BREAKPOINT=768`)时 `Layout` 自身也会响应式收紧(隐藏 Sider、SplitPane 收起),但这跟 `/m` 路由是两条独立路径,**显式 mobile 路由不依赖视口宽度**。ego-browser 验证 mobile drawer 时直接访问 `/m`,无需 `Emulation.setDeviceMetricsOverride`。
- **core 改动必须先 build:core**:`packages/zn-agent-core/` 改完后的修复或特性,ego-browser 验证前**必须**先 `pnpm run build:core`。zai 进程通过 `node_modules/@zn-ai/zn-agent-core/` 加载的内容里,`dist/opencc-core.mjs` 单一 bundle、`dist/bundle-entry.d.ts`(主入口 types,机械生成)、以及 `dist/opencc-src/server/*.d.ts` 等被 bundle-entry 引用的小段 d.ts 都是构建产物,改源不会自动生效;不重建就用 ego 验证会复现到旧 core 行为,误导排错。仅改 `packages/zai/src/web/`(纯前端)或只改 zai 服务端源码(无 core 依赖)时**不需要** build:core。
- **Node-direct runtime(默认)**:`zai dev` 默认走 Node,入口为 `tsx --loader .../bun-protocol.mjs`,通过 loader 拦截 `bun:bundle` / `bun:feature`(漏掉会 `ERR_UNSUPPORTED_ESM_URL_SCHEME`)。保留 `dev:bun`(`bun run src/cli/index.ts dev`)作为可选快速运行方式。opencc vendor 是 un-stripped 全量,Node 冷启动加载较慢,属预期。
- **opencc-src vs compat**:`opencc-src/` 是 opencc 上游拷贝,但**允许修改**(类型修复、zai 补丁——改后需 `build:core` 生效)。compat 是 zai 专属别名载体。**zai 调用方统一从主入口 `@zn-ai/zn-agent-core` 取值**(2026-08-16 起全部 subpath 已废除);`src/bundle-entry.ts` 把 vendor 与 compat 符号聚合 re-export,主入口暴露 plugin DTO 等类型(`export type * from './opencc-src/server/index.js'`)与运行时。**禁止**用 tsc 整编 opencc-src(拖入 UI 传递依赖);`dist/opencc-src/server/*.d.ts` 由 `tsc -p tsconfig.server.json` 机械发射,由 `scripts/verify-server-types-self-contained.mjs` 守护 self-contained。
- **MACRO stub**:`zai-server` 启动时需在 `enableOpenccConfigs` 内调 `installMacroStub()` 预填 `globalThis.MACRO`,否则 vendor 顶层 `MACRO.X` 引用 panic。
- **CodeGraph 优先**:理解代码用 `codegraph_explore` 单调用,不要 grep + read 轮询;索引未初始化时跑 `codegraph init -i`。`codegraph_context` / `codegraph_trace` 当前 v1.4.1 不可用。
- **端口使用(必查)**:启动 `zai dev` / `zai start` 或任何本地服务前,先 `lsof -i :<port>` 确认端口空闲再起。显式 `--port` / `--api-port` 被占用必须报错退出(EADDRINUSE,dev.ts/start.ts 已实现),**禁止**静默递增换端口——多个实例静默换端口共享同一 API key 是请求风暴根因(见 `docs/superpowers/plans/` 请求风暴修复)。只有未显式指定端口时才允许自动扫描(`ports.ts resolveServerPort`)。开发中如需多实例,用不同 `--port` 显式指定空闲端口。
- **小步可逆**:实现细节见 `docs/DEVELOPMENT_REFERENCE.md`;设计/取舍见 `docs/superpowers/specs/` 与对应 `plans/`。
- **测试粒度:功能改动后只跑相关单元测试**:`pnpm -r test` 全量跑 zai + zn-agent-core + dsh-bridge 全部 **600+ 测试文件**(zai 单测 2192 用例、zn-agent-core 382、dsh-bridge 135 — 见 §双轨改造 状态行),冷启动 ~30s+ 解析 + 数十秒执行,日常反馈太慢。功能改动后只跑**直接受影响**的测试文件(以及它们的依赖文件若有连锁影响),用路径过滤:
  ```bash
  # 改了 packages/zai/src/web/src/components/SettingsDrawer.tsx
  pnpm --filter @zn-ai/zai test src/web/src/components/SettingsDrawer.test.tsx \
                                test/web/components/SettingsDrawer.restart.test.tsx
  # 改了 packages/zai/src/server/routes/instances.ts
  pnpm --filter @zn-ai/zai test test/server/routes/instances.test.ts
  ```
  仅在以下情况才跑 `pnpm -r test`:跨 workspace 重构、合并前 sanity check、CI 镜像。**禁止**把全量测试当成"完成前必跑"——这是浪费 token 和时间,反馈回路越长越容易错过真实问题。

## 常用验证命令

```bash
# TypeScript 类型检查(顶层 + 各 workspace) — 用子包 typecheck 脚本
# `pnpm -r exec tsc --noEmit` 不充分:zai 是 composite project (需 -b),
# zn-agent-core 还需跑 contract/consumer tsconfig + verify-server-types 守护脚本
pnpm -r run typecheck              # 推荐:走子包完整链路
pnpm --filter @zn-ai/zai typecheck # 仅 zai
pnpm --filter @zn-ai/zn-agent-core typecheck # 仅 core(含 d.ts 自包含校验)
```

# 单 workspace 构建(开发期加速反馈,只编自己改过的部分)
pnpm run build:core           # 只构建 @zn-ai/zn-agent-core(loader / opencc-core.mjs bundle / bundle-entry.d.ts / opencc-src/server/*.d.ts)
pnpm run build:web            # 只构建 @zn-ai/zai 的前端(vite → dist/web)
pnpm run build:zai            # 只构建 @zn-ai/zai(tsc + vite,假设 core 已构建)
# pnpm run build 仍是 core → zai 的链式全量构建(发版 / 冷启动场景)

# 单元测试 — 只跑相关文件,不要全量
pnpm --filter @zn-ai/zai test <path/to/file.test.tsx>   # 单文件
pnpm -r test -t "<describe-block-name>"                  # 按 describe 名匹配

# 启动 dev(zai + 前端)
pnpm --filter @zn-ai/zai dev
# 指定独立端口(避免与 920x 正式服务 / 8101 已占用实例冲突)
# 注意: `--` 是必需的 — `--port` / `--api-port` 是 zai CLI 的参数,
# 要靠 pnpm 的 `--` 透传,否则被 pnpm 自身吞掉或传给上一层。
# 默认 Vite 8101 / Express 7715;未显式指定时这两个端口被占用会自动扫描;
# 显式指定时若被占用会 EADDRINUSE 报错退出,不会静默换端口。
pnpm --filter @zn-ai/zai dev -- --port 8102 --api-port 7715
# 禁止: 顶层 `pnpm dev` 会同时跑所有 workspace 的 dev — zai 之外,
# zn-agent-core 的 dev 是 `tsc -b --watch`,会拒绝 `--port` 参数(TS5072),
# 整条 dev 链路失败。需要 core tsc watch 时单独跑:
pnpm --filter @zn-ai/zn-agent-core exec tsc -b --watch

# 真实浏览器验收(强制项)
/ego-browser                  # 通过 skill 调 ego-browser 驱动 zai Web UI
```

## 发布流程

```bash
# patch / minor / major
pnpm release:patch
pnpm release:minor
pnpm release:major
```

**已知坑点**：
- `pnpm publish` 在 workspace 上下文中 auth 传递有问题，第二个包（`@zn-ai/zai`）会报 `ENEEDAUTH`，即使 `npm whoami` 正常。**解决方案**：脚本已内置 fallback 自动降级到 `npm publish`。
- `npm publish` 不识别 pnpm 的 `workspace:*` 协议，如果降级到 `npm publish`，脚本会自动将 `workspace:*` 替换为实际版本号再发布，发布后恢复原始内容。
- 本仓库**配置了 origin**(github.com/hotmanxp/opencc-web.git),`release:*` 脚本发布后 commit + tag 默认只留本地,**不自动 push**;需要时显式 `git push origin main [--tags]`。

## 文档入口

| 类别 | 路径 |
|------|------|
| 架构与实现细节 | `docs/DEVELOPMENT_REFERENCE.md` |
| 双轨开发指南（切轨调试 / parity harness / kill switch 演练） | `docs/DEVELOPMENT_REFERENCE.md` §16 |
| 架构总览研究 | `docs/superpowers/specs/2026-07-25-opencc-web-architecture-overview.md` |
| SSE 状态推送设计 | `docs/superpowers/specs/2026-07-19-sse-state-push-design.md` |
| 会话压缩设计 | `docs/superpowers/specs/2026-07-19-zai-session-compaction-design.md` |
| opencc-src 直取约定 | `docs/superpowers/plans/2026-08-01-compat-direct-opencc-src-permissions.md` |
| OpenCC Server 运行时 | `docs/superpowers/specs/2026-08-01-opencc-server-runtime-design.md` |
| Provider/Model 路由覆盖 | `docs/superpowers/specs/2026-08-03-provider-model-route-overrides-design.md` |
| Agent 实例管理 | `docs/superpowers/specs/2026-08-03-zai-agent-instance-manager-design.md` |
| OpenCC Adapter(Node/tsx) | `docs/superpowers/specs/2026-07-29-zn-agent-core-opencc-adapter-node-design.md`(Bun 版已 deprecated) |
| 类型化 RPC client stub | `docs/superpowers/specs/2026-08-16-rpc-type-safe-client-stubs.md` |
| 命令生命周期事件埋点 | `docs/superpowers/specs/2026-08-16-command-lifecycle-events.md` |
| dsh 主计划 | `docs/superpowers/plans/2026-08-17-dsh-kernel-main-plan.md` |
| dsh 批次 B0-B7 | `docs/superpowers/plans/2026-08-17-dsh-kernel-batch-*.md` |
| G2 决策评审 | `docs/superpowers/plans/2026-08-17-dsh-kernel-decision.md` |
| 双轨维护契约 | `docs/2026-08-17-dsh-maintenance-contract.md` |
| vendor 退役评估 | `docs/2026-08-17-dsh-vendor-retirement.md` |
| dsh 发布说明 | `docs/2026-08-17-dsh-release-notes.md` |

> 历史 spec / plan 完整列表见 `docs/superpowers/specs/` 与 `docs/superpowers/plans/`,命名 `YYYY-MM-DD-<topic>.md`。

<!-- updated: 2026-08-22 (B7: dsh G2 决策 + 维护契约 + vendor 退役评估) -->
<!-- updated: 2026-08-22 (pass-2: 技术栈表 — Node 22.19/Vitest 子包隔离/dsh-bridge 行/补充 zai 服务端依赖;目录表 — scripts 拆分 + 根 .zai 说明;typecheck 改用子包脚本;测试规模 190+ → 600+ 文件) -->
<!-- updated: 2026-08-22 (Phase 4: dsh-subagent 改走上游 SubagentRuntime.start — 状态行补 Phase 4 收口;技术栈 dsh-* 24 → 35;测试 55 → 135;Phase 3.1 自实现 section 替换为 Phase 4 上游化说明;createDshSubagentScope 注释更新为 stub) -->
