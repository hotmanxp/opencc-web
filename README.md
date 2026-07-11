# opencc-web

知鸟 AI 统一工具平台 — 本地 Web 管理界面 + 可嵌入的 Agent Runtime Core。

本仓库聚焦两件事:

- **`@zn-ai/zai`** — 本地运行的 Web 管理平台(仪表盘 / 工具管理 / 资源浏览 / 登录管理 / 配置编辑 / Agent 对话)
- **`@zn-ai/zai-agent-core`** — 从 OpenCC 抽离的进程内 Agent Runtime(对话 / 工具 / Skills / MCP / transcript)

> 历史背景:本仓库早期承担 `zn-agent-assets` 资源库的载体,后转型为 zai + zai-agent-core 的 monorepo,资源仓库已拆分独立维护。

---

## 项目结构

```
opencc-web/
├── packages/
│   ├── zai/                       # @zn-ai/zai — 本地 Web 管理平台
│   │   ├── bin/zai.js             # CLI 入口(包装 dist/cli)
│   │   ├── src/cli/               # dev / start 命令
│   │   ├── src/server/            # Express API(routes + services)
│   │   ├── src/web/src/           # React 前端(pages + components + store)
│   │   └── test/                  # Vitest 测试
│   │
│   └── zai-agent-core/            # @zn-ai/zai-agent-core — Agent Runtime
│       ├── src/opencc-internals/  # 从 OpenCC 同步过来的运行时源码
│       ├── src/runtime/           # query / DefaultAgentRuntime / streamAdapter
│       ├── src/mcp/               # MCPClientPool + MCPToolAdapter
│       ├── src/tools/             # 工具实现(Bash / Read / Write / ...)
│       ├── src/transcript/        # JSON 文件 transcript 存储
│       └── scripts/sync-from-opencc.ts
│
├── scripts/
│   └── zn-ai (zn-ai.bat)          # zn-env 环境管理脚本(检测 nova/opencc/opencode 等 CLI 安装状态)
│
├── examples/
│   └── mcp-smoke/                 # MCP 集成冒烟测试(stdio MCP 服务器 + smoke 验证)
│
├── docs/                          # 项目文档
│   ├── AI_AGENT_WORKFLOW.md
│   ├── AI_CLI_SETUP.md
│   ├── RESOURCE_INSTALL.md
│   ├── CHROME_DEVTOOLS_MCP.md
│   ├── npm-bin-configuration.md
│   ├── zn-harness-transformation.md
│   └── superpowers/{specs,plans}/ # 设计文档与实施计划
│
├── AGENTS.md                      # 给 agent 看的项目说明
├── CONTRIBUTING.md                # 贡献指南(沿用资源库时期的格式)
├── opencode.jsonc                 # OpenCode 配置(启用 codegraph MCP)
├── .mcp.json                      # Claude/OpenCC MCP 配置(codegraph + chrome-devtools)
└── pnpm-workspace.yaml
```

---

## 快速开始

### 环境要求

- **Node.js 20+**(`.nvmrc` 锁定 20)
- **pnpm**(推荐,monorepo 由 `pnpm-workspace.yaml` 管理)
- macOS / Linux / Windows

### 安装与构建

```bash
# 1. 安装依赖(workspace 内一次性装齐)
pnpm install

# 2. 构建 @zn-ai/zai-agent-core(zai 依赖其 dist/)
pnpm --filter @zn-ai/zai-agent-core build

# 3. 构建 @zn-ai/zai(后端 tsc + 前端 vite)
pnpm --filter @zn-ai/zai build

# 4. 全量构建
pnpm -r run build
```

### 运行 zai

```bash
# 开发模式(Vite HMR + Express,自动打开浏览器)
pnpm --filter @zn-ai/zai dev
# → Vite: http://localhost:9888
# → API : http://localhost:7715

# 生产模式
pnpm --filter @zn-ai/zai build
pnpm --filter @zn-ai/zai start
```

CLI 子命令(由 `commander` 注册):

| 命令 | 说明 |
|------|------|
| `zai dev` | 启动 Vite 开发服务器 + Express API |
| `zai start` | 启动生产服务器(静态 SPA + API) |
| `zai --version` | 输出版本号(读 `package.json`) |
| `zai --help` | 内置帮助 |

默认行为:`zai` 不带参数时等同于 `zai start`。

### 跑 MCP 冒烟测试

```bash
pnpm --filter @zn-ai/zai-agent-core build
node examples/mcp-smoke/smoke.mjs
```

会启动一个 stdio MCP 服务器,用 `MCPClientPool` 接入并验证 `echo` 工具 + 指令注入 + 工具调用链路。

---

## 各模块详情

### `@zn-ai/zai`

**版本**: 0.0.8 · **类型**: 本地工具 (private) · **引擎**: Node ≥ 20

**功能**:
- 仪表盘(系统信息 + 快速启动)
- 工具管理(nova / opencode / opencc 等 CLI 状态)
- 资源浏览(Skills / Commands / Extensions / Agents 计数与详情)
- 登录管理(PA 神兵 / 开放平台,通过系统终端调 `@zn-ai/agent-login`)
- 配置编辑(Nova / OpenCode / OpenCC `settings.json` 可视化改写,临时文件 + rename 原子写入)
- Agent 对话(SSE 流式,内置 AskUserQuestion 交互)

**技术栈**:
- 后端:Node 20 / Express 4 / TypeScript 5 / Zod
- 前端:React 18 / Vite 5 / Ant Design 5 / Tailwind 3 / Zustand / React Router 6
- 测试:Vitest + Supertest + Testing Library

**关键目录**:
```
packages/zai/src/server/routes/   # API: health/system/cli/dirs/login/config/resources/quickstart/exec/agent/answer
packages/zai/src/server/services/ # 业务逻辑: detect/spawner/fileStore/osascript/loginRunner/manifest
packages/zai/src/web/src/pages/   # Dashboard / Tools / Resources / Login / Config / Directory / Agent
```

详见 `packages/zai/README.md`。

### `@zn-ai/zai-agent-core`

**版本**: 0.1.0 · **类型**: public(npm: `@zn-ai/zai-agent-core`,发到内部 Nexus)

**用法**:
```ts
import { DefaultAgentRuntime } from '@zn-ai/zai-agent-core'

const runtime = new DefaultAgentRuntime({ dataDir: '~/.zai' })
const stream = runtime.run({ prompt: '你好', cwd: '/project' })
for await (const event of stream) {
  console.log(event.type, event)
}
```

**架构**:
- `src/opencc-internals/` — 从 OpenCC 同步过来的内部模块(TUI 已剔除)
- `src/runtime/` — runtime facade(`query()`,`DefaultAgentRuntime`,`streamAdapter`)
- `src/transcript/` — JSON 文件 transcript 持久化
- `src/data/` — dataDir 路径解析
- `src/mcp/` — MCP 接入层(`MCPClientPool` / `MCPToolAdapter` / `mcpInstructions` / `permission-matcher`)

**与上游 OpenCC 同步**:
```bash
pnpm --filter @zn-ai/zai-agent-core sync-from-opencc --dry-run   # 预览
pnpm --filter @zn-ai/zai-agent-core sync-from-opencc --apply     # 落地
```

**测试**:
```bash
pnpm test        # 单元 + 集成
pnpm test:e2e    # 真实 LLM(需凭据)
```

详见 `packages/zai-agent-core/README.md`。

### `scripts/zn-ai`(`zn-env`)

Bash + Batch 双版本(分别 `scripts/zn-ai` 与 `scripts/zn-ai.bat`,mac/Linux 用前者,Windows 用后者)。

`zn-env` 提供 Nova CLI / OpenCode / OpenCC 的环境检测与初始化能力:

- 检测本机安装方式(pnpm / npm / yarn)
- 打印 Node 版本、npm prefix、registry
- 检查 nova / opencode / opencc 的安装路径与可用性
- 扫描 `~/.nova/` 与 `~/.config/opencode/` 中的 agents / commands / plugins
- 调用 `npx @zn-ai/agent-login@latest` 完成登录

不通过 npm 分发,直接在 shell 里 `source scripts/zn-ai` 或加入 `$PATH` 使用。

### `examples/mcp-smoke`

MCP 集成冒烟测试示例,纯 Node + `@modelcontextprotocol/sdk`,无需打包工具即可运行。

- `server.mjs` — stdio MCP 服务器,提供一个 `echo` 工具 + server `instructions`
- `smoke.mjs` — 启动服务器 → 接入 `MCPClientPool` → 适配工具 → 验证 prompt / description / call

适合作为新增 MCP 工具或适配器改动的回归脚本。

---

## 测试

```bash
# 全 monorepo 测试(vitest 会按 vitest.config.ts 的 include 抓包)
pnpm test

# 单独跑 zai 或 zai-agent-core
pnpm --filter @zn-ai/zai test
pnpm --filter @zn-ai/zai-agent-core test

# 监听模式
pnpm test:watch
```

`vitest.config.ts`(根)默认只收集以下包的测试:

- `packages/agent-login/src/**/*.test.ts`(预留)
- `packages/publisher/src/**/*.test.ts`(预留)

子包有各自的 `vitest.config.ts`,会根据自身 include 模式运行。

---

## MCP 与 Agent 配置

仓库带两份 MCP 配置,二者用途不同:

**`.mcp.json`** — 给 OpenCC / Claude Code 读:

```jsonc
{
  "mcpServers": {
    "codegraph":        { "type": "stdio", "command": "codegraph", "args": ["serve", "--mcp"] },
    "chrome-devtools":  { "type": "stdio", "command": "npx",      "args": ["-y", "chrome-devtools-mcp@latest"] }
  }
}
```

**`opencode.jsonc`** — 给 OpenCode 读,目前只挂 `codegraph`。

**CodeGraph** CLI(v1.4.1,只暴露 `codegraph_explore` 一个工具)提供基于 AST 的代码知识图谱,优先用它代替 grep + read 轮询。详细使用规则见 `AGENTS.md`。

---

## 文档

| 文档 | 用途 |
|------|------|
| `docs/AI_AGENT_WORKFLOW.md` | 基于 zn-agent-assets 的从开发到测试全流程实践指南 |
| `docs/AI_CLI_SETUP.md` | Nova CLI / OpenCode / OpenCC 三款 CLI 的安装配置手册 |
| `docs/RESOURCE_INSTALL.md` | `zn-agent-plugin` 资源安装指南(已转给资源库项目) |
| `docs/CHROME_DEVTOOLS_MCP.md` | chrome-devtools MCP 使用指南 |
| `docs/npm-bin-configuration.md` | `npm bin` 路径与 `zai` CLI 暴露方式说明 |
| `docs/zn-harness-transformation.md` | zn-harness 转型记录 |
| `docs/superpowers/specs/*.md` | 各子项目设计文档(AskUser / MCP / Skill / subagent 等) |
| `docs/superpowers/plans/*.md` | 对应实施计划 |
| `AGENTS.md` | 给 AI agent 看的项目说明(目录结构、构建、提交规范、平台差异) |
| `CONTRIBUTING.md` | 贡献指南(沿用资源库时期的格式,新增资产时参考) |
| `packages/zai/README.md` | zai 包级文档 |
| `packages/zai-agent-core/README.md` | zai-agent-core 包级文档 |

---

## 提交规范

遵循 Conventional Commits,类型与中英文混用均可:

```
feat: 新功能 | fix: 修复 | docs: 文档 | refactor: 重构
chore: 工具链 | style: 格式 | test: 测试
```

---

## 平台差异(资源产出目标)

zai / zai-agent-core 不是资源安装工具,但资源产出会落到下列目录:

| 资源 | Nova CLI | OpenCode | OpenCC |
|------|----------|----------|--------|
| agents | `~/.nova/agents/` | `~/.config/opencode/agents/` | `~/.claude/agents/` |
| commands | `~/.nova/commands/` (.toml) | `~/.config/opencode/commands/` (.md) | `~/.claude/commands/` (.md) |
| skills | `~/.agents/skills/` (共享) | `~/.agents/skills/` (共享) | `~/.agents/skills/` (共享) |
| extensions | `~/.nova/extensions/` | 不支持 | 不支持 |

---

## 许可证

MIT

---

**维护者**:ZN-AI Team
