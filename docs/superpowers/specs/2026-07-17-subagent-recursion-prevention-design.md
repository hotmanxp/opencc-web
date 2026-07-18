# Sub-agent recursion prevention via disallowedTools

**Status:** Draft
**Date:** 2026-07-17
**Scope:** `packages/zai-agent-core/src/runtime/{types.ts,queryEngine.ts}`, `packages/zai-agent-core/src/tools/AgentTool/AgentTool.ts`, `packages/zai-agent-core/src/runtime/background/DefaultBackgroundRuntime.ts`

## Problem

sess-038408c9-... dispatched Explore sub-agent `beb66605-467`, which then fan-out spawned **6 more Explore sub-sub-agents** in the same turn via the `Agent` tool. Each sub-agent inherited the parent's full tool list (default `toolsOverride: 'base+subagent'`) including `Agent`, so a sub-agent can recursively dispatch further sub-agents, with no depth limit.

Reproduced via grep on the parent session transcript + `~/.zai/background/events/beb66605-467.log`: lines 54-71 record 6 concurrent `tool_use` blocks with `name:"Agent"`, each carrying `subagent_type:"Explore"` and a distinct prompt — the agent tool was reachable from a sub-agent.

This wastes tokens, can fan out unboundedly, and silently swallows user intent when sub-sub-agent notifications bubble up.

## Goal

A sub-agent **cannot** dispatch further sub-agents — neither synchronously via `Agent` nor asynchronously via `BackgroundAgent`. Mirror OpenCC's `disallowedTools` mechanism: a per-`QueryOptions` allowlist-deny list that `resolveToolPool` honors at the end of pool construction.

## Behavior contract

| Caller | Sub-agent tool list after fix |
|--------|-------------------------------|
| `AgentTool.call(...)` (sync) | parent tools minus `['Agent', 'BackgroundAgent']` |
| `BackgroundAgentTool.call(...)` (via `runtime.dispatch` → `DefaultBackgroundRuntime.runOne`) | same — `disallowedTools: ['Agent', 'BackgroundAgent']` injected in `runOne`'s `QueryOptions` |
| Top-level `queryEngine(opts)` | unchanged (no `disallowedTools` set) — the parent session retains full tool list |

The `disallowedTools` filter applies **after** `toolsOverride` / `additionalTools` are merged, so a user-supplied `additionalTools: [AgentTool]` is still filtered out (defense-in-depth).

## Architecture

```
QueryOptions
  + disallowedTools?: string[]   ← new
       │
       ▼
resolveToolPool(options, config, base, skills)
  ┌─────────────────────────────────────┐
  │ 1. preset = toolsOverride ??        │
  │    'base+subagent'                  │
  │ 2. pool = [...base, ...skillTool,  │
  │    ...(options.additionalTools??[])]│
  │ 3. (NEW) pool = pool.filter(        │  ← 最后一步,after merge
  │    !set.has(t.name))                │
  └─────────────────────────────────────┘
```

AgentTool / DefaultBackgroundRuntime supply `disallowedTools: ['Agent', 'BackgroundAgent']` when constructing sub-agent `QueryOptions`.

## Implementation outline

### `runtime/types.ts`

Add to `QueryOptions`:
```ts
/**
 * 工具黑名单。resolveToolPool 在构造完工具池后,移除 name 出现在此列表里的工具。
 * 由 AgentTool / DefaultBackgroundRuntime 在派发 sub-agent 时填充
 * `['Agent', 'BackgroundAgent']`,防止 sub-agent 递归派发 sub-agent
 * (复刻 OpenCC sub-agents 文档中的 disallowedTools 语义)。
 */
disallowedTools?: string[]
```

### `runtime/queryEngine.ts`

Update `resolveToolPool` to apply the filter as the final step:
```ts
function resolveToolPool(
  options: QueryOptions,
  _config: RuntimeConfig,
  base: Tool[],
  skills: LoadedSkill[],
): Tool[] {
  const preset = options.toolsOverride ?? 'base+subagent'
  const skillToolEnabled = skills.length > 0 && (_config.enableSkillTool ?? true)
  const skillTool = skillToolEnabled ? [wrapAsOpenccTool(SkillTool)] : []
  let pool: Tool[]
  if (preset === 'none') {
    pool = [...(options.additionalTools ?? []), ...skillTool]
  } else {
    pool = [...base, ...skillTool, ...(options.additionalTools ?? [])]
  }
  const disallowed = options.disallowedTools
  if (disallowed && disallowed.length > 0) {
    const set = new Set(disallowed)
    pool = pool.filter(t => !set.has(t.name))
  }
  return pool
}
```

### `tools/AgentTool/AgentTool.ts`

In `AgentTool.call`, add `disallowedTools` to the sync-path `subOpts` (the background-path already routes through `DefaultBackgroundRuntime.runOne`, see below):
```ts
const subOpts = {
  ...,
  disallowedTools: ['Agent', 'BackgroundAgent'],
}
```

Background-path note: `runtime.dispatch` → `DefaultBackgroundRuntime.runOne` also fills in `disallowedTools` (see next section), so a sub-agent dispatched via the background path is also protected. No change needed in AgentTool's background branch beyond the metadata already written.

### `runtime/background/DefaultBackgroundRuntime.ts`

In `runOne`, when constructing `QueryOptions`:
```ts
const opts: QueryOptions = {
  prompt: rec.task.input.prompt,
  cwd: rec.task.input.cwd ?? process.cwd(),
  model: rec.task.input.model,
  abortSignal: rec.controller.signal,
  parentSessionId: rec.task.parentSessionId,
  disallowedTools: ['Agent', 'BackgroundAgent'],  // ← new
}
```

### Prompt updates

Document the new behavior on both tools' prompt strings:

- `AgentTool/prompt.ts`: add a one-liner at the bottom — "派生的子 agent 不能再调用 Agent / BackgroundAgent（防递归）"
- `BackgroundAgentTool/prompt.ts`: same one-liner

## Tests

### New file: `test/runtime/resolveToolPool-disallowed.test.ts`

Pure unit tests on `resolveToolPool` (already reachable via `queryEngine`, but the function is module-private — test through a thin public seam: export `resolveToolPool` from queryEngine.ts with `@internal`, or test by calling `queryEngine` with mocked runtime).

Cases:
1. `disallowedTools: ['Foo']` removes the tool whose `name === 'Foo'`, leaves others alone.
2. `disallowedTools: undefined` is a no-op.
3. `disallowedTools: []` (empty array) is a no-op.
4. Filter is applied **after** `additionalTools` merge — a tool passed via `additionalTools: [named 'Foo']` is still filtered out if listed.
5. Filter applies to both `toolsOverride: 'base+subagent'` and `'none'` paths.

### New file: `test/tools/AgentTool/no-recursion.test.ts`

Mock `queryEngine` (or its module seam) to capture the `QueryOptions` passed in. Verify `AgentTool.call({...}, ctx)` constructs a `subOpts` with `disallowedTools: ['Agent', 'BackgroundAgent']`.

Cases:
1. Sync path (BackgroundRuntime not initialized): captured opts has `disallowedTools: ['Agent', 'BackgroundAgent']`.

### Existing test: `test/tools/AgentTool.test.ts`

Add one case: `AgentTool.call` from a top-level session does NOT filter its own tools — the fix must not affect parent-level dispatch. (Optional — already implicit since the filter only applies when constructing subOpts.)

## Out of scope

- `BackgroundAgentTool.call` itself does not need to be modified — it routes through `runtime.dispatch` → `DefaultBackgroundRuntime.runOne` which is where the filter is injected.
- `TaskOutputTool` / `BackgroundAgentResultTool` — these read task state, not dispatch sub-agents.
- Per-sub-agent-type tool customization (OpenCC's `tools:` field per subagent_type) — separate refactor; not required for recursion prevention.
- Depth-limit (OpenCC caps at 5 levels) — YAGNI; hard-disallow recursion at level 1 covers the bug.

## Migration / compatibility

- Top-level sessions: no change in tool list, no behavioral change.
- Sub-agents: lose access to `Agent` and `BackgroundAgent`. Any workflow that depended on a sub-agent dispatching a further sub-agent must be refactored to dispatch from the parent session instead.
- Public API surface change: `QueryOptions.disallowedTools` is new and optional. No existing callers break.

## Files touched

- `packages/zai-agent-core/src/runtime/types.ts` — add `disallowedTools?: string[]` to `QueryOptions`
- `packages/zai-agent-core/src/runtime/queryEngine.ts` — filter step in `resolveToolPool`
- `packages/zai-agent-core/src/tools/AgentTool/AgentTool.ts` — `subOpts.disallowedTools`
- `packages/zai-agent-core/src/tools/AgentTool/prompt.ts` — recursion note
- `packages/zai-agent-core/src/tools/BackgroundAgentTool/prompt.ts` — recursion note
- `packages/zai-agent-core/src/runtime/background/DefaultBackgroundRuntime.ts` — `opts.disallowedTools` in `runOne`
- `packages/zai-agent-core/test/runtime/resolveToolPool-disallowed.test.ts` — new
- `packages/zai-agent-core/test/tools/AgentTool/no-recursion.test.ts` — new