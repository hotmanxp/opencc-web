# OpenCC Adapter for zn-agent-core — Design Spec

**Date:** 2026-07-29
**Status:** Approved (brainstorm complete)
**Author:** opencc-web migration team

## Context

`packages/zn-agent-core/` was created by porting opencc 0.20.0 source and stripping UI (Task 1-7). It also provides compat shims (verbatim ports of zai-side inventions: `cwdStore`, `commands`, `transcript`, `background`, `MCPClientPool`, `pluginRuntime`, `skills`, `compactSession`) — Task 8-15, 21.

Today, `compat/runtime/contract.ts::DefaultAgentRuntime.run()` returns an empty `AsyncIterable<RuntimeEvent>`. zai builds but `/agent/prompt` produces no events. Real main loop is missing.

**This spec** defines the adapter layer that connects `DefaultAgentRuntime.run()` to opencc's `query()` so the actual main loop is restored.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Runtime source | **opencc `query()` directly** | Full feature reuse (MCP, hooks, permission, commands); accepts 27 Node test failures as Bun-runtime constraint |
| Adapter scope | **Thin layer, full delegation** | Type translation + meta wrapping only; opencc owns main loop |
| Tool port scope | **6 core tools** (Bash, Read, Edit, Write, Agent, AskUserQuestion) | Covers 80% of use cases; remaining tools in follow-up plans |
| Bun handling | **Detect + emit runtime.error early** | Clear UX over silent crash |

## Architecture

```
zai /agent/prompt
   │
   ▼
zai DefaultAgentRuntime.run(opts: QueryOptions)
   │
   ▼
zn-agent-core compat/runtime/contract.ts::DefaultAgentRuntime
   │  delegates to:
   ▼
zn-agent-core compat/runtime/openccAdapter.ts::runOpenccQuery(opts, config)
   │
   ├─ tools: zai Tool[] → opencc Tool[]      [openccToolWrap.ts]
   ├─ QueryOptions → QueryParams              [queryParamsAdapter.ts]
   ├─ inject MCPClientPool, HookRunner, skillsDirs via QueryParams slots
   │
   ▼
opencc-src query(params) → AsyncIterable<StreamEvent>
   │
   ▼
wrapWithZaiMeta (existing streamAdapter logic) → AsyncIterable<RuntimeEvent>
   │
   ▼
zai routes/agent.ts::translateRuntimeEvents → SSE (unchanged)
```

## Components

**New files (~10, ~700 LOC):**

| File | LOC | Purpose |
|------|-----|---------|
| `compat/runtime/openccAdapter.ts` | ~120 | `runOpenccQuery(opts, config)` — top-level adapter; Bun detection; abort bridging |
| `compat/runtime/openccToolWrap.ts` | ~180 | `wrapAsOpenccTool(tool)` — adapter satisfying opencc's 30+ method `Tool` interface |
| `compat/runtime/queryParamsAdapter.ts` | ~80 | `toQueryParams(opts, config)` — `QueryOptions` → opencc `QueryParams` translation |
| `compat/runtime/openccToolDefaults.ts` | ~60 | Constants for tool no-op defaults |
| `compat/tools/opencc/BashTool.ts` | ~50 | wraps `compat/tools/bash/` |
| `compat/tools/opencc/ReadTool.ts` | ~40 | wraps `compat/tools/read/` |
| `compat/tools/opencc/EditTool.ts` | ~40 | wraps `compat/tools/edit/` |
| `compat/tools/opencc/WriteTool.ts` | ~40 | wraps `compat/tools/write/` |
| `compat/tools/opencc/AgentTool.ts` | ~80 | wraps `compat/tools/agent/` (parentSessionId preservation) |
| `compat/tools/opencc/AskUserQuestionTool.ts` | ~50 | wraps `compat/tools/ask/` (AskRegistry integration) |

**Modified files (3):**

| File | Change |
|------|--------|
| `compat/runtime/contract.ts` | Replace stub `run()` with `runOpenccQuery(opts, this.config)` |
| `compat/runtime/types.ts` | Add `OpenccAdapterConfig` interface (mcpPool, hookRunner, skillsDirs) |
| `compat/runtime/index.ts` | Re-export adapter symbols if any |

## Data flow

**Forward: QueryOptions → QueryParams → StreamEvent → RuntimeEvent**

1. `DefaultAgentRuntime.run(opts)` delegates to `runOpenccQuery(opts, config)`
2. Adapter translates:
   - `opts.prompt` → `params.messages[0]`
   - `opts.cwd` → `params.cwd`
   - `opts.model` → `params.model`
   - `opts.tools` → `params.tools` (each via `wrapAsOpenccTool()`)
   - `opts.sessionId` → `params.sessionId`
   - `opts.parentSessionId` → `params.parentSessionId`
   - `opts.abortSignal` → `params.abortController` (bridged)
   - `config.mcpPool` → `params.mcpServers`
   - `config.hookRunner` → `params.hookRuntime`
   - `config.skillsDirs` → `params.skillsDirs`
3. `openccSrc.query(params)` returns `AsyncIterable<StreamEvent>` (Anthropic-shaped)
4. `wrapWithZaiMeta()` enriches each event with `eventId`, `sessionId`, `ts`, `turnIndex`
5. Result is `AsyncIterable<RuntimeEvent>` — zai downstream consumes unchanged

**Backward: zai translateRuntimeEvents → ServerEvent** is unchanged. `RuntimeEvent` is a superset of `StreamEvent` (just adds meta fields); existing zai code handles it.

## Error handling

| Scenario | Adapter behavior |
|----------|-----------------|
| Not running under Bun | Yield `runtime.error` with category `internal`, message `'zn-agent-core opencc adapter requires Bun runtime...'`, then return |
| Stream yields `error` event | Forward as `runtime.error` after `classifyError()` |
| Stream throws | Yield `runtime.error` via `toRuntimeErrorEvent()`, then return |
| Stream ends without `message_stop` | Yield `runtime.error` with category `llm_provider_server` |
| `abortSignal.aborted` before start | Yield `runtime.aborted`, return |
| Mid-stream abort | opencc aborts via bridged controller; stream ends naturally |
| Tool `call()` throws | opencc handles; emits `tool_result` with `is_error: true` → `runtime.tool_result` event |
| MCP / hooks / skills init fails | Yield `runtime.error` with appropriate category from `classifyError()`, return |

**`maxTurns`**: not enforced by adapter — opencc owns its turn loop. Documented limitation in adapter JSDoc.

## Testing

**Unit tests (vitest, Node):**

- `compat/runtime/openccAdapter.test.ts` — Bun detection, abort signal translation, meta enrichment
- `compat/runtime/openccToolWrap.test.ts` — `wrapAsOpenccTool()` produces valid `Tool`; default methods behave correctly; `call()` delegates
- `compat/runtime/queryParamsAdapter.test.ts` — translation shape, defaults, abort bridging

Expected Node test results: 27 pre-existing `bun:bundle` failures remain unchanged + new adapter tests pass.

**Integration tests (vitest, gated on `process.versions.bun`):**

- `compat/runtime/openccAdapter.integration.test.ts` — end-to-end streaming, tool execution, abort mid-stream

**Manual smoke:**

```bash
bun --cwd packages/zai src/cli/index.ts dev
```

Verify in browser: text streams, simple tool call works, abort stops stream, subagent triggers AgentTool.

**Verification commands:**

```bash
pnpm --filter @zn-ai/zn-agent-core build
pnpm --filter @zn-ai/zn-agent-core test
bun --cwd packages/zn-agent-core test
pnpm --filter zai build
pnpm --filter zai typecheck
```

**Coverage target**: adapter + tool wrappers ≥ 80% line, ≥ 70% branch. `opencc-src/` files excluded (upstream-owned).

## Out of scope (follow-up plans)

- TodoWrite, TaskOutput, TaskCreate, BackgroundAgentResult, REPL tools
- zai-specific commands integration with opencc's slash command system
- Resume from compacted transcript (`compact_boundary` chain)
- Streaming compaction (`recoverMaxOutputTokens` self-healing under Bun)
- Bun-vs-Node runtime auto-detection beyond the manual check

## Risks

| Risk | Mitigation |
|------|------------|
| opencc's `Tool` interface has hidden methods not in our type def | `openccToolWrap.ts` runtime check: warn if `tool` is missing a property that opencc queries |
| opencc's `query()` returns Anthropic events that zai's `translateRuntimeEvents` doesn't expect | Same envelope shape (Anthropic SDK); expected to work |
| `wrapWithZaiMeta` turnIndex counter desync from opencc's internal counter | opencc's turn index flows through events; adapter uses its own counter for `eventId` only |
| Bun runtime mismatch in production | Documented in AGENTS.md; clear runtime.error if not Bun |

## Done criteria

- [ ] All 10 new files implemented with type-correct signatures
- [ ] `compat/runtime/contract.ts` no longer stubbed
- [ ] `pnpm --filter @zn-ai/zn-agent-core build` passes
- [ ] `pnpm --filter zai build` passes; `pnpm --filter zai typecheck` reports no new errors
- [ ] Bun-mode integration tests pass; Node unit tests pass (27 pre-existing bun:bundle failures unchanged)
- [ ] Manual smoke verified in browser: chat, tool call, abort, subagent
- [ ] AGENTS.md updated with Bun runtime requirement