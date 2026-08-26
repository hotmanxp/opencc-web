# Plan — Codex subagent provider for zai

Implements `docs/superpowers/specs/2026-08-21-zai-subagent-codex-provider-design.md`.

## Phase A — Foundation

### A1. Subprocess seam (`packages/zn-agent-core/src/opencc-src/compat/subprocess/`)

Create:

- `types.ts` — `SubprocessHandle { pid, stdin, stdout, stderr, exitCode, killTree }`, `SpawnSubprocessRequest`
- `timeouts.ts` — `MAX_TIMER_DELAY_MS = 2_147_483_647`, `DISPOSE_GRACE_MS_DEFAULT = 3000`
- `env.ts` — `getChildEnv(overlay?)` scrubbed env composition; `STRIPPED_ENV_VARS` for ops/tests
- `spawn.ts` — `spawnSubprocess(req)`: pipe-stdio spawn, scrubbed env, `tree-kill` escalation, AbortSignal handling, idempotent `killTree()`, ENOENT as `code: 1`
- `jsonRpc.ts` — `JsonRpcClient`: line-delimited JSON-RPC 2.0 over `stdin` / `stdout`; `request` / `notify` / `onNotification` / `dispose`; pending requests reject on transport close
- `index.ts` — barrel

Reuse:
- Strip list mirrors `packages/zn-agent-core/src/opencc-src/compat/subprocessEnv.ts:15-53` (`GHA_SUBPROCESS_SCRUB`) and adds the OpenAI family. Both lists grow together.
- Windows argv `.cmd` shim handling mirrors `packages/zai/src/server/services/spawner.ts:49-53` (`resolveSpawnCommand`); duplicated rather than imported because zai server is a separate workspace.
- Tree-kill pattern: `packages/zn-agent-core/src/opencc-src/compat/ShellCommand.ts:4, 409`.

Verify:
```bash
pnpm --filter @zn-ai/zn-agent-core test test/unit/subprocess/
pnpm run build:core
```

### A2. Subagent registry (`packages/zn-agent-core/src/opencc-src/compat/subagents/`)

Create:

- `registry.ts` — `SubagentProvider`, `SubagentRequest`, `SubagentContext`, `SubagentRun`, `SubagentResult`, `SubagentEvent`, `SubagentStopReason`, `SubagentError`, `SubagentRegistry` (Map-backed), `getSubagentRegistry()`.
- `index.ts` — barrel.

Verify:
```bash
pnpm --filter @zn-ai/zn-agent-core test test/unit/subagents/registry.test.ts
```

### A3. AgentTool call-site insert

Modify `packages/zn-agent-core/src/opencc-src/tools/AgentTool/AgentTool.tsx`:

- Add `import { runSubagentProvider } from './subagentProviderBridge.js'`
- Add `import { getSubagentRegistry } from '../../compat/subagents/registry.js'`
- After `effectiveType` is resolved (line ~470) and BEFORE the `isForkPath` / built-in lookup, insert:
  - `const subagentProvider = effectiveType && getSubagentRegistry().getProvider(effectiveType)`
  - If matched, call `runSubagentProvider(...)` and return its output cast through `{ data: Output }`.

Create `packages/zn-agent-core/src/opencc-src/tools/AgentTool/subagentProviderBridge.ts`:

- `runSubagentProvider({ provider, request, ... }): Promise<SubagentProviderOutput>` — drives `getSubagentRegistry().startProvider(...)`, attaches to bg, pumps events through `mirrorAppendBgEvent`, forwards cancellation, settles result per `SubagentStopReason`.
- Maps `SubagentEvent.type` → bg event kind (`agentMessage` → `assistant_message`, etc.).

Verify:
```bash
pnpm --filter @zn-ai/zn-agent-core test test/unit/tools/ValidateMainAgentTool.test.ts
pnpm run build:core
```

## Phase B — Codex provider package

Create `packages/zn-agent-core/src/opencc-src/compat/subagents/codex/`:

- `wire.ts` — JSON-RPC constants (`CODEX_METHOD`, `CODEX_NOTIFICATION`); minimal types for `initialize`, `thread/start`, `turn/start`, `turn/completed`, `agentMessage`, approvals.
- `invariant.ts` — `CODEX_PROTOCOL_VERSION = '0.149.0'` pin, `MAX_AGENT_MESSAGE_BYTES`, `failCodex`, `isAcceptableProtocolVersion`.
- `approvals.ts` — `pickApprovalDecision(offered?)`: prefer `cancel`, fall back to `decline`. `registerApprovalHandlers(rpc)` wires the unattended policy. `isUnattendedImpossible(method)` is the fail-closed gate.
- `result.ts` — `resolveFinalAnswer(events)`: latest `agentMessage` with `phase: 'final_answer'` wins, fallback to `phase: null`, blank → error. `stopReasonFromTurnTerminal(terminal)` maps Codex status → `SubagentStopReason`.
- `run.ts` — `startCodexRun(req, ctx, spec)`: spawn → JSON-RPC handshake → `initialize / initialized` → `thread/start { cwd, ephemeral: true }` → `turn/start` → forward notifications → settle on `turn/completed`. `cancel()` does `handle.killTree()` to clear bootstrap's `waitForRunClose` barrier.
- `config.ts` — `codexConfigSchema` (zod): `{ enabled, command, args, env, disposeGraceMs }`. `parseCodexConfig` / `safeParseCodexConfig` helpers.
- `index.ts` — `CodexProvider implements SubagentProvider { name: 'codex', inheritsParentContext: false, capabilities: { noStartCapabilities: true } }`. `apply(registry, config?)` registers it. Re-export public surface.

Reuse:
- `JsonRpcClient` / `spawnSubprocess` from Phase A1 (no fork, no new deps).
- Result mapping mirrors `packages/subagent/subagent-codex/src/run.ts` and `src/wire.ts` in deepseek-harness verbatim — only the protocol surface differs at a few slash-vs-camel boundaries.

Verify:
```bash
pnpm --filter @zn-ai/zn-agent-core test test/unit/subagents/codex/
pnpm run build:core
```

## Phase C — Tests

### C1. Subprocess seam unit tests

`packages/zn-agent-core/test/unit/subprocess/{spawn,env,jsonRpc}.test.ts`:

- `spawn.test.ts` — real Node child processes; verifies pid, exitCode, stdout capture, AbortSignal-triggered `killTree`, idempotent kill, env overlay.
- `env.test.ts` — strip list behavior, overlay priority, fresh object per call, ambient vs overlay precedence.
- `jsonRpc.test.ts` — id-matched response routing, server-side error frames, notification dispatch, monotonic ids, transport close rejection, malformed frame tolerance, notify() without id, throw-inside-handler doesn't break the wire.

### C2. Registry tests

`packages/zn-agent-core/test/unit/subagents/registry.test.ts`:

- registerProvider persists; duplicate-name throws SubagentError; disposer is idempotent; insertion-order list; startProvider forwards request + context; unknown name throws `PROVIDER_NOT_FOUND`.

### C3. Codex unit tests

- `test/unit/subagents/codex/result.test.ts` — `resolveFinalAnswer` rules (final_answer wins, fallback to phase:null, commentary ignored, blank → error, no events → error), `stopReasonFromTurnTerminal` mapping (success, contextWindowExceeded → max-tokens, error, error-no-message default, interrupted).
- `test/unit/subagents/codex/codex.test.ts` — `pickApprovalDecision` rules, `isUnattendedImpossible` policy, registration smoke.

### C4. Codex keyless loopback spec

- `test/unit/subagents/codex/run.test.ts` — drives `startCodexRun` against `test/fixtures/codex-mock/index.mjs` (the mock binary).
- The mock is a Node script with `MOCK_NONCE`, `MOCK_FAIL_TURN`, `MOCK_REQUEST_APPROVAL`, `MOCK_EMIT_COMMENTARY`, `MOCK_DELAY_MS` env toggles.
- Tests assert: byte-equal final answer; commentary events don't replace the answer; approval `cancel` answered without hanging; failed turn → `error` with upstream errorMessage; empty prompt rejected pre-spawn; no-cwd rejected pre-spawn; cancel → `aborted` result, OS process tree killed.

### C5. Credentialed e2e (placeholder)

`packages/zn-agent-core/test/integration/subagents/codex.e2e.test.ts`:

- Guards on `process.env.OPENAI_API_KEY ?? process.env.DEEPSEEK_API_KEY`.
- When keys absent: `it.skip(...)` with a console log.
- When keys present: real `codex app-server --stdio`, real API call, byte-equal nonce response, whole-tree exit.

Verify:
```bash
pnpm --filter @zn-ai/zn-agent-core test \
  test/unit/subprocess/ \
  test/unit/subagents/ \
  test/unit/tools/ValidateMainAgentTool.test.ts
```

## Phase D — Spec & Plan Docs

- `docs/superpowers/specs/2026-08-21-zai-subagent-codex-provider-design.md` — written.
- `docs/superpowers/plans/2026-08-21-zai-subagent-codex-provider.md` — this file.

## Phase E — Real-browser verification

Per AGENTS.md §"真实浏览器验收" — required for any core change. The
provider ships as `enabled: false` by default; verification requires
either an enabled config in `~/.zai/settings.json` or a one-shot
override.

```bash
pnpm run build:core
# Avoid 920x — the dev port block.
pnpm --filter @zn-ai/zai dev -- --port 8102 --api-port 7715
```

`/ego-browser` flow:
1. Navigate to `http://localhost:8102/agent`.
2. Prompt the model with "Use subagent_codex via the Agent tool with `subagent_type='codex'` to summarize the current directory's package.json files".
3. Verify the transcript contains: `Agent` tool call with `subagent_type: 'codex'`, an `assistant_message` event stream from the codex sub-run, and a final `status: completed` tool result with the summary.
4. `lsof -i :8102` — confirm dev.
5. `ps aux | grep 'codex app-server' | grep -v grep` — confirm app-server spawned and exited.
6. Repeat at `/m` for the mobile drawer rendering path.
7. Set `enabled: false` in settings.json, rebuild, confirm `subagent_codex` no longer appears in any tool panel.

Verification artifacts: build:core OK, all 64 tests in scope pass.

## Risks & Callouts

- `capabilities: { noStartCapabilities: true }` is a placeholder — widening to deepseek-style `SubagentCapabilities` is a follow-up PR.
- The bridge casts through `as unknown as { data: Output }` rather than introducing a new schema variant — keeping the model-facing surface unchanged for this PR.
- `MOCK_FAIL_TURN` env propagation in `startCodexRun` was the trickiest fixture detail: the config-owned `env` (not `request.env`) is what the seam sees, mirroring deepseek's deployment-owned env contract.
- `CODEX_NOTIFICATION.turnCompleted = 'turn/completed'` (slash-form, not camelCase) — matches upstream 0.149.0 wire spec.

## Out of scope (explicit)

- Fork / teammate / built-in migration to providers.
- Deepseek-style `SubagentCapabilities`.
- Mounting `subagent_codex` as a model-visible tool description (rather than only `subagent_type: 'codex'`).
- Background execution (deepseek's design and ours: foreground-only).
- Multi-turn follow-up / continuable children.
- A real DeepSeek Responses-SSE bridge for credentialed e2e in environments without OpenAI access.
