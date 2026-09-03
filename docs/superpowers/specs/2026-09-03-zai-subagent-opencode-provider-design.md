# Spec — zai opencode subagent provider

**Status**: implemented (task-factory `tf-bq4lhhhe`, 2026-09-03)
**Code**: `packages/zn-agent-core/src/compat/subagents/opencode/`

## Problem

SpawnAgent routes `subagent_type` to registered `SubagentProvider`s
(`compat/subagents/registry.ts`). Today the registry carries `opencc`,
`dsh`, `claude-code` and `codex`. The natural third-party addition is
SST's `opencode` CLI (`opencode-ai`), already installable via pnpm
global and self-authenticated through its own credential store.

Without an `opencode` provider the model cannot delegate a one-shot
task to a fresh opencode session; all opencode usage stays outside
the zai task timeline (no SSE events, no bg-task mirror, no
`<task-notification>` on completion).

## Smoke verification (2026-09-03, opencode 1.3.13, macOS arm64)

Headless feasibility was verified before writing this spec:

- `opencode run --format json "<prompt>"` completes in ~9 s for a tiny
  prompt and emits **newline-delimited JSON events** on stdout:
  `step_start`, `text`, `step_finish` (observed types; see mapping
  below). Every frame carries `sessionID` (`ses_...`), `timestamp`,
  and a `part` object.
- `step_finish` carries the terminal facts: `reason` (`"stop"`),
  `tokens` (`input/output/reasoning/cache`), `cost`.
- Missing credentials make `run` **hang silently with zero output**
  (no error exit). With credentials configured the same command
  succeeds. Detection must therefore pre-flight auth, not rely on
  early stderr.
- Default model resolved to the configured provider (`minimax-cn /
  MiniMax-M3`) with no `-m` flag; `-m provider/model` overrides.

## Decision

Add a sibling provider implementing the same `SubagentProvider`
interface as codex / claude-code. One-shot spawn of
`opencode run --format json` in the requested cwd; stream stdout
line-by-line; map JSON frames to `SubagentEvent`; resolve
`SubagentResult` on `step_finish` + process exit.

### CLI capability mapping

| SubagentRequest/Context field | opencode flag | Notes |
|---|---|---|
| `prompt` | positional message | pass as single argv entry |
| `cwd` / `ctx.parentCwd` | child process `cwd` | set on `spawnSubprocess` (not a `--dir` flag) so the child resolves relative paths against the delegating session dir |
| `model` | `-m provider/model` | ignore when `undefined` (CLI default wins) |
| `signal` | kill process tree | same `killTree()` pattern as claude-code |
| follow-up steering | `--session <ses_...>` | v1 stores the `sessionID` from terminal frames for `sendMessage` continuation; live steering mid-run is out of scope |

A `--attach http://host:port` server mode exists upstream; v1 does
not use it (fresh-process isolation is the provider contract).

### Event mapping (`--format json` → SubagentEvent)

| opencode frame | SubagentEvent | Rationale |
|---|---|---|
| `text` (part.type `text`) | `{ type: 'text', text: part.text, raw: frame }` | Final/answer text arrives complete in one frame (no partial deltas observed at 1.3.13); duplicates over the same `part.id` are deduped by `part.id` + `time.end`. |
| `step_start` / `step_finish` | `{ type: 'step_start' \| 'step_finish', raw: frame }` | `step_finish` additionally settles `result`: `stopReason: 'completed'` when `reason === 'stop'`, text accumulated from `text` frames. |
| other frame types (tool/part lifecycle beyond the three above) | `{ type: frame.type, raw: frame }` | Unknown types pass through with `raw` fidelity; the bridge mirrors them into the SSE timeline. |
| non-JSON stdout line | `{ type: 'log', text: line }` | Defensive; should not happen with `--format json`. |

Terminal contract: process exit ≠ 0 without a `step_finish`, or a
fatal stderr signature → `stopReason: 'error'` with the stderr tail
as `errorMessage` (never reject, per `SubagentRun.result` contract).

### Capabilities

- `inheritsParentContext: false` (fresh session, like codex/claude-code).
- `capabilities.agentOptions: false` initially → no `agentRouteDefaults`
  (static route is provider-config-driven inside opencode itself).
- Provider name: `'opencode'`.

## Implementation touchpoints (hardcoded provider lists to update)

The tool `description()` enumerates registered providers dynamically,
but these static sites still gate/word opencode out and must change
with the implementation:

1. `packages/zn-agent-core/src/compat/tools/opencc/SpawnAgentTool.ts`
   — `subagent_type` zod `describe()` example (`\`opencc\` / \`dsh\``),
   header comments (~L32/L42), the `as 'opencc' | 'dsh'` assertion
   (~L168), and the unknown-provider fallback wording (~L155).
2. `packages/zai/src/server/routes/superTasks.ts` — `SPAWN_AGENT_NAMES`
   whitelist (L50) and the spawn-agents route comments (“opencc / dsh
   两个”, L146/L182–186).
3. `packages/zai/src/web/src/lib/superTaskApi.ts` —
   `preferSpawnAgent: 'opencc' | 'dsh' | null` union (L126).
4. `packages/zai/src/web/src/components/superTasks/FactorySettingsDrawer.tsx`
   — same union (L35) and user-facing copy “注册 opencc / dsh …” (L278).
5. Stale comments to correct in passing: `subagentProviderBridge.ts`
   (`'codex' today`, ~L35) and `registry.ts` `SubagentEvent` examples
   (~L49–54).
6. Frontend spawn-agent detection/registration UI must learn the
   `opencode` command probe (binary name `opencode`, pnpm-global PATH).

## Known risks

- **Auth-hang**: unauthenticated opencode hangs with no output — the
  provider needs a startup watchdog (no JSON frame within N s →
  surface as error suggesting `opencode auth login`), and the
  factory-settings “registered/active” probe should treat
  `opencode auth list` emptiness as not-ready.
- **`--print-logs` floods stdout/stderr** (>1 MB on a trivial run at
  INFO). Do not pass it by default; keep stderr only for fatal
  signatures.
- Frame vocabulary beyond the three observed types is unverified
  (tool-call parts in `--format json` were not exercised by the
  smoke). Implementation must smoke a tool-using prompt before
  freezing the mapping table.

## Acceptance

- `/api/super-tasks/spawn-agents` lists `opencode` with
  commandFound/registered/active semantics matching dsh gating.
- SpawnAgent with `subagent_type: 'opencode'` returns
  `async_launched`, streams SSE timeline frames, and delivers a
  `<task-notification>` with the final text on completion.
- Cancellation kills the opencode process tree.
- Real-browser verification via `/ego-browser` per AGENTS.md
  (core touched → `pnpm run build:core` first).
