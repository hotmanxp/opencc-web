# AGENTS.md - opencc-web

## 项目概述

**opencc-web** 是 zai 的本地开发与运行工具集。三个 workspace:

- `packages/zai` — Express + SSE server + React/Zustand/AntD 前端
- `packages/zn-agent-core` — opencc 0.20.0 vendor 拷贝(主入口 `@zn-ai/zn-agent-core`,2026-08-16 起废除全部 subpath)
- `packages/dsh-bridge` — zai → `@deepseek-ai/dsh-*` 桥接,见「双轨改造」

zai 仅监听 localhost,不依赖外部鉴权。

## 技术栈

| 层 | 技术 | 版本 |
|----|------|------|
| 语言 / 运行时 | TypeScript ^5.6 / Node `^22.19 \|\| >=24`(仓库级 engines;`.nvmrc` 写 20 已过期) | — |
| zai 前端 | React 18.3 + Zustand 4.5 + AntD 5.22 + Vite 8 + React Router 6 + Tailwind + CodeMirror(14 langs)+ react-markdown 10 | — |
| zai 服务端 | Express 4 + SSE + Zod + ws + sharp + commander + `@anthropic-ai/sdk` | — |
| dsh-bridge | `@deepseek-ai/cordis` 4.0.1 + 35 个 `@deepseek-ai/dsh-*` + `@modelcontextprotocol/sdk` 1.0 | — |
| zn-agent-core vendor | opencc 0.20.0(Bun 兼容 un-stripped)+ ripgrep vendor 二进制(darwin-arm64/x64、win32-x64) | — |
| 测试 | Vitest(zai/dsh-bridge/根 `^4.1`,zn-agent-core `^2.1`,子包隔离,跨包勿混引) | — |

## 目录

| 目录 | 职责 |
|------|------|
| `packages/zai/` | `src/server/` 路由 + service,`src/web/` UI + store,`src/shared/` zod schema |
| `packages/zn-agent-core/` | `compat/` 兼容垫片 + `opencc-src/` vendor(允许修改)+ `scripts/bundle-opencc.ts` 编 `dist/opencc-core.mjs` 单一 bundle |
| `packages/dsh-bridge/` | zai → deepseek-harness 桥接,见「双轨改造」;状态见 `IMPLEMENTATION_STATUS.md` |
| `docs/` | `superpowers/specs/` 各特性 spec,`superpowers/plans/` 实施计划,`2026-08-17-dsh-*.md` dsh 主线文档 |
| `scripts/` | `release.mjs`(pnpm release:*)+ `generate-rpc-client.ts`(Zod → api.generated.ts codegen)+ `kill-switch-drill.sh`(季度演练)+ `zn-ai`/`zn-ai.bat`(环境检测) |
| `examples/` | `mcp-smoke/` MCP 冒烟测试(stdio server + MCPClientPool) |
| 根 `.zai/` | ⚠️ 用户态数据影子目录(同 `~/.zai/` 布局)— 仅 dev/IDE 感知,生产读写走真实 `~/.zai/`,**禁止写进代码** |

## 双轨改造 (dsh 内核集成 · B 方案)

zai 同时支持两条 agent 内核轨道,由 `agent.kernel` 切换:`opencc`(默认,`@zn-ai/zn-agent-core`,任何 Node 版本)/ `dsh`(`@zn-ai/dsh-bridge` + `@deepseek-ai/dsh-*`,要求 Node ≥22.19)。

**配置**(解析顺序:项目级 > 用户级 > 默认 `'opencc'`,非法值 fail loud):

```json
// ~/.zai/settings.json      (用户级)
// <cwd>/.zai/settings.json   (项目级 — 优先级高)
{ "agent": { "kernel": "dsh" } }   // 或 "opencc"
```

**启动期覆盖**(`--kernel` 不写持久化,仅本次进程,优先级最高):

```bash
zai dev -- --kernel=dsh              # 临时切 dsh(ego-browser 验证工具渲染)
zai dev -- --kernel=opencc           # 临时回退(排查「切 dsh 后出问题」)
zai config set agent.kernel dsh      # 持久化(必须重启,运行期不允许切换)
```

**数据隔离**(两轨不共享文件):

| 数据 | opencc | dsh |
|------|--------|-----|
| 会话 | `${dataDir}/projects/<cwd>/<sessionId>.jsonl` | `${dataDir}/dsh-sessions/<projectKey(cwd)>/<encoded sessionId>/` |
| 任务 | `~/.zai/tasks/<taskId>.json` | `~/.zai/tasks-dsh/<taskId>.json`(独立子目录) |
| 插件/技能/模型凭据 | 共享(`~/.zai/plugins/`、`~/.agents/skills/`、env + zai settings) |  |

**会话迁移**(B6,默认 dry-run):`zai migrate --kernel dsh [--target-dsh-version <ver>]`。**实例级 kernel**(per-instance 三态):见 `docs/superpowers/specs/2026-08-03-zai-agent-instance-manager-design.md`。**详细状态 / 维护契约 / 已知差异 / dsh-bridge 导出 API**:`packages/dsh-bridge/IMPLEMENTATION_STATUS.md`、`docs/2026-08-17-dsh-*.md`、`packages/dsh-bridge/src/index.ts`。

## 本机数据目录 `~/.zai/`

zai 用户级配置、plugin 元数据、任务持久化在 `~/.zai/`(常量 `ZAI_DIR`,`packages/zai/src/server/services/paths.ts:23`)。

| 路径 | 职责 |
|------|------|
| `~/.zai/plugins/` | **plugin 元数据 + 缓存根**(`installed_plugins.json` V2 schema;实际文件 `cache/<marketplace>/<plugin>/<version>/`,`<version>/.in_use/` 标记当前使用版本) |
| `~/.zai/projects/` | 项目级数据(per-cwd 分段) |
| `~/.zai/agents/` `~/.zai/skills/` | 用户级 agent/skill 定义(`ZAI_SKILLS_DIRS=''` 显式禁用) |
| `~/.zai/settings.json` | 用户级设置;项目级走 `<cwd>/.zai/settings.json` |
| `~/.zai/tasks/` | opencc 任务;dsh 用 `~/.zai/tasks-dsh/` |
| `~/.zai/plans/` | plan 文件持久化 |

**关键陷阱**:

- **plugin 改文件走 `~/.zai/plugins/cache/claude-plugins-official/<name>/<version>/`** — 不要去 `~/.claude/plugins/cache/`(迁移后 zai 不读)
- **LSP/MCP 类 plugin**(typescript-lsp / pyright-lsp / context7 / chrome-devtools-mcp / ralph-loop / code-review)zai `/api/plugins` 不返回 — 缺 `.claude-plugin/plugin.json` 或被静默排除
- **`~/.zai/zn-assets/`** 是 paths.ts 注释预期 layout,实际未部署;plugin 资源走 `~/.agents/skills/`(`agentRuntime.ts:285`)

## dsh 相关问题优先查 vendor 源码

**调查 dsh 内核集成问题时,优先去 deepseek-harness 主仓库看 vendor 源码,再回看 dsh-bridge / zai 调用链**。只在本仓库 grep `reasoning`/`thinking` 会漏掉真正的 root cause —— dsh-side 才是语义定义的源头,本仓库只是消费者。

**主仓库**:`/Users/ethan/code/deepseek-harness/packages/`。**已构建 vendor**(`pnpm` 实际跑):`node_modules/.pnpm/@deepseek-ai+dsh-*/lib/`。关键目录:`llm/llm-pi-ai/src/` `stream.ts`/`adapter.ts`/`catalog.ts`/`config.ts`、`llm/llm/src/` `assembler.ts`/`types.ts`/`message.ts`、`session/lib/types/` `types.d.ts`/`chunk-rows.js`、`session/session-persistence-jsonl/lib/` `index.js`。

**dsh-021 教训**:`zai` 配字段 → `dsh-bridge/buildProviderEntries` 静默丢弃 → `dsh-llm-pi-ai` 拿不到默认值,streamSimple 不发 thinking 参数 → API 默认关闭 thinking → UI 无 ThinkingBlock。"上游字段被中游丢弃"只能从 vendor 入口配置(`PiAiProviderProfile.reasoning`)往回追到 zai 配置,反向 grep 找不到。详细字段对照见 `docs/superpowers/specs/` dsh 相关文件。

## 强制开发规则

- **真实浏览器验收**:完成前必用 `/ego-browser` 启真实 zai 实例走完用户路径。**禁止** Chrome DevTools MCP / Playwright / Puppeteer / `curl+WebFetch` / 单元测试替代。环境阻塞必须显式报告。**注意**:不要 kill 920x 端口服务(正式 zai)— 改用空闲端口(8102 起)或 `pnpm --filter @zn-ai/zai dev` 启独立服务;ego-browser 在 zai dev 跑着时 SSE 长连接下可用。早期 `feedback-ego-browser-sse-blocked` memory 已过时
- **mobile 路由**:mobile-only 功能(`MobileQuickDrawer`/`MobileAgent.tsx` 等)走 **`/m`**,**不要在 `/agent` 上靠缩窗口判断**;`MOBILE_BREAKPOINT=768` 只影响 Layout 响应式,与 `/m` 是两条独立路径 — 显式 mobile 路由不依赖视口宽度。ego-browser 验证 mobile drawer 直接访问 `/m`,无需 `setDeviceMetricsOverride`
- **core 改动必须先 build:core**:`packages/zn-agent-core/` 改完、ego-browser 验证前必跑 `pnpm run build:core`(`dist/opencc-core.mjs`/`bundle-entry.d.ts`/`opencc-src/server/*.d.ts` 都是构建产物,改源不生效)。仅改 `packages/zai/src/web/` 纯前端或只改 zai 服务端(无 core 依赖)时不需要
- **Node-direct runtime(默认)**:`zai dev` 走 `tsx --loader .../bun-protocol.mjs` 拦截 `bun:bundle`/`bun:feature`(漏掉 `ERR_UNSUPPORTED_ESM_URL_SCHEME`);`dev:bun`(`bun run src/cli/index.ts dev`)可选快速。opencc vendor un-stripped 全量,Node 冷启动加载较慢属预期
- **opencc-src vs compat**:`opencc-src/` 允许修改(改后需 `build:core`);compat 是 zai 别名载体。**禁止** tsc 整编 opencc-src;`dist/opencc-src/server/*.d.ts` 由 `tsc -p tsconfig.server.json` 机械发射,`scripts/verify-server-types-self-contained.mjs` 守护 self-contained
- **MACRO stub**:`zai-server` 启动时 `enableOpenccConfigs` 内调 `installMacroStub()` 预填 `globalThis.MACRO`,否则 vendor 顶层 `MACRO.X` panic
- **CodeGraph 优先**:`codegraph_explore` 单调用理解代码,不 grep+read 轮询;未初始化跑 `codegraph init -i`。`codegraph_context`/`codegraph_trace` v1.4.1 不可用
- **端口使用(必查)**:`zai dev`/`start` 前 `lsof -i :<port>` 确认空闲。显式 `--port`/`--api-port` 被占用必 EADDRINUSE 退出,**禁止**静默换端口(多实例共享 API key 是请求风暴根因)。仅未显式指定才允许自动扫描(`ports.ts resolveServerPort`)
- **小步可逆**:实现细节见 `docs/DEVELOPMENT_REFERENCE.md`;设计见 `docs/superpowers/specs/` 与 `plans/`
- **测试粒度**:功能改动后只跑**直接受影响**的测试文件。`pnpm -r test` 全量跑 zai 2192 + zn-agent-core 382 + dsh-bridge 135 ≈ 600+ 文件,冷启动太慢。仅跨 workspace 重构、合并前 sanity、CI 才跑全量。**禁止**全量当"完成前必跑":
  ```bash
  pnpm --filter @zn-ai/zai test <path/to/file.test.tsx>
  pnpm -r test -t "<describe-block-name>"
  ```

## UI 页面规范(可访问性 · 强制)

**范围**:`packages/zai/src/web/src/pages/**` 与 `components/**` 的 `.tsx`。所有交互元素必须有可访问名,优先级:`aria-label="..."`(中文硬编码)→ `aria-labelledby` → 可见文本 children。

**豁免**(满足其一即可):可见文本 children / `<Form.Item label>` 包裹 / `<Modal title>` 或 `<Drawer title>` 非空(AntD 自动 aria-labelledby)/ `<Tabs.TabPane tab>` 或 `items=[{label}]` / 纯装饰 `<Icon>` 或 `<span>`(父已含 aria-label)。

**必须 aria-label**:纯图标 `<Button icon>`、原生 `<a>`/`<button>`、裸 `<input/Select/Switch/Input.TextArea/Slider/Checkbox/Radio>`、`<Tooltip>`/`<Popconfirm>` 包裹的触发元素(`title` 不算)、`<Modal>`/`<Drawer>` title 为空时。容器(Tabs/Upload/Form)不审计,只审计其 children。

**文案**:中文为主、动词+名词(如「删除会话」),禁止「点击这里」、「更多」等无意义标签。

**验证**:

```bash
node scripts/verify-web-aria-labels.mjs            # 默认扫 pages + components
node scripts/verify-web-aria-labels.mjs <dir>      # 扫指定目录
pnpm --filter @zn-ai/zai typecheck                  # 自动含此检查(typecheck 末尾追加)
```

新组件提交前必须跑过 audit,违规 fail loud(退出码 1)。详细豁免算法见 `docs/superpowers/specs/2026-08-23-zai-web-aria-label-enforcement-design.md`。

## 常用验证命令

```bash
# TypeScript(`pnpm -r exec tsc --noEmit` 不充分,用子包脚本)
pnpm -r run typecheck                              # 走子包完整链路
pnpm --filter @zn-ai/zai typecheck                 # 仅 zai
pnpm --filter @zn-ai/zn-agent-core typecheck       # 仅 core(含 d.ts 自包含校验)

# 构建(开发期只编改过的)
pnpm run build:core       # @zn-ai/zn-agent-core(loader + opencc-core.mjs + d.ts)
pnpm run build:web        # zai 前端(vite → dist/web)
pnpm run build:zai        # zai(tsc + vite,假设 core 已构建)

# 测试(只跑相关文件)
pnpm --filter @zn-ai/zai test <path/to/file.test.tsx>
pnpm -r test -t "<describe-block-name>"

# dev — `--` 透传 CLI 参数;默认 Vite 8101/Express 7715;显式端口被占 EADDRINUSE,不静默换
# 禁止 `pnpm dev`(整 workspace dev,core dev 是 tsc -b --watch 拒 --port)
pnpm --filter @zn-ai/zai dev -- --port 8102 --api-port 7715 --kernel=dsh

# 真实浏览器验收(强制)
/ego-browser
```

## 发布流程

```bash
pnpm release:patch   # 或 minor / major
```

**已知坑**:`pnpm publish` 在 workspace 上下文 auth 传递有问题(第二个包 `ENEEDAUTH`,即使 `npm whoami` 正常),脚本内置 fallback 降级 `npm publish`;后者不识别 `workspace:*`,会自动替换为实际版本号再发布,发布后恢复。`release:*` 默认不 push,需要时显式 `git push origin main [--tags]`。

## 文档入口

| 类别 | 路径 |
|------|------|
| 架构与实现 | `docs/DEVELOPMENT_REFERENCE.md`(双轨开发指南 §16) |
| spec / plan 列表 | `docs/superpowers/specs/` 与 `docs/superpowers/plans/`,命名 `YYYY-MM-DD-<topic>.md` |
| dsh 主线 | `docs/superpowers/plans/2026-08-17-dsh-kernel-*.md`、`docs/2026-08-17-dsh-{maintenance-contract,known-differences,vendor-retirement,release-notes}.md` |
| 实例管理(per-instance kernel 三态) | `docs/superpowers/specs/2026-08-03-zai-agent-instance-manager-design.md` |
| dsh-bridge 实施状态 | `packages/dsh-bridge/IMPLEMENTATION_STATUS.md` |