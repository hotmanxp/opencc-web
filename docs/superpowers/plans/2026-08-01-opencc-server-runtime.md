# OpenCC Server Headless Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `opencc-src/server` 建立无 UI/TTY 的 OpenCC runtime，并让 zai server 直接复用 vendor 的 QueryEngine、tool lifecycle、session 和 transcript。

**Architecture:** 新 runtime 负责 OpenCC 的完整 headless bootstrap，并以显式上下文创建 Config、AppState、tools、permissions、hooks/plugins、MCP、sandbox、session store 与 QueryEngine。zai 保留 HTTP/task/SSE 外壳，只注入 modelCaller 和 server-owned providers，不再手工构造 `QueryParams` 或 transcript 历史。

**Tech Stack:** TypeScript, Bun, pnpm workspaces, OpenCC vendor source, Anthropic streaming model caller, Express, SSE, Vitest/Bun tests.

## Global Constraints

- server runtime 不得依赖 Ink、TTY 或 UI 组件。
- `modelCaller` 只负责模型 API 请求；工具、hooks、compaction、abort 和事件由 vendor QueryEngine/toolExecution 负责。
- 直接采用 vendor session ID、目录和 transcript 格式。
- 不在正常 server 路径使用 `buildOpenccQueryParams` 的 synthetic AppState、synthetic permission 或 transcript 转换。
- 保留 zai 的 task scheduler、SSE、heartbeat 和 Last-Event-ID 重放。
- 所有新行为必须先写失败测试，再实现最小代码。
- 真实浏览器验收必须使用 `/ego-browser` skill，不以 curl、Playwright 或单元测试替代。
- 不回滚工作区中已有的其他 agent 改动。

---

### Task 1: 建立 server runtime 类型与测试 seam

**Files:**
- Create: `packages/zn-agent-core/src/opencc-src/server/serverTypes.ts`
- Create: `packages/zn-agent-core/src/opencc-src/server/index.ts`
- Create: `packages/zn-agent-core/test/unit/server/openccRuntime-contract.test.ts`
- Modify: `packages/zn-agent-core/package.json` exports

**Interfaces:**
- Produces `OpenccRuntimeOptions`, `OpenccQueryInput`, `OpenccServerEvent`, `OpenccRuntime`。
- `createOpenccRuntime(options): Promise<OpenccRuntime>` 先以明确的未实现错误作为测试 seam，不能让 zai 继续依赖旧 bridge。

- [ ] **Step 1: Write failing contract tests**

测试 `OpenccRuntime` 暴露 `query`, `abort`, `getSession`, `listSessions`, `readTranscript`, `patchSession`, `removeSession`, `shutdown`，并验证 server subpath 可导出这些类型和 factory。

- [ ] **Step 2: Run focused test and verify failure**

Run: `pnpm --filter @zn-ai/zn-agent-core test -- openccRuntime-contract.test.ts`
Expected: FAIL because `opencc-src/server` exports do not exist.

- [ ] **Step 3: Add typed public surface and package export**

在 `serverTypes.ts` 定义完整参数/返回类型；`index.ts` 导出 factory 与类型；在 package exports 增加 `./opencc-server` 或等价 server subpath，避免暴露内部文件路径。

- [ ] **Step 4: Run focused test and verify pass**

Run: `pnpm --filter @zn-ai/zn-agent-core test -- openccRuntime-contract.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/zn-agent-core/src/opencc-src/server packages/zn-agent-core/test/unit/server/openccRuntime-contract.test.ts packages/zn-agent-core/package.json
git commit -m "feat(agent-core): add OpenCC server runtime contract"
```

---

### Task 2: 抽取 vendor headless bootstrap

**Files:**
- Create: `packages/zn-agent-core/src/opencc-src/server/createHeadlessContext.ts`
- Create: `packages/zn-agent-core/test/unit/server/headless-context.test.ts`
- Modify: vendor config/AppState/tool factory files only where explicit exports are required

**Interfaces:**
- Produces `createHeadlessContext(options)`，返回 `{ config, appState, tools, permission, hooks, mcp, sandbox, sessions }`。
- Context 中所有状态按 `cwd`、`dataDir`、session 显式传递，不读取 CLI 当前 session singleton。

- [ ] **Step 1: Trace existing CLI initialization and write failure tests**

覆盖：config 可读、cwd 设置、非交互 client type、默认 tools 存在、AppState 不加载 Ink，以及同一进程创建两个不同 cwd context 不互相覆盖。

- [ ] **Step 2: Run tests and capture the first missing exports/state leak**

Run: `pnpm --filter @zn-ai/zn-agent-core test -- headless-context.test.ts`
Expected: FAIL at the first missing headless factory or UI-bound initialization。

- [ ] **Step 3: Implement explicit headless bootstrap**

复用已有 vendor `enableConfigs`、AppStateStore、default tool registry、permission setup、plugin/hook、MCP 和 sandbox factory；只为缺失的显式依赖增加小型导出，不复制工具实现或权限规则。

- [ ] **Step 4: Verify context isolation and no UI imports**

Run: `pnpm --filter @zn-ai/zn-agent-core test -- headless-context.test.ts`
Expected: PASS；测试中不得启动 Ink 或导入 UI entrypoint。

- [ ] **Step 5: Commit**

```bash
git add packages/zn-agent-core/src/opencc-src/server/createHeadlessContext.ts packages/zn-agent-core/src/opencc-src packages/zn-agent-core/test/unit/server/headless-context.test.ts
git commit -m "feat(agent-core): expose headless OpenCC context"
```

---

### Task 3: 复用 vendor session/transcript lifecycle

**Files:**
- Create: `packages/zn-agent-core/src/opencc-src/server/sessionFacade.ts`
- Create: `packages/zn-agent-core/test/unit/server/session-facade.test.ts`
- Modify: `packages/zn-agent-core/src/opencc-src/utils/sessionPersistence.ts` only for explicit context parameters

**Interfaces:**
- Produces `createSessionFacade(context)` with `create/get/list/read/patch/remove/append/compact` operations。
- Session facade 返回 vendor 原生 session ID、目录和 transcript shape，不转换成 compat transcript shape。

- [ ] **Step 1: Write failing lifecycle tests**

覆盖新建 session、追加 user/assistant/tool 消息、重启后读取、list/patch/remove，以及两个 session 并发写入互不覆盖。

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm --filter @zn-ai/zn-agent-core test -- session-facade.test.ts`
Expected: FAIL because vendor persistence 仍绑定 CLI 全局状态或没有 server facade。

- [ ] **Step 3: Implement thin facade over vendor persistence**

将 cwd/dataDir/sessionId 作为显式参数传入；复用 vendor serialization、compact boundary 和 tool message persistence；不调用 `serializeForAnthropic`，不生成替代 uuid/timestamp。

- [ ] **Step 4: Verify persistence tests**

Run: `pnpm --filter @zn-ai/zn-agent-core test -- session-facade.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/zn-agent-core/src/opencc-src/server/sessionFacade.ts packages/zn-agent-core/src/opencc-src/utils/sessionPersistence.ts packages/zn-agent-core/test/unit/server/session-facade.test.ts
git commit -m "feat(agent-core): reuse OpenCC session persistence in server"
```

---

### Task 4: 创建 QueryEngine server runtime 与 vendor event stream

**Files:**
- Create: `packages/zn-agent-core/src/opencc-src/server/createOpenccRuntime.ts`
- Create: `packages/zn-agent-core/src/opencc-src/server/serverEvents.ts`
- Create: `packages/zn-agent-core/test/unit/server/openccRuntime-query.test.ts`
- Modify: `packages/zn-agent-core/src/opencc-src/QueryEngine.ts` only to expose a UI-independent construction/query seam

**Interfaces:**
- Produces `createOpenccRuntime(options)`；其 `query(input)` 调用 vendor QueryEngine。
- Produces `OpenccServerEvent`，保留 vendor 的 event id、tool use id、session id、turn index 和 abort/error semantics。

- [ ] **Step 1: Write failing query tests**

用 fake `modelCaller` 驱动一轮 assistant delta、tool use、tool result、second assistant delta，断言事件顺序、原始 toolUseId 和最终 query event；另测 abort 会同时取消 model/tool signal。

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm --filter @zn-ai/zn-agent-core test -- openccRuntime-query.test.ts`
Expected: FAIL because no server runtime creates QueryEngine with complete context。

- [ ] **Step 3: Implement runtime factory**

组合 Task 2 context 和 Task 3 session facade，创建 vendor QueryEngine；将 modelCaller 作为唯一模型 I/O 依赖注入；让 QueryEngine 自己执行 tools/hooks/compact/abort，并直接 yield vendor events。

- [ ] **Step 4: Verify tool/event lifecycle**

Run: `pnpm --filter @zn-ai/zn-agent-core test -- openccRuntime-query.test.ts`
Expected: PASS；不得在 server runtime 中实现 tool pairing 或 synthetic tool result。

- [ ] **Step 5: Commit**

```bash
git add packages/zn-agent-core/src/opencc-src/server packages/zn-agent-core/src/opencc-src/QueryEngine.ts packages/zn-agent-core/test/unit/server/openccRuntime-query.test.ts
git commit -m "feat(agent-core): run OpenCC QueryEngine in headless server mode"
```

---

### Task 5: 迁移 zai agent service 到新 runtime

**Files:**
- Modify: `packages/zai/src/server/services/agentRuntime.ts`
- Modify: `packages/zai/src/server/services/subagentNotifier.ts`
- Modify: `packages/zn-agent-core/src/compat/background/DefaultBackgroundRuntime.ts` only where session metadata is passed
- Create/Modify: `packages/zai/test/server/agent-runtime-server.test.ts`

**Interfaces:**
- `initAgentRuntime(cwd)` 创建 `OpenccRuntime`，注入现有 zai `modelCaller`、MCP、sandbox、plugin/hook、permission provider。
- `DefaultBackgroundRuntime` 传递 vendor `sessionId`/`parentSessionId`，不复制 transcript。

- [ ] **Step 1: Write failing integration seam test**

测试 zai service dispatch query 使用 vendor session ID，连续两次 query 读取同一 vendor transcript，并把原始 tool event 透传到 task event stream。

- [ ] **Step 2: Run focused test and verify old path is exercised**

Run: `pnpm --filter @zn-ai/zai test -- agent-runtime-server.test.ts`
Expected: FAIL or证明调用仍进入 `runViaOpenccQuery/buildOpenccQueryParams`。

- [ ] **Step 3: Replace compat construction with `createOpenccRuntime`**

删除 `openccConfig.transcriptStore`、`skillsDirs`、synthetic permission/context 等旧拼装；将 providers 作为 server runtime options 注入；保留 task metadata 与 event persistence。

- [ ] **Step 4: Verify zai integration**

Run: `pnpm --filter @zn-ai/zai test -- agent-runtime-server.test.ts`
Expected: PASS；日志/spy 不应出现 `buildOpenccQueryParams` 或 `runViaOpenccQuery`。

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/server/services/agentRuntime.ts packages/zai/src/server/services/subagentNotifier.ts packages/zn-agent-core/src/compat/background/DefaultBackgroundRuntime.ts packages/zai/test/server/agent-runtime-server.test.ts
git commit -m "refactor(zai): use OpenCC headless runtime"
```

---

### Task 6: 删除旧 adapter 与双重 transcript/permission 路径

**Files:**
- Delete or reduce: `packages/zn-agent-core/src/compat/runtime/buildOpenccQueryParams.ts`
- Delete or reduce: `packages/zn-agent-core/src/compat/runtime/openccQueryBridge.ts`
- Delete or reduce: `packages/zn-agent-core/src/compat/transcript/store.ts` and related compat transcript files
- Modify: package exports/imports and affected tests
- Modify: tests that assert old pairing/fallback behavior

**Interfaces:**
- Produces a repository where normal zai server execution has one OpenCC runtime and one vendor transcript lifecycle。

- [ ] **Step 1: Search remaining production imports**

Run: `Grep pattern="buildOpenccQueryParams|runViaOpenccQuery|compat/transcript" path="packages"`。
Expected: 只剩迁移说明或待删除测试，不得有 server production caller。

- [ ] **Step 2: Update/delete obsolete tests**

保留能覆盖真实 vendor behavior 的测试；删除只验证 synthetic fallback/pair repair 的测试，并把其场景迁移到 server runtime integration tests。

- [ ] **Step 3: Remove obsolete code and exports**

删除旧 adapter 及其仅为 adapter 服务的类型；不删除仍被其他 compat consumers 使用的公共工具，先由 import graph 确认。

- [ ] **Step 4: Run package typecheck and tests**

Run: `pnpm --filter @zn-ai/zn-agent-core exec tsc --noEmit && pnpm --filter @zn-ai/zn-agent-core test && pnpm --filter @zn-ai/zai exec tsc --noEmit && pnpm --filter @zn-ai/zai test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/zn-agent-core packages/zai
git commit -m "refactor(agent-core): remove duplicate OpenCC runtime adapters"
```

---

### Task 7: 真实 server/UI 验收与回归

**Files:**
- Modify only if failures expose implementation defects: relevant server/runtime files
- Test artifacts remain in existing test locations; do not create ad-hoc permanent debug files

**Interfaces:**
- Verifies the public zai workflow against the new runtime and vendor session IDs。

- [ ] **Step 1: Run focused unit/integration suite**

Run: `pnpm --filter @zn-ai/zn-agent-core test && pnpm --filter @zn-ai/zai test`
Expected: PASS。

- [ ] **Step 2: Run type checks/build**

Run: `pnpm -r exec tsc --noEmit && pnpm -r build`
Expected: PASS。

- [ ] **Step 3: Start zai server**

Run: `pnpm --filter @zn-ai/zai dev`
Expected: server starts without Ink/TTY initialization errors and exposes the normal local UI。

- [ ] **Step 4: Use `/ego-browser` for real user-path verification**

验证页面加载、创建对话、连续两轮恢复上下文、触发普通工具、触发 AskUserQuestion、回答后继续、取消运行、SSE 断线重连和刷新后恢复 vendor transcript。

- [ ] **Step 5: Run CLI regression tests**

Run the existing OpenCC CLI test/build commands required by the workspace and verify no UI/CLI regressions from extracted headless exports。

- [ ] **Step 6: Commit only verified fixes**

```bash
git add <only-files-fixed-during-verification>
git commit -m "test: verify OpenCC server runtime migration"
```
