# Sub-agent Recursion Prevention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent sub-agents (sync `Agent` and async `BackgroundAgent`) from recursively dispatching further sub-agents by adding a `disallowedTools` mechanism to `QueryOptions` and forcing it on every sub-agent construction site.

**Architecture:** `resolveToolPool` in `runtime/queryEngine.ts` gets a final filter step that drops any tool whose `name` appears in `options.disallowedTools`. `AgentTool.call` (sync path) injects `['Agent', 'BackgroundAgent']` into its `subOpts`; `DefaultBackgroundRuntime.runOne` (async path) injects the same list when constructing `QueryOptions` for the background sub-agent. Top-level `queryEngine(opts)` is unaffected because no caller supplies `disallowedTools` for the parent session.

**Tech Stack:** TypeScript, vitest, bun test runner.

## Global Constraints

- `QueryOptions.disallowedTools` is optional and additive — no existing caller breaks.
- Filter is applied **last** in `resolveToolPool`, after `toolsOverride` / `additionalTools` merge.
- Top-level session tool list is unchanged (no `disallowedTools` in the parent `QueryOptions`).
- Style: edits stay inside the listed files; no restructuring.
- Tests use vitest (matching `test/tools/AgentTool.test.ts` style).
- Sub-agent type names used in the test mocks must match real tool names: `Agent` (from `AgentTool.ts:15`), `BackgroundAgent` (from `BackgroundAgentTool.ts:10`).

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `packages/zai-agent-core/src/runtime/types.ts` | Modify | Add `disallowedTools?: string[]` to `QueryOptions` |
| `packages/zai-agent-core/src/runtime/queryEngine.ts` | Modify | Filter step at the end of `resolveToolPool` |
| `packages/zai-agent-core/src/tools/AgentTool/AgentTool.ts` | Modify | Inject `disallowedTools: ['Agent', 'BackgroundAgent']` in sync `subOpts` |
| `packages/zai-agent-core/src/tools/AgentTool/prompt.ts` | Modify | Add one-line recursion-prevention note |
| `packages/zai-agent-core/src/tools/BackgroundAgentTool/prompt.ts` | Modify | Add one-line recursion-prevention note |
| `packages/zai-agent-core/src/runtime/background/DefaultBackgroundRuntime.ts` | Modify | Inject `disallowedTools` in `runOne`'s `QueryOptions` |
| `packages/zai-agent-core/test/runtime/resolveToolPool-disallowed.test.ts` | Create | Unit tests for `resolveToolPool` filter |
| `packages/zai-agent-core/test/tools/AgentTool/no-recursion.test.ts` | Create | Verify `AgentTool` constructs subOpts with `disallowedTools` |

---

### Task 1: Failing tests for resolveToolPool filter

**Files:**
- Create: `packages/zai-agent-core/test/runtime/resolveToolPool-disallowed.test.ts`

**Interfaces:**
- Consumes: `resolveToolPool(options, config, base, skills)` (currently module-private — see Step 1 export seam).
- Produces: vitest suite with 5 cases.

- [ ] **Step 1: Export `resolveToolPool` as `@internal`**

In `packages/zai-agent-core/src/runtime/queryEngine.ts`, change the function declaration:

```ts
function resolveToolPool(
```

to:

```ts
/** @internal — exposed for unit tests in test/runtime/resolveToolPool-disallowed.test.ts */
export function resolveToolPool(
```

Place the `/** @internal ... */` JSDoc line directly above the existing signature. The `export` keyword goes between the JSDoc and the function name.

- [ ] **Step 2: Write failing tests**

Create `packages/zai-agent-core/test/runtime/resolveToolPool-disallowed.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { resolveToolPool } from '../../../src/runtime/queryEngine.js'
import type { QueryOptions } from '../../../src/runtime/types.js'

type AnyTool = { name: string; description?: string }
type AnyConfig = { enableSkillTool?: boolean; skillsDirs?: string[] }

const fakeTool = (name: string): AnyTool => ({ name, description: `${name} tool` })

const baseTools: AnyTool[] = [
  fakeTool('Read'),
  fakeTool('Write'),
  fakeTool('Agent'),
  fakeTool('BackgroundAgent'),
  fakeTool('Bash'),
]

const emptyConfig: AnyConfig = {}

const noSkills: never[] = []

describe('resolveToolPool — disallowedTools filter', () => {
  test('removes a single named tool, leaves others alone', () => {
    const opts: QueryOptions = { disallowedTools: ['Agent'] }
    const result = resolveToolPool(opts, emptyConfig, baseTools, noSkills)
    const names = result.map(t => t.name)
    expect(names).toContain('Read')
    expect(names).toContain('Bash')
    expect(names).toContain('BackgroundAgent')
    expect(names).not.toContain('Agent')
  })

  test('removes multiple named tools', () => {
    const opts: QueryOptions = { disallowedTools: ['Agent', 'BackgroundAgent'] }
    const result = resolveToolPool(opts, emptyConfig, baseTools, noSkills)
    const names = result.map(t => t.name)
    expect(names).not.toContain('Agent')
    expect(names).not.toContain('BackgroundAgent')
    expect(names).toContain('Read')
    expect(names).toContain('Write')
    expect(names).toContain('Bash')
  })

  test('undefined disallowedTools is a no-op', () => {
    const opts: QueryOptions = {}
    const result = resolveToolPool(opts, emptyConfig, baseTools, noSkills)
    expect(result.map(t => t.name)).toEqual(['Read', 'Write', 'Agent', 'BackgroundAgent', 'Bash'])
  })

  test('empty disallowedTools array is a no-op', () => {
    const opts: QueryOptions = { disallowedTools: [] }
    const result = resolveToolPool(opts, emptyConfig, baseTools, noSkills)
    expect(result.length).toBe(baseTools.length)
  })

  test('filter applies AFTER additionalTools merge — additional tool also gets filtered', () => {
    const opts: QueryOptions = {
      disallowedTools: ['Agent'],
      additionalTools: [fakeTool('Agent'), fakeTool('CustomTool')],
    }
    const result = resolveToolPool(opts, emptyConfig, baseTools, noSkills)
    const names = result.map(t => t.name)
    // additionalTools' Agent is filtered out; the one in base is also filtered out
    expect(names.filter(n => n === 'Agent').length).toBe(0)
    expect(names).toContain('CustomTool')
  })

  test('filter applies under toolsOverride: "none"', () => {
    const opts: QueryOptions = {
      toolsOverride: 'none',
      disallowedTools: ['CustomTool'],
      additionalTools: [fakeTool('CustomTool'), fakeTool('Another')],
    }
    const result = resolveToolPool(opts, emptyConfig, baseTools, noSkills)
    const names = result.map(t => t.name)
    expect(names).not.toContain('CustomTool')
    expect(names).toContain('Another')
  })
})
```

- [ ] **Step 3: Run tests and verify they fail**

Run: `cd packages/zai-agent-core && bun test test/runtime/resolveToolPool-disallowed.test.ts`

Expected: 6 tests fail (the filter doesn't exist yet). The first test will fail because `Agent` is still in the result list. Compile errors about `disallowedTools` not existing on `QueryOptions` are also expected; if TypeScript blocks the test run, that's still a fail (the test demonstrates a missing feature).

- [ ] **Step 4: Commit failing tests**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/runtime/queryEngine.ts \
        packages/zai-agent-core/test/runtime/resolveToolPool-disallowed.test.ts
git commit -m "test(zai-agent-core): failing cases for resolveToolPool disallowedTools filter"
```

---

### Task 2: Implement disallowedTools on QueryOptions + resolveToolPool

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/types.ts`
- Modify: `packages/zai-agent-core/src/runtime/queryEngine.ts`

**Interfaces:**
- Consumes: existing `QueryOptions`, `resolveToolPool`.
- Produces: new `disallowedTools?: string[]` field; `resolveToolPool` filters as the final step.

- [ ] **Step 1: Add `disallowedTools` to `QueryOptions`**

In `packages/zai-agent-core/src/runtime/types.ts`, find the `toolsOverride` field (line 119) and add directly after it:

```ts
  /**
   * 工具黑名单。resolveToolPool 在构造完工具池后,移除 name 出现在此列表里的工具。
   * 由 AgentTool / DefaultBackgroundRuntime 在派发 sub-agent 时填充
   * `['Agent', 'BackgroundAgent']`,防止 sub-agent 递归派发 sub-agent
   * (复刻 OpenCC sub-agents 文档中的 disallowedTools 语义)。
   */
  disallowedTools?: string[]
```

- [ ] **Step 2: Add filter step to `resolveToolPool`**

In `packages/zai-agent-core/src/runtime/queryEngine.ts`, replace the existing `resolveToolPool` body (lines 380-395) with:

```ts
function resolveToolPool(
  options: QueryOptions,
  _config: RuntimeConfig,
  base: Tool[],
  skills: LoadedSkill[],
): Tool[] {
  const preset = options.toolsOverride ?? 'base+subagent'
  const skillToolEnabled = skills.length > 0 && (_config.enableSkillTool ?? true)
  // SkillTool is a legacy minimal Tool — wrap it in the opencc shape so it
  // satisfies the same Tool[] contract as the rest of the registry.
  const skillTool = skillToolEnabled ? [wrapAsOpenccTool(SkillTool)] : []
  let pool: Tool[]
  if (preset === 'none') {
    pool = [...(options.additionalTools ?? []), ...skillTool]
  } else {
    pool = [...base, ...skillTool, ...(options.additionalTools ?? [])]
  }
  // 最后一步:按 disallowedTools 黑名单剔除工具 (复刻 OpenCC disallowedTools 语义)。
  // AgentTool / DefaultBackgroundRuntime 在派发 sub-agent 时传入
  // ['Agent', 'BackgroundAgent'],阻断递归派发。
  const disallowed = options.disallowedTools
  if (disallowed && disallowed.length > 0) {
    const set = new Set(disallowed)
    pool = pool.filter(t => !set.has(t.name))
  }
  return pool
}
```

Note: the `export` keyword on the function declaration stays — Task 1 added it.

- [ ] **Step 3: Run new tests and verify they pass**

Run: `cd packages/zai-agent-core && bun test test/runtime/resolveToolPool-disallowed.test.ts`

Expected: `6 pass, 0 fail`.

- [ ] **Step 4: Run full zai-agent-core suite to confirm no regressions**

Run: `cd packages/zai-agent-core && bun test 2>&1 | tail -5`

Expected: pre-existing failures remain (GrepTool etc.); no NEW failures. Confirm transcript v2 still `7 pass`:

```bash
cd /Users/ethan/code/opencc-web/packages/zai-agent-core && bun test test/transcript/serialization-v2.test.ts test/transcript/types-v2.test.ts
```

- [ ] **Step 5: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/runtime/types.ts \
        packages/zai-agent-core/src/runtime/queryEngine.ts
git commit -m "feat(zai-agent-core): add QueryOptions.disallowedTools + resolveToolPool filter

Mirrors OpenCC sub-agents docs: a per-query deny list applied as the
final step of tool-pool construction. AgentTool and
DefaultBackgroundRuntime will inject ['Agent', 'BackgroundAgent'] for
every sub-agent in subsequent commits."
```

---

### Task 3: Wire disallowedTools into AgentTool (sync path) + prompts

**Files:**
- Modify: `packages/zai-agent-core/src/tools/AgentTool/AgentTool.ts`
- Modify: `packages/zai-agent-core/src/tools/AgentTool/prompt.ts`
- Modify: `packages/zai-agent-core/src/tools/BackgroundAgentTool/prompt.ts`

**Interfaces:**
- Consumes: `AgentTool.call`'s `subOpts` (line 88-98), `renderPrompt()` in `AgentTool/prompt.ts`, `renderBackgroundAgentPrompt()` in `BackgroundAgentTool/prompt.ts`.
- Produces: `subOpts.disallowedTools: ['Agent', 'BackgroundAgent']`; one-line additions to both prompts.

- [ ] **Step 1: Add `disallowedTools` to `subOpts` in `AgentTool.call`**

In `packages/zai-agent-core/src/tools/AgentTool/AgentTool.ts`, find the `subOpts` object (lines 88-98). Add one line:

```ts
      maxTurns: agent?.maxTurns ?? ctx.__maxTurns ?? 25,
      abortSignal: ctx.abortSignal,
      disallowedTools: ['Agent', 'BackgroundAgent'],
    }
```

Insert `disallowedTools: ['Agent', 'BackgroundAgent']` as the last property of the object (before the closing brace on line 98), with a trailing comma after the previous line.

- [ ] **Step 2: Add recursion note to `AgentTool/prompt.ts`**

In `packages/zai-agent-core/src/tools/AgentTool/prompt.ts`, append the following line to the array inside `renderPrompt()` (find the array literal and add a new entry at the end, before the `].join('\n')`):

```ts
    '派生的子 agent 不能再调用 Agent / BackgroundAgent(防递归)。需要更多 sub-agent 时由父 session 派发。',
```

- [ ] **Step 3: Add recursion note to `BackgroundAgentTool/prompt.ts`**

In `packages/zai-agent-core/src/tools/BackgroundAgentTool/prompt.ts`, append the following line to the array inside `renderBackgroundAgentPrompt()` (find the array literal and add a new entry at the end, before the `].join('\n')`):

```ts
    '派生的后台子 agent 不能再调用 Agent / BackgroundAgent(防递归)。需要更多 sub-agent 时由父 session 派发。',
```

- [ ] **Step 4: Type-check and run existing AgentTool tests**

Run: `cd packages/zai-agent-core && bunx tsc -b --noEmit 2>&1 | grep -E "(AgentTool|BackgroundAgentTool)" | head -10`

Expected: empty (no new errors).

Run: `cd packages/zai-agent-core && bun test test/tools/AgentTool.test.ts test/runtime/resolveToolPool-disallowed.test.ts 2>&1 | tail -5`

Expected: all pre-existing AgentTool tests pass; resolveToolPool-disallowed tests still pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/tools/AgentTool/AgentTool.ts \
        packages/zai-agent-core/src/tools/AgentTool/prompt.ts \
        packages/zai-agent-core/src/tools/BackgroundAgentTool/prompt.ts
git commit -m "fix(zai-agent-core): inject disallowedTools on sync Agent dispatch + update prompts

AgentTool.call now passes ['Agent', 'BackgroundAgent'] in subOpts so
sync-dispatched sub-agents cannot recursively spawn further sub-agents.
Both Agent and BackgroundAgent prompts document the new constraint."
```

---

### Task 4: Inject disallowedTools into DefaultBackgroundRuntime.runOne (async path)

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/background/DefaultBackgroundRuntime.ts`

**Interfaces:**
- Consumes: existing `QueryOptions` construction in `runOne` (lines 256-272).
- Produces: `disallowedTools: ['Agent', 'BackgroundAgent']` field added to that `QueryOptions`.

- [ ] **Step 1: Add `disallowedTools` field**

In `packages/zai-agent-core/src/runtime/background/DefaultBackgroundRuntime.ts`, find the `QueryOptions` construction in `runOne` (lines 256-272). Add one line after `parentSessionId: rec.task.parentSessionId,` (line 271):

```ts
      parentSessionId: rec.task.parentSessionId,
      // 防递归:后台 sub-agent 不能继续派 sub-agent
      disallowedTools: ['Agent', 'BackgroundAgent'],
    }
```

- [ ] **Step 2: Verify TypeScript and full suite**

Run:
```bash
cd /Users/ethan/code/opencc-web/packages/zai-agent-core
bunx tsc -b --noEmit 2>&1 | grep -E "(DefaultBackgroundRuntime|disallowedTools)" | head -10
bun test 2>&1 | tail -3
```

Expected: empty tsc output; pre-existing failure count unchanged.

- [ ] **Step 3: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/runtime/background/DefaultBackgroundRuntime.ts
git commit -m "fix(zai-agent-core): inject disallowedTools on async BackgroundAgent dispatch

DefaultBackgroundRuntime.runOne now passes
['Agent', 'BackgroundAgent'] in QueryOptions when starting a background
sub-agent, mirroring the sync AgentTool path. Closes the recursion
vector for fire-and-forget sub-agent chains."
```

---

### Task 5: Push the four commits

**Files:** none (git only)

- [ ] **Step 1: Push**

```bash
cd /Users/ethan/code/opencc-web
git push origin main
```

Expected: `git push` succeeds; remote HEAD advances to the Task 4 commit.

---

## Self-Review

**Spec coverage:**

- ✅ Behavior contract table (3 rows) → Task 1+2 (filter), Task 3 (sync path), Task 4 (async path)
- ✅ `QueryOptions.disallowedTools` field → Task 2 step 1
- ✅ `resolveToolPool` filter as final step → Task 2 step 2
- ✅ `AgentTool.call` sync path injection → Task 3 step 1
- ✅ `BackgroundAgentTool.prompt.ts` recursion note → Task 3 step 3
- ✅ `AgentTool/prompt.ts` recursion note → Task 3 step 2
- ✅ `DefaultBackgroundRuntime.runOne` async injection → Task 4 step 1
- ✅ Tests for `resolveToolPool` → Task 1 (5 cases + 1 extra for `toolsOverride: 'none'`)
- ✅ "Out of scope" items (per-subagent-type tools, depth-limit, etc.) — not touched

**Placeholder scan:** No `TBD`/`TODO`/`similar to`/`fill in details`. All code blocks are complete. All commands include expected output.

**Type consistency:**
- `disallowedTools?: string[]` — used identically in `types.ts`, `AgentTool.ts`, `DefaultBackgroundRuntime.ts`, and the test.
- Tool name strings: `'Agent'` (matches `AgentTool.ts:15`), `'BackgroundAgent'` (matches `BackgroundAgentTool.ts:10`).
- `resolveToolPool` signature preserved; only the body changed (and `export` was added in Task 1 step 1 to make it testable).