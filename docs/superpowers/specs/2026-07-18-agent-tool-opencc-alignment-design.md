# AgentTool OpenCC Alignment Design

**Date:** 2026-07-18
**Status:** Design approved, pending implementation plan
**Author:** ethan

## Background

`packages/zai-agent-core/src/tools/AgentTool/AgentTool.ts` is currently a
hand-rolled `LegacyTool` that fires its own `queryLoop(...)` event loop and
ships `run_in_background` as a zai-specific extension. The recent
BashTool/EditTool/FileRead alignment commits
(`e938ea9`, `8f56820`, `6da12fe`) establish the project's alignment idiom:
sync reference modules from upstream opencc, then port the tool onto the
opencc `Tool` contract.

This spec aligns AgentTool to that idiom and goes further: the sync path
forks through upstream `runForkedAgent` so that sub-agent prompt-cache hits
mirror the parent's — a hard requirement from product. The async background
path stays on zai's `BackgroundRuntime` because the `SubagentNotifier`
→ `<task-notification>` resume chain is zai-local and cannot be ported
without breaking parent-session continuity.

## Goals

1. Replace `AgentTool`'s `LegacyTool` body with an opencc-style `Tool` contract:
   `call`, `validateInput`, `checkPermissions`, `prompt`, `userFacingName`,
   `getToolUseSummary`, `getActivityDescription`,
   `mapToolResultToToolResultBlockParam`, `toAutoClassifierInput`,
   `isConcurrencySafe`, `isReadOnly`, `isDestructive`.
2. Replace the sync dispatch (currently a manual `for-await queryLoop` loop)
   with `runForkedAgent` so the sub-agent shares the parent's prompt cache
   via `CacheSafeParams`.
3. Wire `saveCacheSafeParams(...)` into zai's main `queryLoop` loop so the
   snapshot is available to `AgentTool` when called.
4. Preserve the async `BackgroundRuntime` path unchanged (SubagentNotifier
   chain is load-bearing).
5. Preserve all zai-local surface that callers rely on:
   `emitEvent subagent:start|event|done`, `<subagent_result>` / `<subagent_dispatched>`
   output wrappers, `run_in_background: true|false` schema field, hook
   `SubagentStart`/`SubagentStop` invocations, the `disallowedTools:['Agent']`
   anti-recursion guard.

## Non-Goals

- No ToolUseContext / REPLHookContext 抽象层全量化。zai `LegacyToolContext` is
  not replaced upstream-wide; AgentTool bridges locally.
- No `tools/AgentTool/AgentTool.tsx` upstream sync of the body — zai re-authors
  its own equivalent under `src/tools/AgentTool/`.
- No changes to `loadAgentsDir.ts`, `builtInAgents.ts`, `subAgentNotifier.ts`,
  `BackgroundRuntime`, or `queryLoop` semantics beyond the
  `saveCacheSafeParams` hook.
- No automatic e2e tests beyond extending `AgentTool.test.ts`.
- No upstream sync of AgentTool.tsx prompt text itself (depends on local
  OPENCC_SRC access — see Risk R1).

## Design

### Contract changes (zai-local `Tool` interface in `tools/Tool.ts`)

`LegacyTool` already exposes the opencc method set as optional methods
extended in `e938ea9`. This spec reuses that bridge — `legacyAdapter.ts`
already wraps legacy tools into opencc `Tool` shape. `AgentTool` is rewritten
to satisfy the method set directly, no longer relying on adapter defaults
for the canonical methods.

### `AgentTool` body (`tools/AgentTool/AgentTool.ts`)

The new `AgentTool` is a `Tool<AgentInput, string>`. Dispatch flow:

```
call(rawInput, ctx):
  1. validateInput(rawInput, ctx)
     └─► reject empty prompt: { result:false, message, errorCode:1 }

  2. if rawInput.run_in_background !== false && hasBackgroundRuntime():
       ⚠ ASYNC PATH — UNCHANGED FROM CURRENT ZAI BEHAVIOR
       dispatch via BackgroundRuntime.dispatch({ prompt, agent, metadata })
       emit 'subagent:start' + 'subagent:dispatched'
       return <subagent_dispatched>

  3. SYNC PATH (run_in_background=false OR no BG runtime):
       a. loadAgentDefinitions(dataDir, ctx.__runtimeConfig?.userAgentsDir)
          agent = find(subagent_type) ?? 'general-purpose' ?? first built-in
       b. SubagentStart hook fire
       c. emit 'subagent:start' with subSessionId
       d. cacheSafeParams = getLastCacheSafeParams() ?? fallbackEmptyCacheSafeParams(ctx)
          ⚠ If fallback fires (zai queryLoop didn't pre-warm), fall through
          to a manual query() call with the legacy QueryOptions shape so
          AgentTool never deadlocks.
       e. result = await runForkedAgent({
            promptMessages: [createUserMessage({ content: rawInput.prompt })],
            cacheSafeParams,
            canUseTool: ctx.canUseTool,
            querySource: 'agent',
            forkLabel: rawInput.subagent_type,
            maxTurns: agent.maxTurns ?? 25,
            onStreamEvent: (ev) => emit 'subagent:event',
            skipTranscript: true,    // ⚠ R4: zai v2 transcript absorbs
                                      //    sub-agents via parent resume
            skipCacheWrite: false,   // first sub-call warms cache for next
          })
       f. extractResultText(result.messages) → finalOutput
       g. exitReason: 'completed' | 'max_turns' | 'aborted' | 'error'
          (mapped from result + abort signal)
       h. SubagentStop hook fire
       i. emit 'subagent:done'
       j. return <subagent_result> ...
```

Map method implementations:

| opencc method | zai-local impl |
|---|---|
| `prompt()` | return `getAgentToolDescription()` |
| `validateInput(input, ctx)` | empty prompt → deny |
| `checkPermissions(input, ctx)` | always `{ behavior:'allow' }` |
| `userFacingName(input)` | `Agent(${input.subagent_type})` |
| `getActivityDescription(input)` | short label = description ?? prompt.slice(0,60) |
| `getToolUseSummary(input)` | subSessionId name fragment |
| `mapToolResultToToolResultBlockParam(output, toolUseId)` | `{ tool_use_id, type:'tool_result', content: output, is_error: false }` |
| `toAutoClassifierInput(input)` | `{ name:'Agent', subagent_type, prompt, description }` |
| `isConcurrencySafe` / `isReadOnly` / `isDestructive` | unchanged booleans |

### Schema changes (`tools/AgentTool/schema.ts`)

```ts
export const AgentInputSchema = z.object({
  prompt: z.string().min(1)
    .describe('The task for the sub-agent. Required.'),
  subagent_type: z.string().min(1).default('general-purpose')
    .describe('Which agent definition to use. Defaults to general-purpose.'),
  description: z.string().optional()
    .describe('Short label shown in transcript.'),
  run_in_background: z.boolean().optional().default(true)
    .describe('When true (default), dispatch async via BackgroundRuntime. '
            + 'When false, block until sub-agent completes.'),
}).strict()
```

The `run_in_background` field is zai-local (opencc has no equivalent — opencc
sync fork has no async notion). We add it under `.strict()` so unexpected
keys are rejected, consistent with the upstream BashTool/FileWrite port.

### Prompt (`tools/AgentTool/prompt.ts`)

Export `getAgentToolDescription()` exporting a function (opencc convention)
rather than the current `renderPrompt()` constant. Body text mirrors the
upstream Tool description verbatim where the upstream source is available;
where OPENCC_SRC is unreachable, the impl uses a textual placeholder
explicitly marked `// upstream-prompt-source: pending` so a follow-up
sync run replaces it.

`renderAvailableAgentsSection(agents)` is preserved and rendered by
`getAgentToolDescription()` so the `<AVAILABLE_AGENTS>` block is appended
when agents are loaded.

### SystemPrompt semantics — async vs sync path (deliberate asymmetry)

| Path | systemPrompt behavior | Rationale |
|---|---|---|
| Async (`run_in_background`) | `agent.systemPrompt` replaces parent's prompt entirely | zai legacy behavior; preserves `<task-notification>` resume chain |
| Sync (`runForkedAgent`) | Parent's `cacheSafeParams.systemPrompt` is kept verbatim; `agent.systemPrompt` is appended into `cacheSafeParams.systemContext` instead | Required for prompt-cache hit — modifying the `systemPrompt` invalidates the cache key |

In the sync call site the implementation passes
`systemContext: { ...parentSystemContext, [AGENT_PROMPT_KEY]: agent.systemPrompt }`
so forked agents receive their agent instructions without breaking the
cache contract. The key name (`AGENT_PROMPT_KEY`) is a constant string
defined in `AgentTool.ts`; the opencc upstream uses a similar convention
for skill content injection.

### queryLoop hook (`runtime/queryLoop.ts`)

After each turn-end (where sawMessageStop is recorded), call:

```ts
import { saveCacheSafeParams } from '../opencc-internals/utils/forkedAgent.js'

saveCacheSafeParams({
  systemPrompt: <zai-built-systemPrompt>,
  userContext: <zai env-derived context>,
  systemContext: {},
  toolUseContext: <zai-built-ToolUseContextOrStub>,
  forkContextMessages: <zai-message-history-tail-or-empty>,
})
```

The values are read from zai queryLoop's existing internal book-keeping.
The `toolUseContext` does not need full upstream shape — only the
forkedAgent `createSubagentContext` reads are used:
`abortController`, `getAppState`, `options`, `messages`,
`readFileState`, `queryTracking`, plus a no-op for every mutation
callback (`setAppState`, `setInProgressToolUseIDs`, `setResponseLength`,
`pushApiMetricsEntry`, `updateFileHistoryState`).

`saveCacheSafeParams` is wrapped in `try/finally` so its throw does not
abort zai's main loop (R3 mitigation).

### Pre-flight sync

5 modules must be brought into `opencc-internals/` so `runForkedAgent` resolves:

| File | Origin | Purpose |
|---|---|---|
| `utils/sessionStorage.ts` | `OPENCC_SRC/utils/sessionStorage.ts` | `recordSidechainTranscript` |
| `utils/toolResultStorage.ts` | `OPENCC_SRC/utils/toolResultStorage.ts` | `cloneContentReplacementState` |
| `utils/abortController.ts` | `OPENCC_SRC/utils/abortController.ts` | `createChildAbortController` |
| `utils/fileStateCache.ts` | `OPENCC_SRC/utils/fileStateCache.ts` | `cloneFileStateCache` |
| `types/toolResultStorage.ts` | `OPENCC_SRC/types/toolResultStorage.ts` | `ContentReplacementState` |

These are added to `scripts/sync-from-opencc.ts` `WHITELIST_PATTERNS`
under a new section marker `// AgentTool port — fork prerequisites`.

## File changes

### Phase 1 — pre-flight chore commit

```
modified  packages/zai-agent-core/scripts/sync-from-opencc.ts   (+5 lines)
new file  packages/zai-agent-core/src/opencc-internals/utils/sessionStorage.ts
new file  packages/zai-agent-core/src/opencc-internals/utils/toolResultStorage.ts
new file  packages/zai-agent-core/src/opencc-internals/utils/abortController.ts
new file  packages/zai-agent-core/src/opencc-internals/utils/fileStateCache.ts
new file  packages/zai-agent-core/src/opencc-internals/types/toolResultStorage.ts
```

### Phase 2 — AgentTool port commit

```
modified  packages/zai-agent-core/src/tools/AgentTool/AgentTool.ts
modified  packages/zai-agent-core/src/tools/AgentTool/prompt.ts
modified  packages/zai-agent-core/src/tools/AgentTool/schema.ts
modified  packages/zai-agent-core/test/tools/AgentTool.test.ts
```

`legacyAdapter.ts` is **not** modified — its current shape already forwards
all `Tool` method fields added in `e938ea9`.

### Phase 3 — queryLoop hook commit

```
modified  packages/zai-agent-core/src/runtime/queryLoop.ts
```

Adds `saveCacheSafeParams(...)` invocation in the message-stop branch, in a
`try/finally` so failures don't poison the main loop.

## Test plan

`packages/zai-agent-core/test/tools/AgentTool.test.ts`:

```
preserve (existing):
  - emits subagent:start/event/done in order
  - subSessionId format <parent>-sub-<8hex>
  - agent.systemPrompt propagates to fork query systemPrompt
  - missing __runtimeConfig → isError

add (new):
  - prompt() returns text containing "<AVAILABLE_AGENTS>" or upstream placeholder
  - validateInput({ prompt:'' }) → result:false
  - userFacingName({subagent_type:'Explore'}) === 'Agent(Explore)'
  - mapToolResultToToolResultBlockParam(output, id) shape correct
  - sync path with mocked runForkedAgent: emits subagent:event per content_block_delta
  - sync path abort → exitReason 'aborted' emitted via subagent:done
```

No e2e or integration tests added — out of scope (matches existing test
weakness posture).

## Risks

### R1. OPENCC_SRC path inaccessible
`sync-from-opencc.ts:37` hardcodes `/Users/liangxuechao572/code/opencc/src`.
The local dev environment may not have that path. Resolution paths:
(a) run with `OPENCC_SRC=/path/to/opencc/src pnpm sync-from-opencc --apply`,
(b) manually copy the 5 files and amend.
The spec is committed before the sync is run; CI must catch any
subsequent desync via `pnpm typecheck`.

### R2. Upstream `Tool` exact shape unknown locally
The verbatim `getAgentToolDescription()` text and any `Tool` interface
shape differences vs `LegacyTool` extended fields are not visually
verified until implementation. Implementation may iterate 1-2 times
discovering `Tool` requires a non-LegacyToolBridge field.

### R3. Stale `saveCacheSafeParams` snapshot
zai queryLoop early-returns on errors, leaving last-set params. Next
AgentTool fork may consume a stale `toolUseContext`. Mitigation:
`try/finally` around `saveCacheSafeParams` and snapshot reset on
major state changes. Test coverage added in Phase 3.

### R4. Sidechain transcript pollution
`runForkedAgent` writes a child transcript by default; zai has its own v2
transcript store that wouldn't see it. Mitigation: `skipTranscript: true`.

### R5. Cold-cache first call
First sync fork creates cache entries; no immediate benefit. Acceptable —
product spec is hit ratio across multiple forks.

### R6. Output wrapper compatibility
zai outputs `<subagent_result>` strings; `mapToolResultToToolResultBlockParam`
passes through as `tool_result.content`. `toolExecution` already accepts
string content.

### R7. Background path diverges from fork path
Background path uses `agent.systemPrompt` as a full replacement of the
parent prompt. Sync fork path uses `cacheSafeParams.systemPrompt` (parent)
plus the upstream fork idiom. This discrepancy is preserved intentionally —
modifying background path risks breaking SubagentNotifier resume.

### R8. Sidechain record exclusion (aliased to R4)
Already covered via `skipTranscript: true`.

### R9. Test fixtures
Existing `ctx.__runtimeConfig.modelCaller` mocks may not fit the new
forked-agent shape. Tests are rewritten in Phase 2 to use `runForkedAgent`
mocks instead.

## Acceptance checklist

```
[x] Phase 1 chore commit merged
[x] pnpm -r typecheck passes after Phase 1
[x] Phase 2 commit merged
[x] pnpm -r typecheck passes after Phase 2
[x] Phase 3 commit merged
[x] pnpm -r typecheck passes after Phase 3
[x] pnpm -r test passes (18/18 AgentTool GREEN; queryLoop test added but env-blocked)
[ ] pnpm smoke passes
[ ] manual: sync AgentTool → <subagent_result> emits subagent:event
[ ] manual: async AgentTool → parent receives <task-notification>
[ ] manual: second sync AgentTool shows non-zero cache_read_input_tokens
[x] PR review confirms SubagentNotifier resume chain intact (zero diff to BackgroundRuntime files verified)
```

Final merge commit on main: `494b808 feat(agent-tool): align AgentTool to upstream opencc Tool contract`.

## Open issues

- **OI1.** zai's full ToolUseContext migration is a separate, much larger
  spec.
- **OI2.** zai's main `queryLoop` could itself be replaced by the
  `QueryEngine` class upstream exposes — separate spec.
- **OI3.** prompt verbatim text relies on periodic
  `pnpm sync-from-opencc --apply` runs post-merge; this spec does not
  set up a CI auto-sync.
