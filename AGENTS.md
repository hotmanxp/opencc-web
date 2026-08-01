# AGENTS.md - opencc-web

## 项目概述

**opencc-web** 是 zai 的本地开发与运行工具集,在 `packages/zai`(Express + SSE server + React/Zustand/AntD 前端)与 `packages/zn-agent-core`(Agent 运行时核心库)两个 workspace 中实现 Agent 对话、流式 UI、命令/Skill/插件等能力。zai 仅监听 localhost,不依赖外部鉴权。

## 目录

| 目录 | 职责 |
|------|------|
| `packages/zai/` | `src/server/` 路由 + service,`src/web/` UI + store,`src/shared/` zod schema |
| `packages/zn-agent-core/` | `compat/`(verbatim 移植的 zai 兼容垫片)+ `opencc-src/`(opencc 0.20.0 拷贝,Bun-direct);`scripts/bundle-opencc.mjs` 单文件编子路径 |
| `docs/` | 设计/参考/操作指南;`docs/superpowers/specs/` 是各特性 spec,`docs/superpowers/plans/` 是实施计划 |
| `examples/` `scripts/` | 示例 / 仓库脚本 |

## 强制开发规则

- **真实浏览器验收**:任何问题修复或特性新增,完成前必须用 `/ego-browser` skill 启动真实 zai 实例并走完用户路径(页面加载、按钮点击、表单提交、截图等)。**禁止**用 Chrome DevTools MCP、Playwright、Puppeteer、`curl + WebFetch` 或单元测试替代。环境阻塞时必须显式报告。
- **Bun-direct runtime**:`zai dev` 默认走 Bun;Node 兜底入口需 `--import bun-protocol.mjs` 拦截 `bun:bundle` / `bun:feature`,漏掉会 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。opencc vendor 是 un-stripped 全量,Node 兜底包加载较慢,只用于 CI / 测试。
- **opencc-src vs compat**:verbatim 移植的 compat 文件,若 opencc 上游是纯类型/常量,优先让 zai 调用方**直接**从 `opencc-src/<name>` 取值,compat 仅留作 zai 专属别名载体。`scripts/bundle-opencc.mjs` 用 esbuild `bundle: false` 单文件编 → `dist/opencc-src/types/<name>.js` 暴露子路径。**禁止**用 tsc 整编 opencc-src(拖入 UI 传递依赖)。详见 plan `docs/superpowers/plans/2026-08-01-compat-direct-opencc-src-permissions.md`。
- **MACRO stub**:`zai-server` 启动时需在 `enableOpenccConfigs` 内调 `installMacroStub()` 预填 `globalThis.MACRO`,否则 vendor 顶层 `MACRO.X` 引用 panic。
- **CodeGraph 优先**:理解代码用 `codegraph_explore` 单调用,不要 grep + read 轮询;索引未初始化时跑 `codegraph init -i`。`codegraph_context` / `codegraph_trace` 当前 v1.4.1 不可用。
- **小步可逆**:实现细节见 `docs/DEVELOPMENT_REFERENCE.md`;设计/取舍见 `docs/superpowers/specs/` 与对应 `plans/`。

## 常用验证命令

```bash
# TypeScript 类型检查(顶层 + 各 workspace)
pnpm -r exec tsc --noEmit

# 单元测试
pnpm -r test                  # 全部
pnpm -r test -t "<pattern>"   # 单文件 / 单用例

# 启动 dev(zai + 前端)
pnpm --filter @zn-ai/zai dev

# 真实浏览器验收(强制项)
/ego-browser                  # 通过 skill 调 ego-browser 驱动 zai Web UI
```

## 文档入口

- 架构与实现细节 → `docs/DEVELOPMENT_REFERENCE.md`
- 架构总览研究 → `docs/superpowers/specs/2026-07-25-opencc-web-architecture-overview.md`
- SSE 状态推送设计 → `docs/superpowers/specs/2026-07-19-sse-state-push-design.md`
- 会话压缩设计 → `docs/superpowers/specs/2026-07-19-zai-session-compaction-design.md`
- MCP 过滤字段 → `docs/superpowers/plans/2026-07-20-zai-mcp-disabled-servers.md`
- OpenCC Adapter(Node/tsx) → `docs/superpowers/specs/2026-07-29-zn-agent-core-opencc-adapter-node-design.md`(Bun 版 spec 已 deprecated)

> 历史 spec / plan 完整列表见 `docs/superpowers/specs/` 与 `docs/superpowers/plans/`,命名 `YYYY-MM-DD-<topic>.md`。
