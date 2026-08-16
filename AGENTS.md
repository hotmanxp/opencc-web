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
| `packages/zn-agent-core/` | `compat/`(verbatim 移植的 zai 兼容垫片)+ `opencc-src/`(opencc 0.20.0 拷贝,Bun 兼容(un-stripped));`scripts/bundle-opencc.ts` 把 `src/bundle-entry.ts` 编成单一 `dist/opencc-core.mjs`(esbuild bundle)。**运行时与 types 都从主入口 `@zn-ai/zn-agent-core` 导出**(2026-08-16 起废除全部 subpath);`dist/bundle-entry.d.ts` 由 `bundle-opencc.ts` 机械生成,与 bundle 同步 |
| `docs/` | 设计/参考/操作指南;`docs/superpowers/specs/` 是各特性 spec,`docs/superpowers/plans/` 是实施计划 |
| `examples/` `scripts/` | 示例 / 仓库脚本 |

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

## 强制开发规则

- **真实浏览器验收**:任何问题修复或特性新增,完成前必须用 `/ego-browser` skill 启动真实 zai 实例并走完用户路径(页面加载、按钮点击、表单提交、截图等)。**禁止**用 Chrome DevTools MCP、Playwright、Puppeteer、`curl + WebFetch` 或单元测试替代。环境阻塞时必须显式报告。**注意**:`/ego-browser` 测试本地功能时,不要 kill 920x 端口所在的服务进程——920x 是 zai 正式服务端口, kill 后会导致真实实例不可用,应改为让 ego 使用另一个可用端口(如 8101 起)访问,或用 `pnpm --filter @zn-ai/zai dev` 启动独立开发服务。
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
