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
| 测试 | Vitest | ^5.0.3(vitest 5 起 `vite` 是必需 peer dep) |

> 两个 workspace 包版本号同步 bump,当前均为 `0.13.4`(`@zn-ai/zai` / `@zn-ai/zn-agent-core`)。

## 目录

| 目录 | 职责 |
|------|------|
| `packages/zai/` | `src/server/` 路由 + service,`src/web/` UI + store,`src/shared/` zod schema |
| `packages/zn-agent-core/` | `src/compat/`(zai 兼容垫片)+ `src/opencc-src/`(opencc 0.20.0 拷贝);`scripts/bundle-opencc.ts` 把 `src/bundle-entry.ts` 编成单一 `dist/opencc-core.mjs` |
| `docs/` | `DEVELOPMENT_REFERENCE.md` 实现细节;`docs/superpowers/specs/` 各特性 spec,`docs/superpowers/plans/` 实施计划 |

**运行时与 types 都从主入口 `@zn-ai/zn-agent-core` 导出**(2026-08-16 起废除全部 subpath)。`dist/bundle-entry.d.ts` 由 `bundle-opencc.ts` 机械生成,与 bundle 同步。

## 本机数据目录 `~/.zai/`

根目录常量 `ZAI_DIR = join(homedir(), '.zai')`(`packages/zai/src/server/services/paths.ts:23`)。**plugin 元数据/缓存全部在此目录**;`~/.claude/plugins/` 只是历史遗留副本,迁移后不再改动。

| 路径 | 职责 |
|------|------|
| `~/.zai/plugins/` | **plugin 元数据 + 缓存根**。`installed_plugins.json`(V2 schema);plugin 文件在 `cache/<marketplace>/<plugin>/<version>/`,`<version>/.in_use/` 标记当前使用版本 |
| `~/.zai/projects/` | 项目级数据(per-cwd) |
| `~/.zai/agents/` `~/.zai/skills/` | 用户级 agent/skill 定义(`agents`/`skills` 子命令来源) |
| `~/.zai/settings.json` | 用户级设置;**项目级**走 `<cwd>/.zai/settings.json`,不要混 |
| `~/.zai/tasks/` `~/.zai/plans/` | 任务定义 / plan 持久化 |
| `~/.zai/weixin/` | 微信子系统(`accounts/` `locks/` `sync/` `context-tokens/` `media/` `sessions.json` 等),详见 `DEVELOPMENT_REFERENCE.md` §15 |

**关键陷阱**:
- **改 plugin 走 `~/.zai/plugins/cache/claude-plugins-official/<name>/<version>/`**,不要回 `~/.claude/plugins/cache/`。
- **LSP/MCP 类 plugin**(typescript-lsp / pyright-lsp / context7 / chrome-devtools-mcp / ralph-loop / code-review)有缓存但 `/api/plugins` 不返回 —— 要么缺 `.claude-plugin/plugin.json`,要么走 LSP/MCP 路径被静默排除。
- `~/.zai/zn-assets/` 是注释里描述的预期 layout,**当前未部署**;实际 `@zn-ai/plugin` 资源走 `~/.agents/skills`。

## 强制开发规则

- **系统提示词一律用英文**:所有写入代码的 prompt —— Agent 描述(`description`/`systemPrompt`)、subagent 提示词、工具描述、LLM 指令模板、skill/agent frontmatter description —— **禁止写中文**。用户可见 UI 文案走 i18n,不受此限。
- **core 改动必须先 `build:core`**:改完 `packages/zn-agent-core/` 后,用 ego-browser 验证前**必须**先 `pnpm run build:core`。`dist/opencc-core.mjs`、`dist/bundle-entry.d.ts`、`dist/opencc-src/server/*.d.ts` 全是构建产物,改源不自动生效,不重建会复现旧行为误导排错。仅改 `packages/zai/src/web/`(纯前端)时不需要。
- **真实浏览器验收(先询问,非强制门禁)**:完成前**询问用户**是否跑 `/ego-browser`(走完用户路径 + 截图),确认后再执行;环境阻塞必须显式报告。**不要 kill 920x 端口的进程** —— 920x 是 zai 正式服务端口,kill 后真实实例不可用;改用其他空闲端口(如 8101 起)或 `pnpm --filter @zn-ai/zai dev` 独立实例。ego-browser 在 zai dev 跑着(SSE 长连接)时实际可用。
- **测试粒度:只跑直接受影响的文件**:`pnpm -r test` 全量 520+ 文件约 4.5 分钟,**别为了提速去撤 `packages/zai/vitest.config.ts` 的 `fileParallelism: false`** —— 并行会稳定复现 flaky(PdfRenderer 翻页、replHistory 30s 超时),而两者隔离单跑 100% 稳定。仅跨 workspace 重构 / 合并前 sanity check / CI 才跑全量。
- **样式:优先 Tailwind utility class**,不要写 `style={{...}}`。Tailwind 3.4.15 链路完整(`tailwind.config.ts` + `postcss.config.js` + `index.css`)。**保留 inline 的 7 类合法场景**见 `DEVELOPMENT_REFERENCE.md` §20;评审时不在 7 类之列的新增 inline 应驳回。
- **样式改动不跑单元测试**:happy-dom/jsdom 不渲染 CSS cascade、不模拟 paint,红绿没意义。改 `index.css` 或组件样式后用 `/ego-browser` 度量像素级证据(rect / getComputedStyle / 截图对比)才算数。
- **端口使用(必查)**:起任何本地服务前先 `lsof -i :<port>` 确认空闲。显式 `--port`/`--api-port` 被占用必须报错退出(EADDRINUSE),**禁止静默递增换端口** —— 多实例静默换端口共享同一 API key 是请求风暴根因。只有未指定端口时才允许自动扫描(`ports.ts resolveServerPort`)。多实例开发用不同 `--port` 显式指定。
- **Node-direct runtime(默认)**:`zai dev` 入口是 `tsx --loader .../bun-protocol.mjs`,loader 拦截 `bun:bundle`/`bun:feature`(漏掉报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`)。`dev:bun` 是可选快速路径。vendor 是 un-stripped 全量,Node 冷启动慢属预期。
- **`opencc-src` 允许修改**(类型修复、zai 补丁,改后需 `build:core`);`src/compat/` 是 zai 专属别名载体。**禁止**用 tsc 整编 `opencc-src`(拖入 UI 传递依赖);`dist/opencc-src/server/*.d.ts` 由 `tsc -p tsconfig.server.json` 机械发射,由 `scripts/verify-server-types-self-contained.mjs` 守护。
- **vendor 终端 UI 已就地 stub(2026-10-04)**:426 个 `.tsx` 组件体已替换为 `return null`,**读这些文件不要找 UI 逻辑**。改组件时守住三条签名不变量(`LocalJSXCommandCall` 非 async 的 `call` 必须 `return Promise.resolve(null)`;显式返回标注放宽成 `T | null`;**async 函数绝不能加 `| null`**),并注意模块顶层 `React.createContext` 不受保护 —— 改完必须 `node -e "import('./dist/opencc-core.mjs')"` 实测。完整约束见 `DEVELOPMENT_REFERENCE.md` §19。
- **微信通道只有 `app=weixin` 的专用实例跑**:主实例不再自己跑微信通道,启动时按 `settings.weixinBot.enabled` 检查机器级 owner 锁,无锁则拉起受管子实例独占通道(默认端口 9199)。必须同进程(入站注入与出站镜像都走进程内 `getSessionInbox()` / `eventBus`)。**微信配置入口只在主实例显示**,判据是 `instanceContext.instanceId == null`(`SettingsDrawer.tsx:920` 的 `weixinConfigVisible`),**不能用 `isManagedChild`**。详见 `DEVELOPMENT_REFERENCE.md` §15。
- **分屏 Bash 面板 = 持久 PTY**(`node-pty` + xterm.js,多 tab)。三条约束:① `node-pty` 是原生模块,必须在 `pnpm-workspace.yaml` 的 `allowBuilds` 与根 `package.json` 的 `pnpm.onlyBuiltDependencies` 里,否则装出 load 不了的 `pty.node`;② **只有可见 tab 开 SSE**(同源连接数有限),切 tab 关旧开新,新连接首帧 `snapshot` 恢复整屏;③ **PTY 必须显式回收**三处 —— 关 tab / 删会话(`disposeSession`) / 进程退出(`disposeAll`),缺一会留孤儿 zsh。详见 `DEVELOPMENT_REFERENCE.md` §16。
- **CodeGraph 优先**:理解代码用 `codegraph_explore` 单调用,不要 grep + read 轮询;索引未初始化跑 `codegraph init -i`(`codegraph_context` / `codegraph_trace` 在 v1.4.1 不可用)。
- **API 端点索引**与**前端路由路径表**(`/agent` `/m` `/desktop` `/super-tasks` 等)见 `DEVELOPMENT_REFERENCE.md` §17 / §18 —— 验证功能前先查目标路由,不要靠缩窗口判断。
- **桌面端(`apps/desktop`)不 import zai,也不加 preload**:壳只做三件事 —— 窗口、`zai start` 子进程生命周期、两者之间的交接。窗口直接加载 `http://127.0.0.1:<port>`(zai 本就监听 loopback、自带 web 产物、路由无鉴权),所以既不需要自定义特权协议,也不需要向渲染进程暴露桥。子进程用 `ELECTRON_RUN_AS_NODE=1` 跑 Electron 自带的 Node,不额外打包 Node 运行时;`ZAI_NO_MANAGED=1` 避免再套一层 supervisor。**改壳之前先读 [`apps/desktop/README.md`](apps/desktop/README.md)**,里面记着 native 模块 ABI、签名、平台支持等已知限制。打包目标只有 `mac-arm64` / `mac-x64` / `win-x64`;`packages/*` 是被 zai 依赖的库,`apps/*` 是独立应用产物,两者不混放。
- **`packages/zai` 的 `dependencies` 只放服务端运行时真正 import 的包,纯前端包一律放 `devDependencies`**:前端由 Vite 打成自包含产物(`dist/web`,已验证不含任何裸模块说明符),桌面端再用 `pnpm deploy --prod` 打运行时树 —— 把 `@codemirror/*`、`lucide-react`、`pdfjs-dist`、`echarts`、`xlsx`、`react-markdown` 这类只在 `src/web` 里出现的包写进 `dependencies`,会原样进桌面安装包。2026-09-25 按此口径把 35 个包从 `dependencies` 挪到 `devDependencies`,运行时树 **357MB → 110MB**。判据:该包在 `src/{server,cli,shared}` 中(排除 `*.test.ts`)是否有 import;新增依赖时按此自查。注意 `sharp` 仍会经由 `@zn-ai/zn-agent-core` 进树,不能真的没有。
- **小步可逆**:实现细节见 `docs/DEVELOPMENT_REFERENCE.md`,设计与取舍见 `docs/superpowers/specs/` 与对应 `plans/`。

## 常用验证命令

| 命令 | 用途 |
|------|------|
| `pnpm -r exec tsc --noEmit` | TypeScript 类型检查(顶层 + 各 workspace) |
| `pnpm run build:core` | 只构建 `@zn-ai/zn-agent-core`(loader / bundle / d.ts) |
| `pnpm run build:web` | 只构建 zai 前端(vite → `dist/web`) |
| `pnpm run build:zai` | 只构建 `@zn-ai/zai`(tsc + vite,假设 core 已构建) |
| `pnpm run build` | core → zai 链式全量(发版 / 冷启动) |
| `pnpm --filter @zn-ai/zai test <path>` | 跑单个受影响测试文件 |
| `pnpm --filter @zn-ai/zai dev -- --port 8102 --api-port 7715` | 独立端口起 dev(见下方两条约束) |
| `/ego-browser` | 真实浏览器验收(需先询问用户) |

> 起 dev 时 `--` 是必需的 —— `--port`/`--api-port` 是 zai CLI 的参数,要靠 pnpm 的 `--` 透传,否则被 pnpm 自身吞掉。**禁止顶层 `pnpm dev`**:会同时跑所有 workspace,zn-agent-core 的 dev 是 `tsc -b --watch`,会拒绝 `--port`(TS5072)导致整链失败;需要 core tsc watch 时单独跑 `pnpm --filter @zn-ai/zn-agent-core exec tsc -b --watch`。

## 发布流程

`pnpm release:patch` / `release:minor` / `release:major`。

**已知坑点**:`pnpm publish` 在 workspace 上下文中 auth 传递有问题,第二个包(`@zn-ai/zai`)会报 `ENEEDAUTH`,即使 `npm whoami` 正常 —— 脚本已内置 fallback 自动降级到 `npm publish`;`npm publish` 不识别 `workspace:*` 协议,降级时脚本自动替换为实际版本号再发布,发布后恢复。

## 提交规范

```text
HRMSV3-ZN-WEBSITE#668 <type>(scope): 描述
```

类型词遵循 Conventional Commits(`feat` `fix` `docs` `refactor` `chore`)。完整约定见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。

## 文档入口

| 类别 | 路径 |
|------|------|
| mods 插件系统 | **`docs/mods-vendor-divergences.md` 是入口** —— 先读它,再读 `docs/mods-upstream-contract.md`(上游 2.1.296 契约)/ `mods-upstream-gaps.md`(上游未完成项)。前四份是上游原文、描述的是 **opencc 而非 vendor**;偏差清单记录 zai 侧的有意分叉(TUI 删除、session 门禁、`ctx.fs` 授权门、`ui.render` 按名拒斥)与测试环境的两处必要修正。改动 `packages/zn-agent-core/src/opencc-src/mods/` 前必读。 |
| 实现细节(规则级要求以本文件为准) | [`docs/DEVELOPMENT_REFERENCE.md`](./docs/DEVELOPMENT_REFERENCE.md) |
| API 端点索引 / 前端路由 / Tailwind 边界 / vendor UI stub | 同上 §17 / §18 / §20 / §19 |
| 特性 spec(设计取舍) | `docs/superpowers/specs/` |
| 实施计划(历史与进行中) | `docs/superpowers/plans/` |
| 贡献与提交约定 | [`CONTRIBUTING.md`](./CONTRIBUTING.md) |

> spec / plan 完整列表见对应目录,命名 `YYYY-MM-DD-<topic>.md`(当前 124 篇 spec / 131 篇 plan)。**新特性开工前先在 `docs/superpowers/specs/` 搜既有 spec**,避免重复设计;命名对应的近期文档直接用文件名检索。

<!-- updated: 2026-10-13 (cherry-pick sync-1013:文档入口表补 mods 插件系统一行) -->
<!-- updated: 2026-10-12 (185 → 107 行:API 端点索引/前端路由/vendor UI stub/Tailwind 边界下沉到 DEVELOPMENT_REFERENCE §17-20;微信与 PTY 两段压缩为规则 + 指针;28 行 bash 块改表格;修正 §15 过时的集成点(主实例已不跑微信通道);版本号 0.12.0 → 0.13.4;补提交规范章节) -->
