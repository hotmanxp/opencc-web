# AGENTS.md - opencc-web

## 项目概述

**opencc-web** 是 zai 的本地开发与运行工具集,在 `packages/zai`(Express + SSE server + React/Zustand/AntD 前端)与 `packages/zn-agent-core`(Agent 运行时核心库)两个 workspace 中实现 Agent 对话、流式 UI、命令/Skill/插件等能力。zai 仅监听 localhost,不依赖外部鉴权。

## 技术栈

| 层 | 技术 | 版本 |
|----|------|------|
| 语言 | TypeScript | ^5.6 |
| 运行时 | Node(direct, tsx + bun-protocol) / Bun 可选(`dev:bun`) | Node >=20 |
| zai 前端 | React + Zustand + AntD + Vite | 18.3 / 4.5 / 5.22 / 8.1 |
| zai 服务端 | Express + SSE | ^4.21 |
| zn-agent-core vendor | opencc 0.20.0(Bun 兼容(un-stripped)) | — |
| 测试 | Vitest | ^4.1 |

## 目录

| 目录 | 职责 |
|------|------|
| `packages/zai/` | `src/server/` 路由 + service,`src/web/` UI + store,`src/shared/` zod schema |
| `packages/zn-agent-core/` | `compat/`(verbatim 移植的 zai 兼容垫片)+ `opencc-src/`(opencc 0.20.0 拷贝,Bun 兼容(un-stripped));`scripts/bundle-opencc.mjs` 单文件编子路径 |
| `docs/` | 设计/参考/操作指南;`docs/superpowers/specs/` 是各特性 spec,`docs/superpowers/plans/` 是实施计划 |
| `examples/` `scripts/` | 示例 / 仓库脚本 |

## 本机数据目录 `~/.zai/`

zai 把用户级配置、plugin 元数据与缓存、后台任务持久化等统一放在 `~/.zai/`(根目录常量 `ZAI_DIR = join(homedir(), '.zai')`,见 `packages/zai/src/server/services/paths.ts:23`)。**插件元数据/缓存全部在此目录,**`~/.claude/plugins/` 只是历史遗留的 Claude Code 副本,迁移后不再改动。

| 路径 | 职责 |
|------|------|
| `~/.zai/plugins/` | **plugin 元数据 + 缓存根**。`installed_plugins.json`(V2 schema)在这里;实际 plugin 文件在 `cache/<marketplace>/<plugin>/<version>/`,`<version>/.in_use/` 空目录标记当前使用版本。**改 plugin 走这里**,不要回 `~/.claude/plugins/cache/`。`~/.zai/plugins/cache/` 历史上是 marketplace 拉取缓存,2026-08-09 起 installPath 全部指向这里。 |
| `~/.zai/agents/` | 用户级 agent 定义(`zai agents` 子命令) |
| `~/.zai/skills/` | 用户级 skill 定义,默认被 `SkillTool` 加载(可被 `ZAI_SKILLS_DIRS=''` 显式禁用) |
| `~/.zai/background/` | bg-agent 后台任务运行时持久化:`tasks/<id>.json` + `events/<id>.log`(见 `paths.ts:26`) |
| `~/.zai/settings.json` | 用户级 zai 设置(全局生效);**项目级** 设置走 `<cwd>/.zai/settings.json`,不要混 |
| `~/.zai/instances.json` | 多实例注册表(zai instance manager) |
| `~/.zai/file-history/` | zai 编辑历史(`FileEditTool` 写入的快照) |
| `~/.zai/session-env/` | session 环境变量快照 |
| `~/.zai/shell-snapshots/` | Bash REPL 状态 snapshot(用于 session 恢复) |
| `~/.zai/repl-history.jsonl` | Bash REPL 命令历史 |
| `~/.zai/tasks/` | 任务定义持久化 |
| `~/.zai/plans/` | plan 文件持久化 |
| `~/.zai/logs/` | zai 运行日志 |
| `~/.zai/backups/` | 自动备份 |
| `~/.zai/scratchpad/` | 临时 scratch |
| `~/.zai/state/` | 全局 state(可跨 session) |
| `~/.zai/projects/` | 项目级数据(per-cwd) |
| `~/.zai/manifest.json` | 顶层 manifest |
| `~/.zai/.claude-migration-v1.json` | Claude Code → zai 迁移标记,删了会导致重新迁移 |

**关键陷阱**：
- **plugin 改文件走 `~/.zai/plugins/cache/claude-plugins-official/<name>/<version>/`**,不要去 `~/.claude/plugins/cache/` 找(那是迁移前 installPath 指向的历史位置,迁移后 zai 不读它)。
- **LSP/MCP 类 plugin**(typescript-lsp / pyright-lsp / context7 / chrome-devtools-mcp / ralph-loop / code-review)在 `~/.zai/plugins/cache/` 下**有缓存但 zai 的 `/api/plugins` 不返回**——它们要么缺 `.claude-plugin/plugin.json`、要么走 LSP/MCP 路径被静默排除;installed_plugins.json 列了不等于 zai 实际加载。
- **`~/.zai/zn-assets/<version>/{agents,commands,skills,extensions}/`** 是 `paths.ts:7-17` 注释里描述的预期 layout(`ZN_ASSETS_DIR` 常量),用于将来缓存 `@zn-ai/plugin` 资源。**当前未部署**——实际 `@zn-ai/plugin` 资源走 `~/.agents/skills`(`AGENTS_SKILLS_DIR` 常量,见 `agentRuntime.ts:285`),与 Nova CLI / OpenCode / OpenCC 共享(根 `AGENTS.md` 默认约定)。`~/.zai/zn-assets/` 不存在属预期,不要手动 mkdir。

## 强制开发规则

- **真实浏览器验收**:任何问题修复或特性新增,完成前必须用 `/ego-browser` skill 启动真实 zai 实例并走完用户路径(页面加载、按钮点击、表单提交、截图等)。**禁止**用 Chrome DevTools MCP、Playwright、Puppeteer、`curl + WebFetch` 或单元测试替代。环境阻塞时必须显式报告。**注意**:`/ego-browser` 测试本地功能时,不要 kill 920x 端口所在的服务进程——920x 是 zai 正式服务端口, kill 后会导致真实实例不可用,应改为让 ego 使用另一个可用端口(如 8101 起)访问,或用 `pnpm --filter @zn-ai/zai dev` 启动独立开发服务。
- **Node-direct runtime(默认)**:`zai dev` 默认走 Node,入口为 `tsx --loader .../bun-protocol.mjs`,通过 loader 拦截 `bun:bundle` / `bun:feature`(漏掉会 `ERR_UNSUPPORTED_ESM_URL_SCHEME`)。保留 `dev:bun`(`bun run src/cli/index.ts dev`)作为可选快速运行方式。opencc vendor 是 un-stripped 全量,Node 冷启动加载较慢,属预期。
- **opencc-src vs compat**:verbatim 移植的 compat 文件,若 opencc 上游是纯类型/常量,优先让 zai 调用方**直接**从 `opencc-src/<name>` 取值,compat 仅留作 zai 专属别名载体。`scripts/bundle-opencc.mjs` 用 esbuild `bundle: false` 单文件编 → `dist/opencc-src/types/<name>.js` 暴露子路径。**禁止**用 tsc 整编 opencc-src(拖入 UI 传递依赖)。详见 plan `docs/superpowers/plans/2026-08-01-compat-direct-opencc-src-permissions.md`。
- **MACRO stub**:`zai-server` 启动时需在 `enableOpenccConfigs` 内调 `installMacroStub()` 预填 `globalThis.MACRO`,否则 vendor 顶层 `MACRO.X` 引用 panic。
- **CodeGraph 优先**:理解代码用 `codegraph_explore` 单调用,不要 grep + read 轮询;索引未初始化时跑 `codegraph init -i`。`codegraph_context` / `codegraph_trace` 当前 v1.4.1 不可用。
- **端口使用(必查)**:启动 `zai dev` / `zai start` 或任何本地服务前,先 `lsof -i :<port>` 确认端口空闲再起。显式 `--port` / `--api-port` 被占用必须报错退出(EADDRINUSE,dev.ts/start.ts 已实现),**禁止**静默递增换端口——多个实例静默换端口共享同一 API key 是请求风暴根因(见 `docs/superpowers/plans/` 请求风暴修复)。只有未显式指定端口时才允许自动扫描(`ports.ts resolveServerPort`)。开发中如需多实例,用不同 `--port` 显式指定空闲端口。
- **小步可逆**:实现细节见 `docs/DEVELOPMENT_REFERENCE.md`;设计/取舍见 `docs/superpowers/specs/` 与对应 `plans/`。
- **测试粒度:功能改动后只跑相关单元测试**:`pnpm -r test` 全量跑 zai + zn-agent-core 全部 190+ 测试文件 / 1400+ 用例,冷启动 ~30s+ 解析 + 数十秒执行,日常反馈太慢。功能改动后只跑**直接受影响**的测试文件(以及它们的依赖文件若有连锁影响),用路径过滤:
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
# TypeScript 类型检查(顶层 + 各 workspace)
pnpm -r exec tsc --noEmit

# 单元测试 — 只跑相关文件,不要全量
pnpm --filter @zn-ai/zai test <path/to/file.test.tsx>   # 单文件
pnpm -r test -t "<describe-block-name>"                  # 按 describe 名匹配

# 启动 dev(zai + 前端)
pnpm --filter @zn-ai/zai dev

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
- 发布后 tag 不会自动推送，需手动执行 `git push && git push --tags`。

## 文档入口

| 类别 | 路径 |
|------|------|
| 架构与实现细节 | `docs/DEVELOPMENT_REFERENCE.md` |
| 架构总览研究 | `docs/superpowers/specs/2026-07-25-opencc-web-architecture-overview.md` |
| SSE 状态推送设计 | `docs/superpowers/specs/2026-07-19-sse-state-push-design.md` |
| 会话压缩设计 | `docs/superpowers/specs/2026-07-19-zai-session-compaction-design.md` |
| opencc-src 直取约定 | `docs/superpowers/plans/2026-08-01-compat-direct-opencc-src-permissions.md` |
| OpenCC Server 运行时 | `docs/superpowers/specs/2026-08-01-opencc-server-runtime-design.md` |
| Provider/Model 路由覆盖 | `docs/superpowers/specs/2026-08-03-provider-model-route-overrides-design.md` |
| Agent 实例管理 | `docs/superpowers/specs/2026-08-03-zai-agent-instance-manager-design.md` |
| OpenCC Adapter(Node/tsx) | `docs/superpowers/specs/2026-07-29-zn-agent-core-opencc-adapter-node-design.md`(Bun 版已 deprecated) |

> 历史 spec / plan 完整列表见 `docs/superpowers/specs/` 与 `docs/superpowers/plans/`,命名 `YYYY-MM-DD-<topic>.md`。

<!-- updated: 2026-08-06 -->
