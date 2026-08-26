# Spec — zai Claude Code subagent provider

**Status**: implemented
**Code**: `packages/zn-agent-core/src/opencc-src/compat/subagents/claude-code/`

## Problem

The codex provider (sibling spec `2026-08-21-zai-subagent-codex-provider-design`)
gave zai a path to delegate a one-shot text task to a fresh Codex CLI
session. The natural next product is the same shape against Anthropic's
`claude` CLI — `claude --print` is already on PATH for most agents,
and the unattended policy has well-bounded semantics (foreground only,
no permission asks, no session persistence).

Without a `claude-code` provider the model still cannot route a task to
a fresh Claude session; the only Claude-backed path is the in-process
HTTP call via `services/api/openaiShim.ts`, which does not satisfy the
sibling-spec requirement that subagent delegation lands in a fresh
process with its own model context.

## Decision

Add a sibling provider under the same `SubagentProvider` registry used
by codex. Keep the surface small: `claude --print` in the parent cwd,
stream-json output, unattended permission mode by default.

### Protocol surface

`claude --print` is the documented non-interactive entrypoint. It exposes
three output flavors, each mapped to the same `SubagentStopReason`
contract:

| `--output-format` | Wire format | Provider mapping |
|---|---|---|
| `stream-json` (default) | Newline-delimited JSON events | One `SubagentEvent` per line; `assistant` events carry text, `result` carries terminal fact. |
| `json` | Single JSON object on stdout: `{type:'result', result, is_error, error?, usage?}` | One `SubagentEvent` of type `json_result`. |
| `text` | Plain text per line | One `SubagentEvent` of type `assistant` per line. |

The provider prefers `stream-json` because it preserves the per-event
shape the bridge layer already mirrors (assistant_message / tool_use /
tool_result / system). `json` is the tier-2 fallback when the
deployment wants a single frame with no streaming.

### Permission model

Four modes exposed by `claude --permission-mode`:
- `bypassPermissions` (default for unattended runs)
- `acceptEdits`
- `plan`
- `default`

The provider always passes the configured `permissionMode` through;
no UI is offered, so any mode that requires human judgment
(`acceptEdits` with prompt-after-tool, etc.) is the deployment's
responsibility. The schema rejects exotic values via `z.enum`.

### Lifecycle

Mirrors `dsh-subagent-codex`'s `startClaudeCodeRun` shape (per deepseek
Agent Note §"Claude Code provider"):

1. `spawnSubprocess` with the configured `command` / `args` / `cwd`,
   `env` overlay from config + per-call request.
2. Read stdout line-by-line. For `stream-json`, each line is JSON;
   for `json`, the whole stdout is buffered then parsed on close;
   for `text`, each line is `text`.
3. The canonical terminal is the `result` event (stream-json / text)
   or the single-frame parsed JSON (json). Its `is_error: true`
   surfaces as `stopReason: 'error'`.
4. `cancel()` does `handle.killTree()` so the parent process and any
   tool subprocesses (claude's MCP / agent invocations) die together.
5. The provider advertises `inheritsParentContext: false` and
   `capabilities: { noStartCapabilities: true }` — child tools,
   persona, depth policy, and structured output are NOT configurable
   here. Per-call `request.env` overlays `config.env` (last write wins)
   before the seam scrubs credential-shaped ambient vars.

### Config surface

```ts
{
  enabled: boolean,            // default false
  command: string,             // default 'claude'
  args: string[],              // default ['--print', '--output-format', 'stream-json']
  outputFormat: 'json' | 'stream-json' | 'text',
                              // default 'stream-json'
  permissionMode: 'bypassPermissions' | 'acceptEdits' | 'plan' | 'default',
                              // default 'bypassPermissions'
  env: Record<string, string>,
  disposeGraceMs: number,      // default 3000, ≤ MAX_TIMER_DELAY_MS
}
```

## Ownership

| Phase | Owner |
|---|---|
| Provider lifecycle | `packages/zn-agent-core/src/opencc-src/compat/subagents/claude-code/run.ts` |
| Result settlement | `packages/zn-agent-core/src/opencc-src/compat/subagents/claude-code/result.ts` |
| Wire vocabulary | `packages/zn-agent-core/src/opencc-src/compat/subagents/claude-code/wire.ts` |
| Deployment config schema | `packages/zn-agent-core/src/opencc-src/compat/subagents/claude-code/config.ts` |
| Provider class + apply | `packages/zn-agent-core/src/opencc-src/compat/subagents/claude-code/index.ts` |
| Bridge to AgentTool | `packages/zn-agent-core/src/opencc-src/tools/AgentTool/subagentProviderBridge.ts` (shared with codex) |
| Subprocess env scrub / process tree | `packages/zn-agent-core/src/opencc-src/compat/subprocess/{env,spawn,jsonRpc,types,timeouts}.ts` (shared) |
| agentRuntime boot wiring | `packages/zai/src/server/services/agentRuntime.ts` |

## Capabilities and Surface

| Surface | Today | After this PR |
|---|---|---|
| `AgentTool(subagent_type: 'claude-code')` | throws "Agent type 'claude-code' not found" | returns the final `claude --print` text via the existing `status: completed` result |
| Subagent SSE drawer | n/a | receives `assistant` / `tool_use` / `tool_result` events for the duration of the run |
| Tree-kill on dispose | n/a | covered by the shared subprocess seam (SIGTERM → grace → SIGKILL via `tree-kill`) |
| Foreground / background | n/a | foreground-only (matches `codex` provider; no `enableRunInBackground`) |

## Tests

`packages/zn-agent-core/test/unit/subagents/claude-code/`:

- `config.test.ts` (placeholder) — schema validation, defaults, error
  envelope when `disposeGraceMs` exceeds `MAX_TIMER_DELAY_MS`.
- `claude-code.test.ts` (placeholder) — add when the surface grows past
  the schema. Currently nothing here that isn't covered by `run.test.ts`.
- `run.test.ts` (keyless spec) — drives `startClaudeCodeRun` against
  `test/fixtures/claude-mock/index.mjs`. The mock is a Node script
  that mimics `claude --print` with `stream-json` / `json` / `text`
  output flavor, and emits the canonical `result` terminal. Toggles:
  `MOCK_NONCE`, `MOCK_OUTPUT`, `MOCK_FAIL`, `MOCK_DELAY_MS`.

Tests cover: byte-equal final text, json flavor single-frame, failed
result → error, empty prompt / no-cwd rejection, cancellation →
aborted with the OS tree killed.

## Risks & Callouts

- **`@anthropic-ai/claude-agent-sdk` not used**: deepseek's path is to
  pull the SDK as a dependency. zai instead spawns `claude --print`
  directly via the same subprocess seam the codex provider uses.
  Rationale: keeps the seam consistent (one spawn pipeline, one tree-
  kill), avoids adding a 2.5MB dependency for one entrypoint, and
  gives us the same observability surface as codex for the bridge.
  Trade-off: no streaming-token accounting via SDK; we read raw
  stream-json frames.
- **`claude --print` argv ordering is sensitive**: prompt must be the
  LAST positional argument (we use `--` to gate the separator).
  `claudeSpawnArgv` enforces this; do not pass `--` as an `extraArg`.
- **Single-frame JSON mode is simpler than stream-json**: it tells us
  the answer is one read away. Used when the deployment wants
  terminal-only emission (cheaper for non-bridge consumers).
- **No Claude-Code-specific `permissionMode` value yet**: upstream
  may grow more modes. Track them through the existing `z.enum` and a
  follow-up PR.
- **Mock fixture vs real `claude`**: the mock at
  `test/fixtures/claude-mock/index.mjs` only emits the events the
  provider's resolution path depends on. Real Claude may emit
  addtional `system` / `tool_use` / `tool_result` types — the
  provider treats unknown `type` values as opaque `SubagentEvent` and
  does not collapse them into the answer.
- **Default `permissionMode: bypassPermissions`**: matches the
  codex provider's unattended-policy contract. The deployment can
  override to `acceptEdits` for a stricter unattended run; the
  bridge's `--permission-mode` arg is forwarded verbatim.

## Out of scope (deferred)

- Wiring `claude-code` as a model-visible tool description (currently
  only `subagent_type: 'claude-code'` works). Schema migration is a
  follow-up PR.
- Adding more `permissionMode` values as the CLI grows new ones.
- A real-Claude credentialed e2e (placeholder at
  `test/integration/subagents/codex.e2e.test.ts` already documents
  the prerequisite bridge pattern that would apply here too).
- A unified bridge that handles both codex and claude-code provider
  events with a single `assistant_message` / `tool_use` mapping
  (current bridge does this generically; subsequent PRs may want
  per-provider overrides).
