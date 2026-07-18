# Unify Agent tool: hard-delete BackgroundAgentTool

**Status:** Draft
**Date:** 2026-07-17
**Scope:** `packages/zai-agent-core/src/tools/BackgroundAgentTool/**`, `packages/zai-agent-core/src/tools/index.ts`, `packages/zai-agent-core/src/tools/AgentTool/{AgentTool.ts,prompt.ts}`, `packages/zai-agent-core/src/runtime/background/DefaultBackgroundRuntime.ts`, `packages/zai-agent-core/test/runtime/resolveToolPool-disallowed.test.ts`, `packages/zai-agent-core/test/tools/AgentTool.test.ts`, `packages/zai/src/server/services/backgroundRuntime.ts`, `packages/zai-agent-core/src/opencc-internals/tools.ts`, and any other reference found via `grep -rn BackgroundAgent packages/`

## Problem

`AgentTool` was upgraded (commit pre-this-spec) to support both foreground (sync, `run_in_background: false`) and background (async, `run_in_background: true` default) dispatch through a single tool — matching OpenCC's `Agent` tool semantics. But the legacy `BackgroundAgentTool` is still registered and exported, so LLM-facing tools list shows both `Agent` and `BackgroundAgent`. This violates OpenCC's unified-tool pattern, doubles the surface area, and forces `disallowedTools: ['Agent', 'BackgroundAgent']` (redundant — only `Agent` needs protection post-merge).

## Goal

After this change, LLM sees exactly one tool: `Agent`. The legacy `BackgroundAgentTool` is gone — file deleted, exports removed, references updated, `disallowedTools` lists simplified to `['Agent']`. `BackgroundAgentResultTool` (the *query* tool, separate concern) stays unchanged.

## Behavior contract

| Surface | Before | After |
|---------|--------|-------|
| LLM-visible tool list (foreground/background unified) | `Agent`, `BackgroundAgent`, `BackgroundAgentResult`, `TaskOutput`, `TaskStop`, `TaskCreate`, ... | `Agent`, `BackgroundAgentResult`, `TaskOutput`, `TaskStop`, `TaskCreate`, ... |
| `Agent` tool: `run_in_background: true` (default) | dispatch to BackgroundRuntime → immediate `<subagent_dispatched>` + notification | **unchanged** |
| `Agent` tool: `run_in_background: false` | sync sub-agent | **unchanged** |
| `BackgroundAgentTool` | dispatches, returns shortId | **deleted** |
| Sub-agent `disallowedTools` | `['Agent', 'BackgroundAgent']` | `['Agent']` |
| `BackgroundAgentResultTool` | queries task state | **unchanged** |

## Architecture

No new code. Pure deletion + reference cleanup:

1. Delete `packages/zai-agent-core/src/tools/BackgroundAgentTool/` directory entirely.
2. Remove `BackgroundAgentTool` (and `BACKGROUND_AGENT_TOOL_NAME` / `BackgroundAgentInputSchema` / `BackgroundAgentInput`) exports from `packages/zai-agent-core/src/tools/index.ts`.
3. In every file that imports from `BackgroundAgentTool/**`, decide:
   - **Replace with `AgentTool`** — if the call site wants the dispatch behavior, use `AgentTool.call({subagent_type, prompt, run_in_background: true})`. See file-by-file mapping in implementation outline below.
   - **Remove the import** — if the call site only used a type or constant that's no longer needed.
4. Simplify `disallowedTools: ['Agent', 'BackgroundAgent']` to `['Agent']` at every site (AgentTool sync path, DefaultBackgroundRuntime.runOne).
5. Update `AgentTool/prompt.ts` recursion-prevention line to drop the `BackgroundAgent` mention.
6. Update test fixtures that referenced `BackgroundAgent` (only `resolveToolPool-disallowed.test.ts` per recent commit; verify with `grep`).

## File-by-file mapping (results from `grep -rn BackgroundAgent packages/`)

| File | Change |
|------|--------|
| `packages/zai-agent-core/src/tools/BackgroundAgentTool/` (whole dir) | Delete |
| `packages/zai-agent-core/src/tools/index.ts` | Remove `BackgroundAgentTool` export and related types |
| `packages/zai-agent-core/src/tools/AgentTool/AgentTool.ts:98` | `['Agent', 'BackgroundAgent']` → `['Agent']` |
| `packages/zai-agent-core/src/tools/AgentTool/prompt.ts` | Drop "BackgroundAgent" mention in recursion-prevention line |
| `packages/zai-agent-core/src/runtime/background/DefaultBackgroundRuntime.ts` | Same `disallowedTools` simplification |
| `packages/zai-agent-core/src/runtime/types.ts` | Check JSDoc on `QueryOptions.disallowedTools` — remove "BackgroundAgent" mention |
| `packages/zai-agent-core/src/runtime/queryEngine.ts` | Check JSDoc comment on filter step |
| `packages/zai-agent-core/src/runtime/background/registry.ts` | Audit: likely only type/constant references — drop |
| `packages/zai-agent-core/src/tools/BackgroundAgentResultTool/{prompt.ts,BackgroundAgentResultTool.ts}` | Audit — `BackgroundAgentResultTool` stays; no change to source (mentions of "BackgroundAgent" in prompt text are about the result-query tool's parent context, not the to-be-deleted dispatch tool) |
| `packages/zai-agent-core/src/tools/BackgroundAgentResultTool/{schema.ts,index.ts}` | No change |
| `packages/zai-agent-core/src/tools/AgentTool/schema.ts` | No change to schema |
| `packages/zai-agent-core/src/tools/TaskStopTool/prompt.ts` | Audit — probably references "BackgroundAgent" as the dispatch tool name in documentation; update |
| `packages/zai-agent-core/src/tools/TaskOutputTool/{schema.ts,TaskOutputTool.ts}` | Audit |
| `packages/zai-agent-core/src/tools/TaskCreateTool/prompt.ts` | Audit |
| `packages/zai-agent-core/test/runtime/resolveToolPool-disallowed.test.ts` | Drop `BackgroundAgent` from baseTools fixture; test cases adjust |
| `packages/zai-agent-core/test/tools/BackgroundAgentResultTool/immediate-return.test.ts` | No change (it's the result-query test, unaffected by dispatch tool merge) |
| `packages/zai-agent-core/test/tools/AgentTool.test.ts` | Audit (might have been named against `BackgroundAgentTool` in mocks — rename) |
| `packages/zai/src/server/services/backgroundRuntime.ts` | Audit — file name mentions `background` but body references `BackgroundAgentTool` for dispatch routing; replace with `AgentTool` |
| `packages/zai-agent-core/src/opencc-internals/tools.ts` | Audit — likely re-exports `BackgroundAgentTool`; remove |

For every file marked "Audit", the implementer MUST grep within that file for `BackgroundAgent` and either remove the reference (if it's the dispatch tool) or confirm it stays (if it's `BackgroundAgentResultTool`).

## Tests

Existing tests that should still pass:

- `test/runtime/resolveToolPool-disallowed.test.ts` — after dropping `BackgroundAgent` from baseTools fixture and updating one assertion (`expect(names).toContain('BackgroundAgent')` → drop or replace with another tool), should still be 6/6 pass
- `test/tools/AgentTool.test.ts` — verify all mocks named after `BackgroundAgentTool` are renamed
- `test/tools/BackgroundAgentResultTool/immediate-return.test.ts` — unchanged

New smoke check (no new test file required):

```bash
cd packages/zai-agent-core && grep -rnE '\bBackgroundAgent\b' src/ test/ | grep -v BackgroundAgentResultTool
```

Expected: zero matches. If any remain, the migration is incomplete.

```bash
cd /Users/ethan/code/opencc-web/packages/zai-agent-core && bun test 2>&1 | tail -5
```

Expected: pre-existing 18 failures remain unchanged; no NEW failures.

```bash
cd /Users/ethan/code/opencc-web/packages/zai-agent-core && bunx tsc -b --noEmit 2>&1 | grep -E "(BackgroundAgent|AgentTool)" | head -10
```

Expected: only references to `BackgroundAgentResultTool` / `BackgroundAgentResult` (kept). Zero references to `BackgroundAgent` as a tool name (would indicate a leftover import).

## Out of scope

- `BackgroundAgentResultTool` (the query tool) — kept verbatim.
- `runtime/background/*` (the runtime itself) — file `DefaultBackgroundRuntime.ts` is touched only to simplify the `disallowedTools` literal. Internal class names like `BackgroundAgentRuntime` (if any) stay.
- Migration script for any old transcripts that referenced `BackgroundAgent` as a tool name. Transcripts are append-only history; existing entries stay as-is and are simply not relevant going forward. New sessions won't see `BackgroundAgent` in the tool list, so new transcripts won't have it.
- Per-subagent-type tool customization — separate concern.

## Migration / compatibility

- **Breaking change**: any LLM call that previously used `BackgroundAgent` will get "tool not found" — must rewrite to `Agent` with `run_in_background: true`. This is the intended break; zai hasn't shipped `BackgroundAgent` to end users yet (it's an internal library), so blast radius is the dev environment only.
- **No public API rename**: the `Agent` tool name is unchanged; only `BackgroundAgent` disappears.
- **disallowedTools simplification** is internal — no caller visible change.

## Files touched

| File | Action |
|------|--------|
| `packages/zai-agent-core/src/tools/BackgroundAgentTool/BackgroundAgentTool.ts` | Delete |
| `packages/zai-agent-core/src/tools/BackgroundAgentTool/prompt.ts` | Delete |
| `packages/zai-agent-core/src/tools/BackgroundAgentTool/schema.ts` | Delete |
| `packages/zai-agent-core/src/tools/BackgroundAgentTool/index.ts` | Delete |
| `packages/zai-agent-core/src/tools/index.ts` | Remove exports |
| `packages/zai-agent-core/src/tools/AgentTool/AgentTool.ts` | `disallowedTools` simplification |
| `packages/zai-agent-core/src/tools/AgentTool/prompt.ts` | Drop `BackgroundAgent` mention |
| `packages/zai-agent-core/src/runtime/background/DefaultBackgroundRuntime.ts` | `disallowedTools` simplification |
| `packages/zai-agent-core/src/runtime/types.ts` | JSDoc text update on `QueryOptions.disallowedTools` |
| `packages/zai-agent-core/src/runtime/queryEngine.ts` | JSDoc comment text update |
| `packages/zai-agent-core/src/runtime/background/registry.ts` | Audit; remove if applicable |
| `packages/zai-agent-core/src/opencc-internals/tools.ts` | Audit; remove re-exports |
| `packages/zai-agent-core/src/tools/TaskStopTool/prompt.ts` | Audit; update doc references |
| `packages/zai-agent-core/src/tools/TaskOutputTool/{schema.ts,TaskOutputTool.ts}` | Audit |
| `packages/zai-agent-core/src/tools/TaskCreateTool/prompt.ts` | Audit |
| `packages/zai/src/server/services/backgroundRuntime.ts` | Replace `BackgroundAgentTool` usage with `AgentTool` |
| `packages/zai-agent-core/test/runtime/resolveToolPool-disallowed.test.ts` | Drop `BackgroundAgent` from fixtures + assertions |
| `packages/zai-agent-core/test/tools/AgentTool.test.ts` | Audit; rename mocks if needed |