# Spec — zai Codex subagent provider

**Status**: implemented
**Code**: `packages/zn-agent-core/src/opencc-src/compat/subagents/`

## Problem

zai today drives Codex only through in-process HTTP via `services/api/codexShim.ts`
(no app-server spawn, no separate conversation lifecycle). Subagent
delegation in zai is hardcoded inside `AgentTool.tsx` — fork and built-in
agents are routed through per-call branches, and there is no registry a
new provider can plug into without rewriting the existing tool surface.

A user calling `Agent(subagent_type='codex')` has no path: the model
handed a task to an agent that does not exist. Without a real Codex CLI
integration we cannot answer requests like "delegate this task to a
fresh Codex session and report the final answer back".

## Decision

Add two minimal seams plus one product package:

### 1. Subprocess seam (`compat/subprocess/`)

A pipe-stdio spawn helper with explicit credentials-scrubbed env and
tree-kill teardown. Backed by `child_process.spawn` with
`stdio: ['pipe', 'pipe', 'pipe']`. The seam:

- **Strips a fixed credential-shaped ambient var list** unconditionally
  (no `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` gate, unlike Bash/MCP-seam
  callers). The list mirrors `compat/subprocessEnv.ts:GHA_SUBPROCESS_SCRUB`
  and adds the OpenAI / Codex / Azure OpenAI family. Lifting either list
  is a one-PR audit because we keep both growing in lockstep.
- **Kills the whole process tree**: SIGTERM → grace (`disposeGraceMs`,
  default 3000ms) → SIGKILL via `tree-kill`. The escalation is
  documented as "first kill the parent, let it forward to children" to
  avoid zombie tool children left behind when we tear down a half-
  finished `codex` child.
- **Keeps `exitCode` authoritative**: settled exactly once via the
  `child.on('close', …)` event, even when the spawn fails (ENOENT
  surfaces as `code: 1`, `signal: null`).
- **JSON-RPC client** (`jsonRpc.ts`): a thin line-delimited JSON-RPC 2.0
  client over the handle's `stdin` / `stdout`. Provides
  `request<TResult>` / `notify` / `onNotification` / `dispose`.
  Notification handlers run synchronously per frame; a throwing handler
  does not break the wire loop. Pending requests reject on transport
  close with a stable "transport closed before X responded" error.
- **Re-entrancy contract**: `request()` is not safe from inside a
  notification handler on the same tick — defer with `queueMicrotask`
  if nesting is needed.

The seam is exported from `compat/subprocess/index.ts`. Tree-only
additions; no other code in `utils/` references it yet except the
codex provider.

### 2. Subagent provider registry (`compat/subagents/registry.ts`)

A minimum-viable Map-backed registry implementing
`SubagentProvider` / `SubagentRun` / `SubagentResult` / `SubagentEvent`.
Provider capability metadata is currently `{ noStartCapabilities: }`
data-only; a future PR may widen it to deepseek-harness's
`SubagentCapabilities` (`outputSchema` / `depthLimit` / `toolFilter` /
`persona`) once fork and teammates migrate.

Why not the deepseek shape now: zai's existing path has deep invariants
(`useExactTools`, `buildForkedMessages`, `permissionMode: 'bubble'`),
and introducing a full capability seam in one PR risks regressing
them. Two-step delivery keeps each PR scoped.

### 3. `SubagentProvider` integration in `AgentTool.tsx`

After `effectiveType` is resolved (line ~470), a one-block check before
the existing fork / built-in lookup tries
`getSubagentRegistry().getProvider(effectiveType)`. If matched, the
provider path runs and returns the result via the existing
`{ data: Output }` cast — output schema is unchanged for the model, so
existing tools / SSE renderers don't have to update.

The provider path is wired through `subagentProviderBridge.ts`, which:

- Streams `SubagentEvent`s via `mirrorAttachTaskToBg` /
  `mirrorAppendBgEvent` so the SSE drawer sees the same shape it does
  for fork-derived agents.
- Forwards the caller's `AbortSignal` to the provider's `run.cancel()`.
- Maps `SubagentStopReason` to the bridge's tool result: `completed` →
  `text` returned; `error` / `aborted` / `max-tokens` →
  `text: ''` + `errorMessage: <string>` (consumed by AgentTool's
  `finalizeAgentTool`).
- Casts the provider output through `as unknown as { data: Output }`
  so a real schema variant can land in a follow-up PR without
  expanding the model-facing surface in one shot.

### 4. Codex provider (`compat/subagents/codex/`)

The product package itself. Implementation pieces:

| File | Role |
|---|---|
| `wire.ts` | JSON-RPC method/notification constants + minimal types for `initialize`, `thread/start`, `turn/start`, `turn/completed`, `agentMessage`, approvals. The `turn/completed` notification name uses slash-form per Codex 0.149.0; `agentMessage` event `type` is camelCase. |
| `invariant.ts` | `CODEX_PROTOCOL_VERSION = '0.149.0'` pin, `MAX_AGENT_MESSAGE_BYTES` cap, `failCodex`, `isAcceptableProtocolVersion`. |
| `approvals.ts` | Unattended policy: prefer `cancel` when offered, fall back to `decline`; `userInputRequest` → empty answers; `mcpElicitationRequest` → decline. Unknown methods → fail-closed. |
| `result.ts` | `resolveFinalAnswer(events)`: latest `agentMessage` with `phase: 'final_answer'` wins, fallback to latest `phase: null`. Blank → `error`. Maps Codex `turn/completed.status` → `SubagentStopReason` (`success` → `completed`, `error` + `codexErrorInfo: 'contextWindowExceeded'` → `max-tokens`, `error` / `interrupted` → `error`). |
| `config.ts` | zod schema `{ enabled, command, args, env, disposeGraceMs }`. Defaults: `enabled: false`, `command: 'codex'`, `args: ['app-server', '--stdio']`, `disposeGraceMs: 3000`. `disposeGraceMs` validated ≤ `MAX_TIMER_DELAY_MS`. |
| `run.ts` | Lifecycle: spawn → JSON-RPC handshake → `initialize / initialized` → `thread/start { cwd, ephemeral: true }` → `turn/start` → forward notifications → settle on `turn/completed` (or abort). Returns a `SubagentRun` whose `cancel()` does `handle.killTree()` to clear the bootstrap's barrier loop. |
| `index.ts` | `CodexProvider implements SubagentProvider { name: 'codex', inheritsParentContext: false, capabilities: { noStartCapabilities: true } }`. `apply(registry, config?)` registers it. |

### 5. Tool mount

`enabled: true` in deployment config (settings.json) is the gate; the
provider is *registered* regardless, but only an explicit
`subagent_type: 'codex'` on `AgentTool` invokes it. Mounting
`subagent_codex` as a model-facing tool description is a follow-up
once we have a tool-description authoring pattern that survives the
schema-versioning impact (see Risks).

## Ownership

| Phase | Owner |
|---|---|
| Provider lifecycle | `packages/zn-agent-core/src/opencc-src/compat/subagents/codex/run.ts` |
| Approval routing | `packages/zn-agent-core/src/opencc-src/compat/subagents/codex/approvals.ts` |
| Result settlement | `packages/zn-agent-core/src/opencc-src/compat/subagents/codex/result.ts` |
| Wire vocabulary | `packages/zn-agent-core/src/opencc-src/compat/subagents/codex/wire.ts` |
| Subagent registry / surface | `packages/zn-agent-core/src/opencc-src/compat/subagents/registry.ts` |
| Bridge to AgentTool | `packages/zn-agent-core/src/opencc-src/tools/AgentTool/subagentProviderBridge.ts` |
| Subprocess env scrub / process tree | `packages/zn-agent-core/src/opencc-src/compat/subprocess/{env,spawn,jsonRpc,types,timeouts}.ts` |
| Deployment config schema | `packages/zn-agent-core/src/opencc-src/compat/subagents/codex/config.ts` |
| AgentTool call-site insert | `packages/zn-agent-core/src/opencc-src/tools/AgentTool/AgentTool.tsx` (after line ~470, before `effectiveType` resolution completes) |

## Capabilities and Surface

| Surface | Today | After this PR |
|---|---|---|
| `AgentTool(subagent_type: 'codex')` | throws "Agent type 'codex' not found" | returns the final Codex answer as a normal `status: completed` tool result |
| Subagent SSE drawer | n/a | receives `assistant_message` / `commentary` events for the duration of the run |
| Tree-kill | n/a | provided by the seam (grace via `disposeGraceMs`) |
| Credentials in env | n/a (no spawn) | scrubbed automatically; `OPENAI_API_KEY` comes via explicit `config.env` only |
| Background execution | n/a | disabled (foreground-only, matching `dsh-subagent-codex`) |
| Multi-turn follow-up | n/a | not prebuilt (one-shot only) |

## Test tiers (delivered in this PR)

### Tier 1 — keyless loopback product spec

`test/unit/subagents/codex/run.test.ts` plus the
`test/fixtures/codex-mock/index.mjs` mock binary. The mock is a Node
script that speaks Codex 0.149.0 JSON-RPC over stdio and answers
`initialize`, `thread/start`, `turn/start`, `agentMessage` +
`turn/completed`. Test toggles via env vars (`MOCK_NONCE` for byte-
equal result comparison, `MOCK_FAIL_TURN` for forced-failure paths,
`MOCK_REQUEST_APPROVAL` for unattended-approval paths,
`MOCK_EMIT_COMMENTARY` for the "commentary never replaces answer" path,
`MOCK_DELAY_MS` for the cancellation timing test).

### Tier 2 — unit tests

- `test/unit/subprocess/{env,spawn,jsonRpc}.test.ts`
- `test/unit/subagents/registry.test.ts`
- `test/unit/subagents/codex/{codex,result}.test.ts`

### Tier 3 — credentialed e2e (placeholder)

`test/integration/subagents/codex.e2e.test.ts` is a placeholder that
calls `it.skip()` when `OPENAI_API_KEY ?? DEEPSEEK_API_KEY` are
absent, and otherwise runs the real `codex app-server --stdio` against
a loopback model fixture analogous to deepseek's Responses-SSE bridge.

## Risks & Callouts

- **App-server protocol drift**: `0.149.0` pinned in `invariant.ts`.
  Bumping requires a keyless-fixture test pass + a manifest update.
- **`capabilities: { noStartCapabilities: true }` is the placeholder
  shape**: the deepseek-style `SubagentCapabilities` is a follow-up.
  Adding `fork` migration in the same PR risks regressing the cache-
  identical prefix; defer.
- **Tree-kill ordering**: `disposeCodexChild()` must SIGTERM the parent
  before SIGKILL so its tool children die with it. The escalation in
  `spawn.ts:runKillTree` mirrors this exactly.
- **Output shape carries `stopReason` from SubagentStopReason, not from
  a `subagent_type: 'codex'` schema variant**: the bridge deliberately
  reuses the existing `status: 'completed'` schema and casts the rest,
  keeping the model-facing surface unchanged.
- **Bridge lives in AgentTool's tree (not in `compat/subagents/`)**: it
  depends on `mirrorAttachTaskToBg` / `mirrorAppendBgEvent` / etc.
  which are AgentTool-side. Future codex tools can re-use the bridge
  via the same import.
- **No tool-schema variant yet**: the long-term plan is to add
  `provider: { name, result }` to `Output` so the model sees a hint
  when the task was delegated to a non-fork subagent. Out of scope for
  this PR — adding it requires `zod`-discriminated-union plumbing.

## Out of scope (deferred)

- Migrating fork / teammate / GENERAL_PURPOSE / EXPLORE / PLAN to
  providers
- Deepseek-style `SubagentCapabilities { outputSchema, depthLimit,
  toolFilter, persona }` capability seam
- Mounting `subagent_codex` as a model-visible tool description (rather
  than only `subagent_type: 'codex'`)
- A real DeepSeek Responses-SSE bridge in `services/api/codexShim.ts`
  for credentialed e2e tests against a non-OpenAI base URL
- Foreground prompt caching protection around `thread/start`
  (cache safety in the Codex 0.149.0 protocol is a per-version
  contract; pinning 0.149.0 keeps it tractable)
