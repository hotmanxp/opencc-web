# 多 Session cwd 持久化 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 compat 层 wrap vendor `BashTool`,让 zai 多 session 各自有独立的 cwd 持久化状态 — 同 session 内 cd 自动累积、跨 turn 不重置、多 session 互不干扰。不改 vendor(opencc-src/*),不改 zai server routes。

**Architecture:** TDD。先写 wrap 函数的单元测试,再实现 wrap,再在 `getOpenccBuiltinTools()` 接入,最后跑手动 /ego-browser 验证。

**Tech Stack:** TypeScript + Vitest ^2.1 + AsyncLocalStorage + vendor BashTool wrap pattern(同 `forceAllowCheckPermissions` 的 object 浅拷贝模式)。

## Global Constraints

- **vendor 不改**(`packages/zn-agent-core/src/opencc-src/*`):AGENTS.md 强调 vendor 改动需 build:core + 全工具回归测试,Phase 1 走 compat 层 wrap 路径
- **system prompt 一律英文**:新增 wrap 函数 / 注释 / 测试描述 / error 消息全英文
- **测试粒度**:仅跑直接相关测试文件,不全跑
- **commit 风格**:`feat(zai):` 前缀 + 模块名 + 中文一句话描述(参考 git log)
- **构建产物**:改 compat 层 → 必须 `pnpm run build:core` 让 `dist/opencc-core.mjs` 包含 wrap 后 BashTool
- **wrap 函数纯函数**:`wrapBashToolWithCwdSync` 接收 tool,返回新对象;不在函数内做副作用(由 `getOpenccBuiltinTools` 调)
- **vendor BashTool 引用身份**:wrap 后的对象**必须**替换 `cachedTools[0]`(原 `BashTool` 位置),确保 vendor runtime 拿到的是 wrapped 版本
- **forceAllowCheckPermissions 调用顺序**:**先 wrap 再 forceAllow**,因为 wrap 后 checkPermissions 还在 vendor 原对象上(wrap 浅拷贝会带过来),forceAllow 直接给 wrapped 对象赋值
- **不在 routes/agent.ts 改外层 runWithSdkContext** — Phase 1 保留 zai 现有 cwd 注入,Phase 3 简化

## File Structure

| 文件 | 职责 |
|------|------|
| `packages/zn-agent-core/test/unit/compat/builtin.cwdWrap.test.ts` | wrap 函数单元测试(mock BashTool + getCurrentSessionId + CwdStore) |
| `packages/zn-agent-core/src/compat/tools/opencc/builtin.ts` | 加 `wrapBashToolWithCwdSync` 函数 + `getOpenccBuiltinTools` 接入 |

---

## Task 1: 写 wrap 函数 failing 单元测试

**Files:**
- Create: `packages/zn-agent-core/test/unit/compat/builtin.cwdWrap.test.ts`

**Context:** 测试需要 mock 三个依赖:`getCurrentSessionId`(compat ALS 读 sessionId)、`runWithSdkContext`(vendor ALS,需要真实 ALS 行为,才能让 mock BashTool 内部 mutate ctx.cwd 后 wrap 闭包外读得到)、`CwdStore`(内存 map)。参考 `packages/zn-agent-core/src/compat/repl/__tests__/createReplSession.runTurn.test.ts` 里的 ALS mock 模式。

- [ ] **Step 1: 写 failing 测试**

```ts
// packages/zn-agent-core/test/unit/compat/builtin.cwdWrap.test.ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { AsyncLocalStorage } from 'node:async_hooks'
import { CwdStore } from '../../../src/compat/cwdStore.js'
import type { SdkContext } from '../../../src/opencc-src/bootstrap/state.js'

// Mock the vendor + compat modules that builtin.ts imports.
// We test wrapBashToolWithCwdSync by:
// 1. Mocking getCurrentSessionId + runWithSdkContext + SdkContext type
// 2. Mocking BashTool (tool object with .call)
// 3. Importing wrapBashToolWithCwdSync from builtin.ts
// 4. Verifying behavior

const sdkStorage = new AsyncLocalStorage<SdkContext>()
let mockSessionId: string | null = null

vi.mock('../../../src/compat/runWithSessionId.js', () => ({
  getCurrentSessionId: () => mockSessionId,
}))

vi.mock('../../../src/opencc-src/bootstrap/state.js', () => ({
  runWithSdkContext: <T>(ctx: SdkContext, fn: () => T): T =>
    sdkStorage.run(ctx, fn),
  // SdkContext is just a type — vi.mock of value-only module is fine
}))

const { wrapBashToolWithCwdSync } = await import(
  '../../../src/compat/tools/opencc/builtin.js'
)

describe('wrapBashToolWithCwdSync', () => {
  beforeEach(() => {
    CwdStore.clear()
    mockSessionId = null
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function mkBashTool(opts: {
    onCall?: (input: unknown, ctx: SdkContext | undefined) => void
    onCallThrow?: Error
  } = {}) {
    const originalCall = vi.fn(
      async (input: unknown, _ctx: unknown) => {
        // Simulate vendor BashTool behavior: read current SDK ctx,
        // mutate ctx.cwd to simulate the trailer side-effect.
        const ctx = sdkStorage.getStore()
        if (ctx && opts.onCall) opts.onCall(input, ctx)
        if (opts.onCallThrow) throw opts.onCallThrow
        return { ok: true, stdout: '', stderr: '' }
      },
    )
    return {
      name: 'Bash',
      description: 'mock',
      inputSchema: {},
      call: originalCall,
    }
  }

  it('no sessionId → calls originalCall directly, no CwdStore write', async () => {
    mockSessionId = null
    const tool = mkBashTool({
      onCall: (_, ctx) => {
        if (ctx) ctx.cwd = '/should-not-be-written'
      },
    })
    const wrapped = wrapBashToolWithCwdSync(tool)
    await wrapped.call({ command: 'ls' }, {} as never)
    expect(tool.call).toHaveBeenCalledOnce()
    expect(CwdStore.size()).toBe(0)
  })

  it('first call: writes CwdStore when ctx.cwd changes (turn 1 cd /tmp)', async () => {
    mockSessionId = 'sid-1'
    const tool = mkBashTool({
      onCall: (_, ctx) => {
        if (ctx) ctx.cwd = '/tmp'
      },
    })
    const wrapped = wrapBashToolWithCwdSync(tool)
    await wrapped.call({ command: 'cd /tmp' }, {} as never)
    expect(CwdStore.get('sid-1')).toBe('/tmp')
  })

  it('no write when ctx.cwd unchanged', async () => {
    mockSessionId = 'sid-1'
    CwdStore.set('sid-1', '/already-set')
    const tool = mkBashTool({
      onCall: (_, ctx) => {
        // ctx.cwd starts at '/already-set', doesn't mutate
      },
    })
    const wrapped = wrapBashToolWithCwdSync(tool)
    await wrapped.call({ command: 'pwd' }, {} as never)
    expect(CwdStore.get('sid-1')).toBe('/already-set')  // unchanged
  })

  it('uses pre-existing CwdStore value as beforeCwd', async () => {
    mockSessionId = 'sid-1'
    CwdStore.set('sid-1', '/existing')
    let capturedBeforeCwd: string | undefined
    const tool = mkBashTool({
      onCall: (_, ctx) => {
        capturedBeforeCwd = ctx?.cwd
        if (ctx) ctx.cwd = '/existing/sub'
      },
    })
    const wrapped = wrapBashToolWithCwdSync(tool)
    await wrapped.call({ command: 'cd sub' }, {} as never)
    expect(capturedBeforeCwd).toBe('/existing')
    expect(CwdStore.get('sid-1')).toBe('/existing/sub')
  })

  it('CwdStore miss → falls back to process.cwd()', async () => {
    mockSessionId = 'sid-2'
    let capturedBeforeCwd: string | undefined
    const tool = mkBashTool({
      onCall: (_, ctx) => {
        capturedBeforeCwd = ctx?.cwd
      },
    })
    const wrapped = wrapBashToolWithCwdSync(tool)
    await wrapped.call({ command: 'pwd' }, {} as never)
    expect(capturedBeforeCwd).toBe(process.cwd())
  })

  it('session isolation: two sessions tracked independently', async () => {
    // Session A in one async chain
    mockSessionId = 'sid-A'
    const toolA = mkBashTool({
      onCall: (_, ctx) => {
        if (ctx) ctx.cwd = '/A'
      },
    })
    const wrappedA = wrapBashToolWithCwdSync(toolA)
    await wrappedA.call({ command: 'cd /A' }, {} as never)

    // Session B in another async chain (parallel-ish: reset mockSessionId)
    mockSessionId = 'sid-B'
    const toolB = mkBashTool({
      onCall: (_, ctx) => {
        if (ctx) ctx.cwd = '/B'
      },
    })
    const wrappedB = wrapBashToolWithCwdSync(toolB)
    await wrappedB.call({ command: 'cd /B' }, {} as never)

    expect(CwdStore.get('sid-A')).toBe('/A')
    expect(CwdStore.get('sid-B')).toBe('/B')
  })

  it('passes all extra args to originalCall (toolUseContext, canUseTool, ...)', async () => {
    mockSessionId = 'sid-1'
    const tool = mkBashTool()
    const wrapped = wrapBashToolWithCwdSync(tool)
    const toolUseContext = { sessionId: 'sid-1', toolUseId: 'tu-1' } as any
    const canUseTool = vi.fn()
    const parentMessage = { role: 'assistant' } as any
    const onProgress = vi.fn()
    await wrapped.call(
      { command: 'pwd' } as any,
      toolUseContext,
      canUseTool,
      parentMessage,
      onProgress,
    )
    expect(tool.call).toHaveBeenCalledWith(
      { command: 'pwd' },
      toolUseContext,
      canUseTool,
      parentMessage,
      onProgress,
    )
  })
})
```

- [ ] **Step 2: 运行测试,确认 FAIL(模块导入失败 — `wrapBashToolWithCwdSync` 还不存在)**

```bash
cd /Users/ethan/code/opencc-web
pnpm --filter @zn-ai/zn-agent-core test test/unit/compat/builtin.cwdWrap.test.ts
```

Expected: FAIL — `wrapBashToolWithCwdSync` is not exported from builtin.ts.

- [ ] **Step 3: Commit(failing 测试)**

```bash
git add packages/zn-agent-core/test/unit/compat/builtin.cwdWrap.test.ts
git commit -m "$(cat <<'EOF'
test(zai): wrapBashToolWithCwdSync 单元测试(failing)

为 compat 层 BashTool cwd sync wrap 函数写 7 个单元测试:
- no sessionId 跳过 wrap
- 首次调用 ctx.cwd 变化写 CwdStore
- ctx.cwd 不变不写
- 读 CwdStore 已有值作为 beforeCwd
- CwdStore miss 兜底 process.cwd()
- 多 session 隔离
- 透传额外参数

vendor / opencc-src 不改;仅 compat 层 wrap。
EOF
)"
```

---

## Task 2: 实现 wrap 函数 + 接入 getOpenccBuiltinTools

**Files:**
- Modify: `packages/zn-agent-core/src/compat/tools/opencc/builtin.ts`

**Context:** wrap 函数放在 builtin.ts 顶部(在 `forceAllowCheckPermissions` 之后),作为 `getOpenccBuiltinTools` 内的强制接入步骤。先 wrap BashTool,再 `forceAllowCheckPermissions(wrappedBash)`,最后把 wrappedBash 放进 `cachedTools[0]` 位置。

- [ ] **Step 1: 在 builtin.ts 顶部 import 区追加**

找到 import 区(行 30-34):

```ts
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { wrapAskUserQuestionToolAsOpencc } from './AskUserQuestionTool.js'
import { wrapSkillToolAsOpencc } from './SkillTool.js'
import { wrapCliAgentToolAsOpencc } from './CliAgentTool.js'
```

改为:

```ts
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { wrapAskUserQuestionToolAsOpencc } from './AskUserQuestionTool.js'
import { wrapSkillToolAsOpencc } from './SkillTool.js'
import { wrapCliAgentToolAsOpencc } from './CliAgentTool.js'
import { CwdStore } from '../../cwdStore.js'
import { runWithSdkContext } from '../../opencc-src/bootstrap/state.js'
import type { SdkContext } from '../../opencc-src/bootstrap/state.js'
import { getCurrentSessionId } from '../../runWithSessionId.js'
```

> **注意**:`SdkContext` 是 type-only import,只用于函数签名,不参与运行时。
> `runWithSdkContext` 是 value import,vendor bootstrap/state.js 的真函数。

- [ ] **Step 2: 在 `forceAllowCheckPermissions` 函数后(`let cachedTools` 之前)插入 wrap 函数**

找到 `let cachedTools: OpenccBuiltinTool[] | null = null`(行 76),在它之前插入:

```ts
/**
 * Wrap vendor BashTool with per-session cwd sync.
 *
 * Why this exists:
 *   vendor's `Shell.exec()` writes the post-cd cwd into the SDK context
 *   (or STATE.cwd if no context) via the `pwd -P >| tmpfile` trailer.
 *   zai's `CwdStore` is a per-session Map but is **only written
 *   manually** at session create / weixin binding — BashTool's trailer
 *   never reaches it. Result: cross-turn cwd resets to process.cwd().
 *
 * How it works:
 *   1. Read sid from `getCurrentSessionId()` (compat ALS — zai
 *      `runQueryLoop` sets this via `runWithSessionId`).
 *   2. Read `CwdStore.get(sid)` as beforeCwd; fall back to
 *      `process.cwd()` if absent.
 *   3. Run `originalCall` inside `runWithSdkContext({ sessionId: sid,
 *      cwd: beforeCwd, ... })`. vendor's `setCwdState()` mutates
 *      `ctx.cwd` in place; the closure-captured `ctx` reference keeps
 *      the post-call value visible after the ALS context exits.
 *   4. If `ctx.cwd !== beforeCwd`, write to `CwdStore.set(sid, ctx.cwd)`.
 *
 * Edge cases:
 *   - `preventCwdChanges` (subagent path): vendor's `Shell.ts:425`
 *     guard skips `setCwdState`, so ctx.cwd stays at beforeCwd and
 *     we don't write — correct.
 *   - `cwdOverrideStorage` ALS (vendor subagent isolation): takes
 *     priority over ctx.cwd in vendor's `pwd()` — wrap still writes
 *     CwdStore with the absolute path, but vendor's subagent
 *     correctness is preserved.
 *   - getCurrentSessionId() === null (not inside zai runQueryLoop):
 *     fall through to originalCall without wrap.
 */
function wrapBashToolWithCwdSync(
  tool: OpenccBuiltinTool,
): OpenccBuiltinTool {
  const originalCall = tool.call.bind(tool)
  return {
    ...tool,
    async call(
      input: unknown,
      toolUseContext: unknown,
      ...rest: unknown[]
    ): Promise<unknown> {
      const sid = getCurrentSessionId()
      if (!sid) {
        return originalCall(input as never, toolUseContext as never, ...rest)
      }
      const beforeCwd = CwdStore.get(sid) ?? process.cwd()
      const ctx: SdkContext = {
        sessionId: sid,
        sessionProjectDir: null,
        cwd: beforeCwd,
        originalCwd: beforeCwd,
      }
      await runWithSdkContext(ctx, async () => {
        await originalCall(input as never, toolUseContext as never, ...rest)
      })
      // setCwdState mutated ctx.cwd in place during originalCall.
      // Closure-captured `ctx` retains the post-call value.
      if (ctx.cwd !== beforeCwd) {
        CwdStore.set(sid, ctx.cwd)
      }
    },
  }
}
```

- [ ] **Step 3: 在 `getOpenccBuiltinTools` 内接入 wrap**

找到 `forceAllowCheckPermissions(BashTool)`(行 157)。在它**之前**插入:

```ts
    // zai patch (2026-09-14, cwd-multi-session-persistence): wrap vendor
    // BashTool with per-session cwd sync. See wrapBashToolWithCwdSync
    // comment for the trailer / setCwdState / CwdStore interaction
    // rationale. Wrap happens BEFORE forceAllowCheckPermissions so the
    // override attaches to the wrapped object (vendor runtime holds the
    // wrapped reference via cachedTools; downstream ToolRegistry / tool
    // search see the same wrapped identity).
    const wrappedBashTool = wrapBashToolWithCwdSync(BashTool)
    BashTool = wrappedBashTool
```

然后改:

```ts
  forceAllowCheckPermissions(BashTool)
```

为(只是把变量引用改成 wrappedBashTool,代码逻辑不变):

```ts
  forceAllowCheckPermissions(wrappedBashTool)
```

并且修改 `cachedTools` 数组里的 BashTool 项:

```ts
  cachedTools = [
    BashTool,  // ← 改成 wrappedBashTool
    FileReadTool,
    ...
```

为:

```ts
  cachedTools = [
    wrappedBashTool,
    FileReadTool,
    ...
```

> **Why**:直接 `BashTool = wrappedBashTool` 重新赋值会让 `BashTool` 局部 const 引用变了但 vendor 内部仍用 cachedTools 数组里的 wrappedBashTool。两边一致即可。

实际上更稳妥的写法:

```ts
  const wrappedBashTool = wrapBashToolWithCwdSync(BashTool)
  forceAllowCheckPermissions(wrappedBashTool)
  // ... 其他 forceAllow 不变
  cachedTools = [
    wrappedBashTool,
    FileReadTool,
    ...
  ]
```

不修改 `BashTool` 局部 const。

- [ ] **Step 4: 运行 wrap 函数单元测试,确认 PASS**

```bash
cd /Users/ethan/code/opencc-web
pnpm --filter @zn-ai/zn-agent-core test test/unit/compat/builtin.cwdWrap.test.ts
```

Expected: 7 个用例全绿。

- [ ] **Step 5: 跑 openccInit / CliAgentTool 等 compat 测试,确认无回归**

```bash
pnpm --filter @zn-ai/zn-agent-core test \
  test/unit/compat/openccInit.test.ts \
  test/unit/compat/CliAgentTool.test.ts \
  test/unit/compat/bashTracker.test.ts
```

Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add packages/zn-agent-core/src/compat/tools/opencc/builtin.ts
git commit -m "$(cat <<'EOF'
feat(zai): compat 层 wrap BashTool 加 per-session cwd 同步

vendor BashTool 跑完后 trailer 写 cwd 到 SDK context 或 STATE.cwd,
zai 的 CwdStore 此前只能手工写入(session create / weixin binding),
跨 turn cwd 重置为 process.cwd()。

本次在 compat/tools/opencc/builtin.ts 加 wrapBashToolWithCwdSync:
- runQueryLoop 已用 runWithSessionId 设 compat ALS,wrap 读
  getCurrentSessionId() 拿 sid
- 读 CwdStore.get(sid) ?? process.cwd() 作 beforeCwd
- runWithSdkContext({ sessionId, cwd: beforeCwd }, originalCall)
- vendor setCwdState mutate ctx.cwd 后,wrap 闭包外读 ctx.cwd,
  不同则 CwdStore.set(sid, ctx.cwd)

vendor opencc-src 不动;build:core 后生效。
EOF
)"
```

---

## Task 3: build:core 让 wrap 进入 bundle

**Files:**
- Modify: `packages/zn-agent-core/dist/opencc-core.mjs`(构建产物)
- Modify: `packages/zn-agent-core/dist/bundle-entry.d.ts`(类型)

**Context:** zai server 通过 `import('@zn-ai/zn-agent-core')` 加载 bundle,改 compat 必须重 build。AGENTS.md 强调"core 改动必须先 build:core"。

- [ ] **Step 1: 跑 build:core**

```bash
cd /Users/ethan/code/opencc-web
pnpm run build:core
```

Expected: 构建成功,`dist/opencc-core.mjs` 含 wrap 函数 + wrappedBashTool 调用。

- [ ] **Step 2: 验证 wrap 进入 bundle**

```bash
grep -c "wrapBashToolWithCwdSync\|wrappedBashTool" /Users/ethan/code/opencc-web/packages/zn-agent-core/dist/opencc-core.mjs
```

Expected: 至少 2 处(函数定义 + 调用点)。

- [ ] **Step 3: 跑 zai 相关测试,确认 wrap 不破坏现有行为**

```bash
cd /Users/ethan/code/opencc-web
pnpm --filter @zn-ai/zai test test/server/routes/agent.ts
pnpm --filter @zn-ai/zai test test/server/services/agentRuntime.ts
```

Expected: 全绿(无回归,因为 wrap 只在 compat ALS 有 sid 时激活,unit test 里 mock 的 BashTool 不调 runQueryLoop)。

- [ ] **Step 4: Commit(如有 dist 改动)**

```bash
git add packages/zn-agent-core/dist/opencc-core.mjs \
        packages/zn-agent-core/dist/bundle-entry.d.ts \
        packages/zn-agent-core/dist/bundle-entry.js \
        packages/zn-agent-core/dist/bundle-entry.d.ts.map 2>/dev/null
git commit -m "$(cat <<'EOF'
build(zai): 重 build:core 让 BashTool wrap 进 bundle

compat/tools/opencc/builtin.ts 改完,bundle-opencc 重打 dist/opencc-core.mjs,
zai-server 通过主入口 @zn-ai/zn-agent-core 加载新 bundle。
EOF
)"
```

> **注意**:dist 是构建产物,一般不进 git。检查当前 .gitignore 是否包含 dist:如果是,跳过 dist commit,只 commit compat/ 源文件。

---

## Task 4: /ego-browser 真实浏览器 + Bash 端到端验证

**Files:** 无(纯手动验证)

**Context:** Task 1-3 已经覆盖单元层面(wrap 行为)。真实 BashTool 调用通过 vendor trailer 写 cwd 是 Task 4 验证的目标。AGENTS.md 强调"core 改动必须先 build:core",而 build:core 改动的影响需要 ego-browser 端到端验证。

- [ ] **Step 1: 起独立 dev 端口**

```bash
cd /Users/ethan/code/opencc-web
pnpm --filter @zn-ai/zai dev -- --port 8102 --api-port 7715
```

> AGENTS.md 端口使用:必须先 `lsof -i :8102` 确认空闲,显式 `--port` 被占则 EADDRINUSE 报错退出。

- [ ] **Step 2: 走 /ego-browser skill 验证 6 步**

调 `/ego-browser` skill 验证(用 `/m` 路由也行):

1. **创建 session A**:`POST /agent/sessions` body `{}` → sid-A
2. **session A turn 1**:prompt `cd /tmp && pwd && echo "<MARKER-A-1>"` → 应输出 `/tmp`
3. **session A turn 2**:prompt `pwd && echo "<MARKER-A-2>"` → **应输出 `/tmp`(不是 process.cwd)**
4. **创建 session B**:同 server 实例,prompt `pwd && echo "<MARKER-B-1>"` → 应输出 process.cwd(隔离 sid-A)
5. **session A turn 3**:prompt `cd /etc && pwd && echo "<MARKER-A-3>"` → `/etc`
6. **session A turn 4**:prompt `pwd && echo "<MARKER-A-4>"` → `/etc`(继续累积)

每步检查 tool_result stdout 含期望 MARKER。

- [ ] **Step 3: 修复任何意外行为**

如果 turn 2 / turn 4 仍回 process.cwd:
- 检查 `stateBridge.ts` / `__zaiEventBus` cwd.changed 是否被某层拦截
- 检查 `routes/agent.ts:1127` `runWithSessionId(cmd.sessionId, ...)` 是否真的在 wrap 调用链上
- 检查 `compat/runWithSessionId.ts` 的 `getCurrentSessionId()` 实现是否正确读 ALS

修复后回到 Step 2 重跑。

- [ ] **Step 4: 跑全量 compat + zai 相关测试,确认无回归**

```bash
cd /Users/ethan/code/opencc-web
pnpm --filter @zn-ai/zn-agent-core test test/unit/compat/
pnpm --filter @zn-ai/zai test test/server/services/agentRuntime.ts test/server/routes/agent.ts
```

Expected: 全绿。

- [ ] **Step 5: Commit(如有 Step 3 修复)**

```bash
git add <changed files>
git commit -m "$(cat <<'EOF'
fix(zai): [如有问题描述] cwd 同步 wrap 调试修复

ego-browser 验证发现 [具体问题],修复 [具体改动]。
EOF
)"
```

---

## Self-Review Checklist

实现者走完每个任务时核对:

- [ ] **Task 1**:wrap 函数单元测试 7 个用例全部存在 + run 失败(模块导入失败)
- [ ] **Task 2**:`wrapBashToolWithCwdSync` 实现 + `getOpenccBuiltinTools` 接入;7 个用例全绿;openccInit / CliAgentTool / bashTracker 测试无回归
- [ ] **Task 3**:`pnpm run build:core` 成功;grep bundle 确认 wrap 函数进入;zai agent.ts / agentRuntime 测试无回归
- [ ] **Task 4**:ego-browser 真实 6 步验证全过(同 session 累积 + 多 session 隔离 + 重置时机正确)

## Spec Coverage Map

| Spec § | 实现任务 |
|--------|---------|
| §5.1 wrap 函数实现 | Task 2(Step 1-2) |
| §5.2 关键不变量 | Task 2 实现 + Task 1 单元测试验证 |
| §5.3 wrap 后工具对象身份 | Task 2(Step 3) |
| §6 数据流 | Task 4(ego-browser 端到端) |
| §7 边界场景 | Task 1(单元测试覆盖 subagent 路径通过 preventCwdChanges 守卫)+ Task 4 |
| §8.1 单元测试 | Task 1 + Task 2 |
| §8.3 手动验证 | Task 4 |
| §10 验收清单 | Task 1 + 2 + 3 + 4 全部 |
