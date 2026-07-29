# OpenCC Adapter for zn-agent-core (Node/tsx) — Design Spec

**Date:** 2026-07-29
**Status:** Approved (brainstorm complete)
**Supersedes:** `2026-07-29-zn-agent-core-opencc-adapter-design.md` (path A, Bun-only) — see Deprecation
**Author:** opencc-web migration team

## Context

`packages/zn-agent-core/` was created by porting opencc 0.20.0 source and stripping UI. Today:

- `compat/runtime/contract.ts::DefaultAgentRuntime.run()` is wired to `compat/runtime/openccAdapter.ts` (Phase 1.b), which calls zai's own `modelCaller` and bypasses `opencc-src/` entirely.
- `compat/runtime/openccQueryBridge.ts` and `sdkEventAdapter.ts` exist as Phase 5 **stubs** that yield `runtime.error: not_implemented` and route to the Phase 1.b adapter.
- `opencc-src/query.ts` cannot be loaded under Node/tsx: the first import reaches `services/api/withRetry.ts:1` which does `import { feature } from 'bun:bundle'`, causing `ERR_UNSUPPORTED_ESM_URL_SCHEME: protocol 'bun:'`.
- 86 non-test source files in `opencc-src/` still import `bun:bundle`; a shim existed in commit `bfc44360` and was later deleted by a sync-from-opencc.
- 424 dangling `.js` imports exist (UI files stripped), but they only fire if a non-core tool's import path is exercised at runtime.

**This spec** defines a Node/tsx-compatible adapter layer that actually calls `openccSrc.query()` and ships 6 wrapped core tools, replacing the Phase 1.b bypass.

The original Bun-only spec (`2026-07-29-zn-agent-core-opencc-adapter-design.md`) and its plan remain valid as **historical record** of the Phase 1 path; both are marked **deprecated** in favor of this Node/tsx design.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Runtime | **Node 22+ / tsx** (already deployed) | Reverts Bun requirement; matches recent pivot commits `a88ebff5` + `a441b0f8` |
| bun: protocol handling | **Node loader hook** (not file rewrite) | Vendored code stays untouched; survives `pnpm copy-from-opencc` |
| `openccSrc.query()` call site | **openccQueryBridge** (fills existing Phase 5 stub) | Bridge was scaffolded for this; no new entrypoint |
| Stream translation | **sdkEventAdapter** (fills existing Phase 5 stub) | Same — SDKMessage → Anthropic primitives, then zai `translateRuntimeEvents` is unchanged |
| Tool port scope | **6 core tools** (Bash, Read, Edit, Write, Agent, AskUserQuestion) | Same as path A; covers 80% of use cases |
| Dangling .js imports | **Lazy stub on encounter** | Don't pre-stub 424 files; only stub paths the import chain actually reaches |
| Vendored code | **Read-only** | `opencc-src/` never edited; sync-from-opencc stays safe |

## Deprecation

- **Deprecated:** `docs/superpowers/specs/2026-07-29-zn-agent-core-opencc-adapter-design.md` and `docs/superpowers/plans/2026-07-29-zn-agent-core-opencc-adapter.md` (Bun-only path A)
- Add banner to those files: *"Superseded by `2026-07-29-zn-agent-core-opencc-adapter-node-design.md` (path B, Node/tsx). Kept for historical record."*
- Tasks 1-6, 14, 15 of the old plan are still valid (defaults, wrap, overrides, queryParamsAdapter, openccAdapter abort logic, Bun-gated tests, AGENTS.md). Rename / re-target as needed in the new plan.
- Tasks 7-13 (6 tool wrappers) are reused as-is.

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
zn-agent-core compat/runtime/openccQueryBridge.ts::runViaOpenccQuery(opts, config)
   │
   ├─ toQueryParams(opts, config)         [QueryOptions → opencc QueryParams]
   ├─ defaultCoreToolsAsOpencc()          [6 wrapped tools from compat/tools/opencc/]
   │
   ▼
opencc-src query(params) → AsyncIterable<SDKMessage>
   │
   ▼
compat/runtime/sdkEventAdapter.ts::translateSdkToRuntime(msg, meta)
   │  unwraps SDKMessage → Anthropic primitives (message_start / content_block_* / message_delta / message_stop / error)
   │
   ▼
wrapWithZaiMeta (existing streamAdapter logic) → AsyncIterable<RuntimeEvent>
   │
   ▼
zai routes/agent.ts::translateRuntimeEvents → SSE (unchanged)
```

**Side channel — bun: protocol interception:**

The bun: specifier is intercepted at the Node loader level, **before** any bridge code runs. The bridge code itself is unaware of bun: handling.

```
zai dev script: tsx --import ./bun-protocol.mjs src/cli/index.ts dev
                       │
                       ▼
       bun-protocol.mjs  (Node loader hook, ~30 LOC)
         register({ resolve }) →
           specifier.startsWith('bun:') → return './bun-shim.ts' (or analogous)
                       │
                       ▼
       compat/runtime/bun-shim.ts
         feature(flag, defaultValue?) + require(id) stub
```

## Components

**New files (4):**

| File | LOC | Purpose |
|------|-----|---------|
| `compat/runtime/bun-shim.ts` | ~50 | `feature(flag, defaultValue?)` and `require(id)` stubs; env override + static flag tree |
| `compat/runtime/bun-protocol.mjs` | ~30 | Node `register({ resolve })` hook redirecting `bun:bundle` → `bun-shim.ts` |
| `compat/tools/opencc/BashTool.ts` | ~50 | Wraps zai `compat/tools/bash/bashTool` as opencc `Tool`; `isDestructive: true` |
| `compat/tools/opencc/ReadTool.ts` | ~40 | Wraps zai Read; `isReadOnly: true` |
| `compat/tools/opencc/EditTool.ts` | ~40 | Wraps zai Edit; `isDestructive: true` |
| `compat/tools/opencc/WriteTool.ts` | ~40 | Wraps zai Write; `isDestructive: true` |
| `compat/tools/opencc/AgentTool.ts` | ~80 | Wraps zai Agent; preserves `parentSessionId` (SubagentNotifier chain) |
| `compat/tools/opencc/AskUserQuestionTool.ts` | ~50 | Wraps zai AskUserQuestion; `requiresUserInteraction: true`, `interruptBehavior: 'block'` |
| `compat/tools/opencc/index.ts` | ~20 | Barrel + `defaultCoreToolsAsOpencc()` factory |

**Modified files (6):**

| File | Change |
|------|--------|
| `compat/runtime/openccQueryBridge.ts` | Replace stub with full bridge: Bun→Node shim loading, params translation, tool wiring, stream forwarding |
| `compat/runtime/sdkEventAdapter.ts` | Replace skeleton with full translator: SDKMessage union → Anthropic primitives |
| `packages/zai/package.json` | `dev` script: `tsx --import ./bun-protocol.mjs src/cli/index.ts dev` |
| `packages/zai/vite.config.ts` | Mark `opencc-src/**` and `bun:*` as `external` (Vite must not bundle dynamic opencc imports) |
| `packages/zn-agent-core/vitest.config.ts` | `setupFiles: ['./bun-protocol.mjs']` |
| `tsconfig.base.json` | `paths: { "bun:bundle": ["./packages/zn-agent-core/src/compat/runtime/bun-shim.ts"] }` (IDE / tsc) |
| `AGENTS.md` | Document loader requirement, mark path A spec/plan deprecated |

**Already in place (no change):**
- `compat/runtime/contract.ts` (Task 6 of old plan)
- `compat/runtime/openccAdapter.ts` (Phase 1.b — used as fallback if bridge throws at first call)
- `compat/runtime/openccToolDefaults.ts`, `openccToolWrap.ts` (Tasks 1-3 of old plan)
- `compat/runtime/queryParamsAdapter.ts` (Task 4 of old plan)
- `compat/runtime/streamAdapter.ts` (RuntimeEvent meta wrapping)

## Data flow

**Forward: QueryOptions → QueryParams → SDKMessage stream → RuntimeEvent stream**

1. `DefaultAgentRuntime.run(opts)` delegates to `runViaOpenccQuery(opts, config)`.
2. Bridge triggers the openccSrc module load via `await import('opencc-src/query.js')` once and caches the result. The 86 `bun:bundle` imports in the transitive chain resolve to `bun-shim.ts` because the `bun-protocol.mjs` Node loader is registered before this code runs. If any `.js` file is missing (see "Dangling .js handling"), bridge stubs + retries.
3. `toQueryParams(opts, config)` translates:
   - `opts.prompt` → `params.messages[0]`
   - `opts.cwd` → `params.cwd`
   - `opts.model` → `params.model`
   - `opts.sessionId` → `params.sessionId`
   - `opts.parentSessionId` → `params.parentSessionId`
   - `opts.abortSignal` → `params.abortController` (bridged)
   - `opts.tools` merged with `defaultCoreToolsAsOpencc()` (zai tools win on name collision) → `params.tools` (each via `wrapAsOpenccTool()`)
   - `config.mcpPool` → `params.mcpServers`
   - `config.hookRunner` → `params.hookRuntime`
   - `config.skillsDirs` → `params.skillsDirs`
4. `openccSrc.query(params)` returns `AsyncIterable<SDKMessage>`.
5. For each `SDKMessage`, `translateSdkToRuntime(msg, meta)` yields 0..N Anthropic primitives (`message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop` / `error`).
6. `wrapWithZaiMeta()` enriches each event with `eventId`, `sessionId`, `ts`, `turnIndex` (per `streamAdapter`).
7. Result is `AsyncIterable<RuntimeEvent>` — zai downstream consumes unchanged.

**Backward: zai translateRuntimeEvents → ServerEvent** is unchanged. `RuntimeEvent` is a superset of the Anthropic primitive shape; existing zai code handles it.

## Error handling

| Scenario | Bridge behavior |
|----------|----------------|
| `bun:bundle` import not intercepted (loader not loaded) | Yield `runtime.error` category `internal`, message `'bun-protocol.mjs loader not registered; run with tsx --import ...'` |
| Stream yields `error` event | Forward as `runtime.error` after `classifyError()` |
| `openccSrc.query()` throws (import error, missing dep) | Yield `runtime.error` via `toRuntimeErrorEvent()`, then return |
| Stream ends without `message_stop` | Yield `runtime.error` category `llm_provider_server` |
| `abortSignal.aborted` before start | Yield `runtime.aborted`, return |
| Mid-stream abort | Bridge yields `runtime.aborted`; opencc's bridged abortController propagates |
| Tool `call()` throws (one of the 6) | `wrapAsOpenccTool.call()` catches → returns `{ content: [{ type: 'text', text: '...' }], is_error: true }` |
| Dangling `.js` import hit at runtime (UI-shaped module) | Bridge auto-stubs as `export default {}` in `compat/runtime/dangling-shims/`, logs once, retries import. (See "Dangling .js handling" below.) |
| Dangling `.js` import for a **core** module (e.g. `services/api/withRetry.ts` re-exports) | Bridge yields `runtime.error` listing the path; operator must hand-stub in `compat/runtime/dangling-shims/` |
| Bridge itself throws synchronously | Catch in `DefaultAgentRuntime.run`, yield single `runtime.error` |

**`maxTurns`**: not enforced by bridge — opencc owns its turn loop. Documented limitation in bridge JSDoc.

## Dangling .js handling

Strategy: **lazy stub on first encounter**, not pre-stub 424 files.

**What is "dangling" here**: a file `import './foo.js'` where the corresponding `foo.ts` is a `.tsx` UI component (e.g. `Spinner.tsx`) that was stripped by `copy-from-opencc.mjs` `STRIP_DIRS`. These are distinct from the `bun:` problem (handled by `bun-protocol.mjs`); they are ordinary file-not-found errors during Node ESM resolution.

**What works vs what doesn't**:
- ✅ **UI-shaped modules** (React components, Ink components, TUI handlers) → `export default {}` is fine because opencc only touches them from renderer code paths that zai never reaches
- ❌ **Core modules** (e.g. `services/api/withRetry.ts` which exports `FallbackTriggeredError`) → `export default {}` would crash opencc's `instanceof` / class checks. These must be hand-stubbed with the actual exports
- ⚠️ **Mixed modules** (rare) — same as core; hand-stub

**The 424 dangling imports from the Phase 3 grep are predominantly UI-shaped** (verified against `STRIP_DIRS` in `scripts/copy-from-opencc.mjs`). Core exports (the 4-5 that need real values) will be hand-stubbed in `compat/runtime/dangling-shims/` during implementation; see "Dangling .js pre-stub (hand-written)" in the implementation plan.

**Mechanism (for UI-shaped modules):**
1. Bridge first does `await import('opencc-src/query.js')` at the start of each `runViaOpenccQuery` call. The result is cached in module scope after first success.
2. On `ERR_MODULE_NOT_FOUND` for a relative path, bridge: (a) checks if a stub already exists in `compat/runtime/dangling-shims/` (b) if not, writes `export default {}` with a `console.warn` naming the path, (c) re-issues the import. Node's ESM loader picks up the new file.
3. Limit: 50 stubs per process. Beyond that, the bridge yields a `runtime.error` and gives up (prevents infinite loop if a missing dep is structurally unreachable).
4. **Escalation**: if a non-`./`-prefixed import fails (i.e. an npm package), the bridge does NOT auto-stub. It yields a `runtime.error` with the package name so the operator can `pnpm add` it.

**Caveat**: lazy stub is "good enough" but not great — opencc's behavior may diverge when a UI module it expected to be present is now an empty object. This is acceptable for path B because zai's 6 wrapped core tools don't depend on UI; the rest of opencc's behavior should be unaffected. Smoke tests will catch regressions.

## bun-shim.ts surface

Resurrected from `bfc44360` (deleted shim). Public surface:

```ts
declare module 'bun:bundle' {
  export function feature<T>(flag: string, defaultValue?: T): T | boolean
  export function require(id: string): never
}
```

Default flags (curated; env-overridable via `ZAI_OPENCC_FEATURE_<FLAG>`):
- `REACTIVE_COMPACT`, `MULTI_TURN_CONTEXT`, `HISTORY_SNIP`, `FILE_PERSISTENCE`, `BASH_CLASSIFIER` → `true`
- All other flags → `false` (or `defaultValue` if provided)

`require()` throws (not supported) — call sites must use static imports.

## Testing

**Unit tests (vitest, Node):**

- `compat/runtime/bunShim.test.ts` — `feature()` default + env override + static table
- `compat/runtime/openccQueryBridge.test.ts` — Bun-protocol detection (via mock), abort signal translation, params translation, meta enrichment
- `compat/runtime/sdkEventAdapter.test.ts` — each SDKMessage variant → expected Anthropic primitives
- `compat/runtime/queryParamsAdapter.test.ts` — reuse old plan's tests
- `compat/tools/opencc/BashTool.test.ts` through `AskUserQuestionTool.test.ts` — wrapper shape + delegation

**Lazy-stub tests:**

- `compat/runtime/danglingShims.test.ts` — given a fake `ERR_MODULE_NOT_FOUND`, bridge creates the stub, retries, and proceeds
- Cap test: 51st stub request yields `runtime.error` and stops

**Integration tests (vitest, Node — Bun no longer required):**

- `compat/runtime/openccQueryBridge.integration.test.ts` — end-to-end: prompt in → text deltas out (model mocked at zai modelCaller boundary)
- `compat/tools/opencc/AgentTool.integration.test.ts` — sub-agent dispatch preserves `parentSessionId`

**Manual smoke:**
```bash
cd packages/zai && bun --bun src/cli/index.ts dev   # or pnpm dev (which now uses tsx --import)
```
Verify in browser: text streams, simple Bash call, abort stops stream, AskUserQuestion pops QuestionCard, subagent triggers AgentTool.

**Verification commands:**
```bash
pnpm --filter @zn-ai/zn-agent-core build
pnpm --filter @zn-ai/zn-agent-core test
pnpm --filter zai build
pnpm --filter zai typecheck
```

**Coverage target**: bridge + tool wrappers + sdkEventAdapter ≥ 80% line, ≥ 70% branch. `opencc-src/` files excluded (upstream-owned).

## Out of scope (follow-up plans)

- TodoWrite, TaskOutput, TaskCreate, BackgroundAgentResult, REPL tools
- zai-specific commands integration with opencc's slash command system
- Resume from compacted transcript (`compact_boundary` chain)
- Streaming compaction (`recoverMaxOutputTokens` self-healing)
- Dangling .js pre-stubbing (all 424 at once) — only done lazily as needed
- `bun:test` loader hook (test files out of runtime path)

## Risks

| Risk | Mitigation |
|------|------------|
| `openccSrc.query()` signature has fields not in our type def | Bridge does structural runtime check; warn on missing field; if query() refuses, bridge yields `runtime.error` rather than crashing |
| Dangling .js stub returns empty object → opencc reads bad data | Lazy stub + smoke tests; if a critical path breaks, manually upgrade stub from `export default {}` to a typed minimal impl |
| `bun-protocol.mjs` not loaded → all `bun:bundle` imports crash | Bridge detects at first call and yields clear `runtime.error`; zai dev script always passes `--import` |
| Lazy stub loop (stub A imports B which is also missing) | Bridge increments a counter; aborts at 50 with `runtime.error`; covers infinite recursion |
| Vendored code drift: opencc sync re-introduces 86 `bun:bundle` imports | Loader hook is regex-agnostic; just works on any `bun:` prefix |
| `tsx --import` not honored by all consumers (vitest, esbuild) | vitest config adds `setupFiles`; esbuild builds don't load `bun:` (out of bundle path) |
| Vite build tries to bundle `opencc-src/query.js` (dynamic import string literal) | Mark `opencc-src/**` and `bun:*` as `external` in `packages/zai/vite.config.ts`; zai server runs the dynamic import at runtime, not at build time |

## Done criteria

- [ ] 4 new files implemented with type-correct signatures (`bun-shim.ts`, `bun-protocol.mjs`, `openccQueryBridge.ts` filled in, `sdkEventAdapter.ts` filled in)
- [ ] 6 tool wrappers + barrel + `defaultCoreToolsAsOpencc()` factory
- [ ] `compat/runtime/openccQueryBridge.ts` no longer stub
- [ ] zai `dev` script uses `tsx --import ./bun-protocol.mjs`
- [ ] vitest config includes `setupFiles: ['./bun-protocol.mjs']`
- [ ] tsconfig.base.json has `paths` mapping for `bun:bundle` → `bun-shim.ts`
- [ ] `pnpm -r build` passes; `pnpm -r typecheck` no new errors
- [ ] Unit tests pass; `pnpm --filter @zn-ai/zn-agent-core test` no increase in pre-existing failures
- [ ] Integration test: end-to-end prompt → text deltas (model mocked)
- [ ] Manual smoke verified in browser: chat, tool call, abort, subagent, AskUserQuestion
- [ ] Old `2026-07-29-zn-agent-core-opencc-adapter-design.md` (path A) marked deprecated with banner pointing to this spec
- [ ] AGENTS.md updated to document loader requirement + deprecation note

## Implementation order (high-level)

This is **not the implementation plan** — see writing-plans for the task-by-task breakdown. Roughly:

1. `bun-shim.ts` (rehydrate) + unit test
2. `bun-protocol.mjs` + verify with the diagnostic spike (`node -e "import('./opencc-src/query.ts')"` no longer fails on `bun:`)
3. Re-run diagnostic spike to find next blocker (likely a `.js` dangling import in the default tool path)
4. `sdkEventAdapter.ts` (Message union → Anthropic primitives)
5. 6 tool wrappers + barrel
6. Fill in `openccQueryBridge.ts` (params + tools + stream forwarding)
7. Wire zai dev script + vitest config + tsconfig
8. Manual smoke
9. Deprecation banner on old spec/plan
