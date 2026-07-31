# Restore opencc vendor `query()` as the Default Runtime Backend

**Date:** 2026-07-31
**Status:** Approved (brainstorming complete)
**Scope:** `packages/zn-agent-core/src/compat/runtime/{contract,openccAdapter,buildOpenccQueryParams}.ts` + 1 new spec + updates to 2 existing specs.

---

## Motivation

zai 当前通过 `DefaultAgentRuntime.run()` 走 compat 端 `runOpenccQuery`(`packages/zn-agent-core/src/compat/runtime/openccAdapter.ts`),该路径在 line 89 设置了 `const MAX_TOOL_ITERATIONS = 50`,在 line 341 用 `for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++)` 硬截断主循环,在 line 751-758 yield 一条 `runtime.error` 终止 SSE 流。

这条硬截断是 compat 端**自加**的安全网(`MAX_TOOL_ITERATIONS` 在 opencc vendor 端零匹配),目的是兜底"模型挂死 / 卡在权限弹窗 / 反复重试同一条命令"等场景。

**但** opencc vendor 在 `opencc-src/query.ts` 已经具备 5 层防护:

| 防护 | 位置 | 阈值 |
|---|---|---|
| `toolFailureLoopGuard` | `opencc-src/query/toolFailureLoopGuard.ts:6` | 同模式失败 5 次熔断 |
| `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT` | `opencc-src/query.ts:188` | 输出 token 截断自愈 3 次 |
| `MAX_CONTINUATION_NUDGES` | `opencc-src/query.ts:189,2175-2230` | 模型"想说但没说清"最多 nudge 20 次 |
| `maxTurns` (用户传) | `opencc-src/query.ts:2184,2417` | `--max-turns N` CLI 参数,默认 Infinity |
| `agentStepLimit.summaryRequested` | `opencc-src/query.ts:2183` | `AgentStop` 钩子早停 |

zai 端 2026-07-29 把默认切到 compat `runOpenccQuery`(`contract.ts:77` 的 `// TEMP 2026-07-31` 注释,commit `ccf27fb2`),原因是 vendor `utils/permissions/permissions.ts:934-953` 在 `shouldAvoidPermissionPrompts: true` 时**强 deny**(无 `PermissionRequest` hook 答复时),导致 LLM 读到 `CANCEL_MESSAGE` 当成"用户拒绝",headless 模式全死。

切到 compat 后:

1. 50 轮硬上限**误杀正常长任务**(用户在 issue 里报:"tool_use 正常会有很多")
2. vendor 的 `MAX_CONTINUATION_NUDGES` / `maxTurns` 等防护**用不上**
3. compat 端工具实现需要单独维护(`openccToolWrap.ts` 等),与 vendor 漂移

本次设计目标是**对齐 opencc 上游行为**:恢复 `runViaOpenccQuery` 为默认后端,通过 `mode: 'bypassPermissions'` 短路 vendor 的 headless deny 分支,让 zai 既享受 vendor 完整防护,又不被 50 轮硬截断误伤。

---

## Goal

将 `DefaultAgentRuntime.run()` 的默认 backend 从 compat 端的 `runOpenccQuery` 切回 vendor 端的 `runViaOpenccQuery`(via `openccQueryBridge.ts`),并补全 vendor 路径运行所需的最少配置改动。

**成功标准:**

1. `DefaultAgentRuntime.run()` 默认调 `runViaOpenccQuery`
2. vendor 主循环 50+ 轮不触发硬截断(由 vendor 5 层防护接管)
3. vendor 加载失败时显式 yield `runtime.error`,不静默 fallback
4. compat `runOpenccQuery` 仍可作为 explicit export 给单元测试和 direct callers
5. 行为兼容:zai server 路由、SSE 协议、前端 store 完全不感知内部 backend 切换

---

## Non-Goals

- 不删除 `runOpenccQuery` / `openccAdapter.ts` / `MAX_TOOL_ITERATIONS`(它们继续作为单元测试 + fallback 用)
- 不修改 compat shim(permissions / cwdStore / commands / transcript / background / plugins / skills / memory)
- 不修改 zai server 路由、translator、SSE 协议
- 不修改前端 store、UI、components
- 不实现 compat → vendor 的 silent fallback(vendor 加载失败就显式报错)
- 不修复 opencc vendor 自身的 `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT` / `MAX_CONTINUATION_NUDGES` 等阈值
- 不引入 `opts.maxTurns` 参数透传(后续 plan 单独做)

---

## Design

### Architecture (改动后)

```
zai web → POST /agent/prompt
  → routes/agent.ts (HARD_TIMEOUT 2h, fire-and-forget)
  → DefaultAgentRuntime.run(opts)              [packages/zn-agent-core/src/compat/runtime/contract.ts:85]
  → runViaOpenccQuery(opts, openccConfig)     [packages/zn-agent-core/src/compat/runtime/openccQueryBridge.ts:139]
      ├─ buildOpenccQueryParams()             [packages/zn-agent-core/src/compat/runtime/buildOpenccQueryParams.ts]
      │    toolPermissionContext: { mode: 'bypassPermissions',     ← 新增
      │                              shouldAvoidPermissionPrompts: true,
      │                              isBypassPermissionsModeAvailable: true,
      │                              ... }
      ├─ importOpenccSrc()                     ← 失败 yield runtime.error,不 fallback
      ├─ opencc.query(params)                  ← [packages/zn-agent-core/src/opencc-src/query.ts]
      │    主循环 while (true)                  ← 5 层防护(下表)
      ├─ translateSdkToRuntime() → RuntimeEvent 流向 SSE
```

**Vendor 5 层防护表**(在 `opencc-src/query.ts` 主循环内):

| Layer | Location | Trigger |
|---|---|---|
| `toolFailureLoopGuard` | `opencc-src/query/toolFailureLoopGuard.ts:6`,threshold **5** | 同 `(toolName, errorCategory)` 失败 5 次,或同一文件路径 Edit/Write 失败 5 次 → `tool_failure_loop_guard_tripped` reason,正常返回 |
| `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT` | `opencc-src/query.ts:188` = **3** | 输出 token 截断只能自愈 3 次 |
| `MAX_CONTINUATION_NUDGES` | `opencc-src/query.ts:189` = **20**,Nudge 文本 `Continue with the task. If you were interrupted, resume your thought. Otherwise, use the appropriate tools to proceed to the next step.` (line 2203-2205) | 模型说"let me..." 但没产 `tool_use`,最多 nudge 20 次 |
| `maxTurns` (用户传) | `opencc-src/query.ts:2184, 2417`,默认 `Infinity` | `--max-turns N` CLI 参数,非交互模式生效 |
| `agentStepLimit.summaryRequested` | `opencc-src/query.ts:2183` | `AgentStop` 钩子早停信号 |

### Component Changes

#### 1. `packages/zn-agent-core/src/compat/runtime/contract.ts`

**改动 `DefaultAgentRuntime.run()` line 85 默认调用:**

```diff
@@ DefaultAgentRuntime.run @@
-    // TEMP 2026-07-31: switched default from runViaOpenccQuery → runOpenccQuery
-    // to bypass vendor's headless permission auto-deny.
-    // vendor's permissions.ts:934-953 force-deny in headless mode when no
-    // PermissionRequest hook returns a decision, returning CANCEL_MESSAGE
-    // as the tool_result, which the LLM reads as "user declined". The
-    // runOpenccQuery adapter uses zai's own bashCall (no vendor permission
-    // system) and modelCaller (zai's Anthropic SDK wrapper), bypassing
-    // the entire opencc vendor copy on the runtime path.
-    return runOpenccQuery(opts, openccConfig)
+    // Default backend is `runViaOpenccQuery` (Phase 5 bridge). Uses
+    // opencc's vendor `query()` in `opencc-src/query.ts`, which has the
+    // full 5-layer agent loop protection (toolFailureLoopGuard /
+    // MAX_CONTINUATION_NUDGES / MAX_OUTPUT_TOKENS_RECOVERY_LIMIT /
+    // maxTurns / agentStepLimit). The compat-side MAX_TOOL_ITERATIONS=50
+    // hard cap is removed — vendor's guard layers are sufficient.
+    //
+    // Permission model: vendor runs in `mode: 'bypassPermissions'` so the
+    // headless deny branch (vendor permissions.ts:934) is short-circuited
+    // (vendor line 1270-1283). `shouldAvoidPermissionPrompts: true` is
+    // preserved so future hooks that check the flag still work (BashTool's
+    // bashPermissions.ts:1488/1526 short-circuits on bypass mode regardless
+    // of the flag).
+    //
+    // Vendor load failure surfaces as `runtime.error` (no silent fallback
+    // to compat). Direct callers wanting the compat path can import
+    // `runOpenccQuery` from `./openccAdapter.js` explicitly.
+    return runViaOpenccQuery(opts, openccConfig)
```

#### 2. `packages/zn-agent-core/src/compat/runtime/buildOpenccQueryParams.ts`

**`mode: undefined` → `mode: 'bypassPermissions'`** (line 291 附近,新增 1 行)

```diff
@@ toolPermissionContext @@
     isBypassPermissionsModeAvailable: true,
     shouldAvoidPermissionPrompts: true,
+    mode: 'bypassPermissions',
```

**Vendor 行为证据**(已 grep 验证):

- `opencc-src/utils/permissions/permissions.ts:1270-1283`: `shouldBypassPermissions = mode === 'bypassPermissions' || (mode === 'plan' && isBypassPermissionsModeAvailable)`,命中后**无条件 `return {behavior:'allow'}`**,不进入 1285+ 的 classifier 路径
- `opencc-src/tools/BashTool/bashPermissions.ts:1488, 1526`: BashTool 的 `checkPermissions` 在 `mode === 'bypassPermissions'` 时直接返回 `undefined` / `false`(放行)
- `opencc-src/tools/AgentTool/runAgent.ts:1477`: AgentTool 同理
- FileEditTool / FileReadTool / FileWriteTool / GlobTool / GrepTool **没有自己的 `checkPermissions`**,直接走 vendor 默认 passthrough,然后被 1265-1283 的 bypass 短路

**结论:`mode: 'bypassPermissions' + shouldAvoidPermissionPrompts: true` 组合下,vendor 不再强 deny,headless flag 只在 825 行 `transcriptTooLong` 边界 case 起作用(throw AbortError,正常任务不会触发)。**

#### 3. `packages/zn-agent-core/src/compat/runtime/openccAdapter.ts`

**删除 `MAX_TOOL_ITERATIONS = 50` 硬截断,改 `for` → `while (true)`:**

```diff
@@ openccAdapter.ts (top) @@
-    /**
-     * Hard cap on tool_use ↔ tool_result iterations to prevent infinite loops.
-     *
-     * Each iteration = one model turn that may emit ≥1 tool_use. The model
-     * decides when to stop emitting tools (final answer comes back without
-     * tool_use blocks); this cap only kicks in when something is wrong
-     * (runaway retry, model stuck on a permissions prompt, etc.).
-     *
-     * 50 is the empirically-sane ceiling for real debugging tasks:
-     *   - 5-10 turns: simple lookups, file reads
-     *   - 10-20 turns: multi-step debugging (e.g. "test ego-browser" — install
-     *     check, PATH fix, retry, snapshot capture)
-     *   - 20-30 turns: complex refactors that touch many files
-     * Beyond 30 the LLM is almost certainly looping on the same tool. We
-     * pick 50 as a soft cap so a runaway task gets a clean error instead of
-     * silently spinning forever, while leaving enough headroom for real
-     * work.
-     */
-    const MAX_TOOL_ITERATIONS = 50
```

```diff
@@ openccAdapter.ts (main loop) @@
-    const failureLoopGuardState = createToolFailureLoopGuardState()
-    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
+    const failureLoopGuardState = createToolFailureLoopGuardState()
+    // runOpenccQuery is now an explicit export for direct callers and unit
+    // tests only. Production traffic goes through runViaOpenccQuery → vendor
+    // query(). This loop has no hard cap: toolFailureLoopGuard (5) handles
+    // runaway patterns, abortSignal handles caller cancellation. Tests must
+    // use their own timeout to avoid hanging the suite.
+    while (true) {
```

```diff
@@ openccAdapter.ts (post-loop error) @@
-    yield toRuntimeErrorEvent(
-      new Error(
-        `agent loop exceeded ${MAX_TOOL_ITERATIONS} iterations — model kept emitting tool_use blocks ` +
-          `without reaching a final answer. This usually means the model is stuck on a permission prompt, ` +
-          `retrying a failing command, or genuinely needing more turns. Try re-prompting with a narrower scope.`,
-      ),
-      { sessionId, turnIndex: MAX_TOOL_ITERATIONS },
-    )
   } catch (err) {
```

(`while (true)` 后无 `yield toRuntimeErrorEvent` 兜底,直接落到 `} catch (err) {` 块。AbortSignal / toolFailureLoopGuard 是退出路径。)

#### 4. 文档更新

- **新增 spec**:本文档 `2026-07-31-zn-agent-core-restore-vendor-default.md`
- **更新 `docs/superpowers/specs/2026-07-29-zn-agent-core-opencc-adapter-node-design.md`**:把"MAX_TOOL_ITERATIONS = 50"相关段落标注为 deprecated,引用新 spec
- **更新 AGENTS.md / CLAUDE.md** (如有需要):在"关键文件"表的 `compat/runtime/openccAdapter.ts` 行备注"compat fallback,非生产路径"

---

## Data Flow

**生产路径**(改动后):

```
1. Web → POST /api/agent/prompt
2. routes/agent.ts → DefaultAgentRuntime.run() [HARD_TIMEOUT 2h, fire-and-forget]
3. compat/runtime/contract.ts:85 → runViaOpenccQuery(opts, openccConfig)
4. compat/runtime/openccQueryBridge.ts:
   a. buildOpenccQueryParams() → params with {mode:'bypassPermissions', shouldAvoidPermissionPrompts:true}
   b. importOpenccSrc() lazy import opencc-src/query.{js,ts,tsx}
      - 失败: yield toRuntimeErrorEvent, return (不 fallback)
   c. openccQuery(params) → AsyncIterable<SDKMessage>
   d. for-await over stream:
      - translateSdkToRuntime(SDKMessage) → yield RuntimeEvent
      - 工具回调(AskUserQuestion)通过 __zaiEventBus 旁路 yield tool_use:ask_pending
      - Watchdog (ZAI_OPENCC_WATCHDOG_MS, 默认 300_000):message_stop 后 5min 无事件 → 强制 yield runtime.done
5. compat/runtime/sdkEventAdapter.ts: SDKMessage → RuntimeEvent
6. routes/agent.ts:translateRuntimeEvents → SSE ServerEvent
7. web/store/useAgentStore.ts:applyRuntimeEvent → UI
```

**Vendor 加载失败路径**:

```
4b. importOpenccSrc() throws
    → runViaOpenccQuery yield:
       toRuntimeErrorEvent(
         new Error(`[openccQueryBridge] failed to import opencc-src/query: ...`),
         { sessionId, turnIndex: 0 }
       )
    → return
5'. SSE push runtime.error 事件
6'. 前端 QuestionCard / toast 提示用户
```

---

## Error Handling

| 失败点 | 行为 |
|---|---|
| vendor `importOpenccSrc()` 抛错 | yield `runtime.error` event,`event.message` 含 `[openccQueryBridge] failed to import opencc-src/query: ${err.message} Ensure bun-protocol.mjs is loaded via \`tsx --import\` and any hand-stubs are in place.` |
| vendor 加载成功但 `opencc.query()` 抛错 | bridge `catch` 块 yield `toRuntimeErrorEvent(err, {sessionId, turnIndex: 0})` |
| `toolFailureLoopGuard` tripped | vendor 端走 `tool_failure_loop_guard_tripped` reason 正常返回 → bridge 不感知,正常翻译 SDKMessage → SSE 流 |
| `MAX_CONTINUATION_NUDGES` 用尽 | vendor 端继续主循环直到自然 end_turn |
| AbortSignal abort | bridge line 292 `if (opts.abortSignal?.aborted)` → yield `runtime.aborted`,return |
| Watchdog trip(5min 静默) | bridge 直接 emit `runtime.done` + 所有 in-flight tool 的 `runtime.tool_result` (isError:true) 到 `__zaiEventBus`,前端回到 idle |

---

## Testing

### 单元测试

| 测试 | 位置 | 验证点 |
|---|---|---|
| `contract.run()` 默认调 `runViaOpenccQuery` | `packages/zn-agent-core/test/runtime/contract.test.ts` | spy 两个 export,断言 `runViaOpenccQuery` 被调,`runOpenccQuery` 未被调 |
| `runViaOpenccQuery` 在 vendor 加载失败时 yield `runtime.error` | `packages/zn-agent-core/test/runtime/openccQueryBridge-load-failure.test.ts` | mock `importOpenccSrc()` 抛错,断言事件流 |
| `buildOpenccQueryParams` 输出 `mode: 'bypassPermissions'` | `packages/zn-agent-core/test/runtime/buildOpenccQueryParams.test.ts` | 解析返回 params,断言 `toolPermissionContext.mode === 'bypassPermissions'` |
| `runOpenccQuery` 主循环无 50 上限 | `packages/zn-agent-core/test/runtime/openccAdapter-no-cap.test.ts` | mock modelCaller 永远返回 tool_use 块,断言:① 运行到 abortSignal 触发才退出 ② 不 yield `agent loop exceeded` error |
| vendor `bypassPermissions` 短路 headless deny | `packages/zn-agent-core/test/runtime/vendor-bypass-mode.test.ts`(Bun only) | 调 vendor `hasPermissionsToUseToolInner` with `mode:'bypassPermissions' + shouldAvoidPermissionPrompts:true`,断言 `behavior === 'allow'` |

### 集成测试

| 测试 | 位置 | 验证点 |
|---|---|---|
| 长跑不触发硬截断 | `packages/zn-agent-core/test/integration/long-task.test.ts` | 50+ 轮 mock LLM 一直产 tool_use,断言 bridge 不中断,watchdog 或 abort 兜底 |

### Manual Smoke Test

zai dev server 起一个长任务(规划 + 改 10 个文件),观察:
1. agent 跑过 50 轮不报错
2. SSE `runtime.tool_call` 流连续,无 `runtime.error` 截断
3. `~/.zai/logs/` 下 transcript 持久化正常
4. abort 按钮仍然可用

---

## Risks

| 风险 | 缓解 |
|---|---|
| vendor 加载失败 → 所有 agent 不可用 | vendor 加载在 zai-agent-core 历史中已知稳定(commit `39969440` 后 27 个 pre-existing test 失败中无相关);新增测试覆盖 import error 路径;运营可在 `~/.zai/logs/` 看到详细 import error |
| `bypassPermissions` 模式让用户失去审批机会 | zai 是本地 dev 工具(localhost only,无外网鉴权,`AGENTS.md` package description 已声明),`--dangerously-skip-permissions` 同语义,符合产品定位;future plan 可加 `mode: 'default'` 用户配置 |
| compat `runOpenccQuery` 删 50 上限 → 失去硬截断兜底 | compat 路径无生产流量,只服务 direct callers + 单元测试;后者由 vitest `timeout` / `abortSignal` 兜底;`toolFailureLoopGuard`(5 次熔断)仍然在 |
| 上游 cherry-pick 时 vendor 改了这 5 层防护的语义 | 依赖的是 opencc 0.20.0 稳定语义;后续 cherry-pick 时需 review `query.ts:583 (while(true))`, `query.ts:188-189 (MAX_*)`, `query.ts:2175-2230 (continuationNudge)`, `query/toolFailureLoopGuard.ts:6 (DEFAULT_TOOL_FAILURE_LOOP_THRESHOLD)`, `permissions.ts:1270-1283 (bypassPermissions)` 这几处 |
| vendor `MAX_CONTINUATION_NUDGES = 20` 过低导致长任务被 nudge 中断 | 20 次对应"模型说想继续但没说清"模式,这是 vendor 设计的边界;如果用户觉得不够,后续 plan 可以加 `ZAI_CONTINUATION_NUDGES` env override(mirroring `ZAI_TOOL_FAILURE_LOOP_THRESHOLD`) |

---

## Rollback Plan

如果 vendor 路径在新场景下出意外,回滚只需 3 行 diff:

```diff
@@ packages/zn-agent-core/src/compat/runtime/contract.ts:85 @@
-    return runViaOpenccQuery(opts, openccConfig)
+    return runOpenccQuery(opts, openccConfig)
```

(可选:撤回 `buildOpenccQueryParams.ts` 的 `mode: 'bypassPermissions'` 新增行)

`openccAdapter.ts` 的 `for` → `while (true)` 改动在回滚后会让 compat 路径回到"无 50 上限 + 无 watch"状态。回滚时需要同步把 50 加回来(把 `MAX_TOOL_ITERATIONS = 50` 常量、`for` 循环、line 751-758 的 yield error 三处一起 revert),否则 compat fallback 会失去硬截断兜底,测试套件可能挂死。

---

## Open Questions (for implementation plan)

1. **AGENTS.md / CLAUDE.md 是否需要在 `关键文件` 表里更新 `openccAdapter.ts` 描述?** → Implementation plan task 决定
2. **新 spec 是否要在 `AGENTS.md` 文档索引加一行?** → 加
3. **是否需要把 `mode: 'bypassPermissions'` 抽出成 `OpenccAdapterConfig` 的可选字段?** → 本 spec 范围外,后续 plan 单独做
4. **`toolFailureLoopGuard` 在 compat 端(env `ZAI_TOOL_FAILURE_LOOP_THRESHOLD`)是否要同步注释"vendor 路径下读 opencc 自己的 env"`?** → Implementation plan task