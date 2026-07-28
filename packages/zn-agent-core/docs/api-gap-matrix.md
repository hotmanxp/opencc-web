# API Gap Matrix: zai-agent-core → zn-agent-core (from opencc)

## How to Read This Document

- **Direct re-exports**: opencc already has the symbol at the listed path; zero code change needed (just re-export).
- **Shim needed**: zai-specific implementation required; see the "Shim layer files to create" section for the exact file to write.
- **MISSING**: No equivalent found in opencc; implement from scratch or adapt from zai's existing implementation.
- **Ambiguity**: Multiple opencc candidates exist; best guess recorded with a TODO for verification.

---

## Direct Re-exports (zero code change)

| zai subpath | zai export | opencc source | Notes |
|---|---|---|---|
| (main) | `EXTERNAL_PERMISSION_MODES` | `src/types/permissions.ts:EXTERNAL_PERMISSION_MODES` | Identical const array |
| (main) | `PERMISSION_MODES` | `src/types/permissions.ts:PERMISSION_MODES` | Re-export; opencc uses `INTERNAL_PERMISSION_MODES` internally |
| `./runtime` | `PermissionMode` | `src/types/permissions.ts:PermissionMode` | Same type alias |
| `./runtime` | `EXTERNAL_PERMISSION_MODES` | `src/types/permissions.ts:EXTERNAL_PERMISSION_MODES` | Same const |
| `./runtime` | `PERMISSION_MODES` | `src/types/permissions.ts:PERMISSION_MODES` | Same const |
| (main) | `query` (queryLoop) | `src/query.ts` | Core generator exported as `query`; opencc uses `query.ts` |
| `./runtime` | `queryLoop` | `src/query.ts` (aliased) | zai re-exports as `query`; opencc exports `query` as default |
| `./runtime` | `QueryEngine` | `src/QueryEngine.ts` | Same class; opencc signature may differ (zio SDK vs headless) |
| `./runtime` | `abortSession` | `src/query.ts` (internal) | opencc has `createAbortController` + query-level abort; shim needed |
| `./runtime` | `AgentRuntime` / `DefaultAgentRuntime` | `src/query.ts` + `src/QueryEngine.ts` | opencc uses `QueryEngine` instead of AgentRuntime contract |
| (main) | `resolveDataDir` | `src/utils/envUtils.js` (via `getClaudeConfigHomeDir`) | opencc uses `getClaudeConfigHomeDir`; zai has `resolveDataDir` wrapper |
| `./commands` | (slash commands) | `src/commands/index.ts` + `src/commands/**` | opencc `commands.ts` exports `getCommands` + individual command files |
| (main) | `MCPClientPool` | `src/services/mcp/client.ts` | opencc has `client.ts` as main MCP entry; class-based pool is zai addition |
| (main) | `HookRunner` | `src/services/hooks/hookRunner.ts` | opencc has hook runner; exact API shape TBD |
| (main) | `DEFAULT_HOOK_TIMEOUT_MS` | opencc hooks | Named constant exported from hook runner |
| (main) | `PluginRuntime` / `DefaultPluginRuntime` / `PluginRegistry` | `src/utils/plugins/pluginLoader.ts` + `src/plugins/` | opencc plugin system exists; zai has `DefaultPluginRuntime` wrapper |
| (main) | `emptyPluginSnapshot` | `src/plugins/types.ts` or similar | opencc has plugin snapshot types |
| (main) | `resolveOpenccConfigDir` | `src/utils/envUtils.js` | opencc config dir resolution exists |
| (main) | `resolveOpenccPluginsDir` | `src/utils/plugins/pluginLoader.ts` | opencc plugins dir |
| (main) | `resolveZaiPluginsDir` | MISSING | zai-specific; opencc doesn't have this |
| (main) | `createDefaultHookExecutor` | opencc hook system | opencc has hook executor; exact signature TBD |
| (main) | `compactSession` | `src/services/compact/index.ts` or `src/query/compact.ts` | opencc has `compactIfNeeded` / `snipCompactIfNeeded` / `autoCompactIfNeeded`; zai wraps in `compactSession` service |
| `./runtime` | `loadSkillsFromDirs` | `src/utils/skills/skillLoading.ts` | opencc has skill loading; zai `skills/index.ts` exports it |
| `./runtime` | `LoadSkillsOptions` / `LoadedSkill` / `PendingSkillInjection` / `SkillFrontmatter` | opencc skill loading types | opencc has these types in its skill system |
| (main) | `TranscriptStore` | `src/utils/sessionStorage.ts` | opencc has `sessionStorage.ts`; zai has extended v2 with `CompactMetadata` |
| (main) | `repairAndPersistTranscript` | `src/utils/sessionStorage.ts` | opencc has transcript persistence; repair logic may be zai addition |
| (main) | `TranscriptFile` / `TranscriptMessage` / `TranscriptMeta` | opencc session/transcript types | opencc defines these in `src/types/` |
| `./runtime` | `RuntimeEvent` / `RuntimeErrorEvent` / `RuntimeDoneEvent` / `RuntimeAbortedEvent` / `ErrorCategory` | opencc events | opencc has event types in its query runtime |
| `./runtime` | `wrapWithZaiMeta` / `toRuntimeErrorEvent` / `toAbortedEvent` | `src/utils/messages.ts` or similar | zai stream adapter wrapping opencc messages |
| `./runtime` | `CwdStore` | `src/utils/cwd.ts` | opencc has `pwd()` / `getCwd()` / `runWithCwdOverride()`; zai's `CwdStore` is a session-scoped Map wrapper |
| `./runtime` | `runWithSessionId` / `getCurrentSessionId` | `src/utils/cwd.ts` | opencc has `runWithCwdOverride`; zai adds ALS-based sessionId propagation |
| `./runtime` | `StateChangeBus` / `resetStateChangeBusForTests` | opencc event bus | opencc has internal event bus; zai exposes `stateChangeBus` |
| `./runtime` | `StateChangeEventMap` | opencc state types | opencc state change types |
| (main) | `DataDirConfig` | opencc config | opencc config system |
| (main) | `TranscriptRepairReport` / `TranscriptRepairResult` | zai transcript repair | zai-specific; opencc may not have repair logic |
| (main) | `registerProcessOutputErrorHandlers` / `__resetProcessOutputErrorHandlersForTests` | opencc process utils | opencc has `process.on('error')` handling for EPIPE |

---

## zai-only Exports to Re-implement (no upstream equivalent)

| zai export | Notes |
|---|---|
| `UserFacingPermissionMode` | Subset of `ExternalPermissionMode` for UI; likely just `Pick<ExternalPermissionMode, ...>` |
| `setDefaultSandboxManager` / `getDefaultSandboxManager` | Sandbox singleton; opencc has sandbox config but not this singleton accessor pattern |
| `RequestApproveTool` | zai-specific approval-gate tool; opencc has permission prompts but not this exact tool |
| `REQUEST_APPROVE_TOOL_NAME` | String constant for above tool |
| `RequestApproveInput` / `RequestApproveOutput` | Zod schemas for above tool |
| `hasExternalIncludes` | zai memory loader flag for `@include` directive support |
| `MemoryFile` / `MemoryType` | zai memory loader types |
| `startMemoryWatcher` / `stopMemoryWatcher` / `MemoryWatcherHandle` | zai fs.watch wrapper for AGENTS.md reload |
| `clearMemoryCache` | zai memory loader cache invalidation |
| `loadMemoryForPrompt` | zai wraps opencc's `claudemd.ts`; shim should delegate to opencc source |
| `CwdStore` (zai-specific session Map) | opencc has `getCwd()` but not a session-scoped Map store |
| `runWithSessionId` / `getCurrentSessionId` | AsyncLocalStorage wrapper; opencc has `runWithCwdOverride` but not session-scoped ALS |
| `bashBackgroundTracker` | opencc has `src/utils/task/diskOutput.ts` + `ShellCommand`; zai's `BashBackgroundTracker` is a process-level in-memory task registry with LRU eviction |
| `getTaskListStore` / `TaskListStore` | opencc has `src/utils/tasks.ts` with `TaskStatus`; zai's `TaskListStore` is session-isolated JSON-file-backed task list for TodoWrite |
| `TranscriptStore` (zai v2) | opencc `sessionStorage.ts` has different semantics; zai v2 adds `CompactMetadata` support |
| `repairAndPersistTranscript` | zai transcript repair; opencc has `sessionStorage.ts` but not repair logic |
| `TranscriptRepairReport` / `TranscriptRepairResult` | zai repair types |
| `CompactSessionOptions` / `CompactSessionResult` | zai compact service types |
| `CompactMetadata` / `compact_boundary` message type | zai v2 transcript adds compact boundary messages; opencc may not have this |
| `stateChangeBus` | zai SSE bridge internal event bus; opencc has internal bus but different shape |
| `SystemPrompt` / `asSystemPrompt` / `buildSystemPrompt` / `buildEffectiveSystemPrompt` | zai system prompt section registry; opencc has `systemPromptType.ts` with simpler shape |
| `DEFAULT_STATIC_INTRO` / `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` | zai system prompt constants |
| `systemPromptSection` / `DANGEROUS_uncachedSystemPromptSection` | zai system prompt section decorator |
| `clearSystemPromptSections` / `resolveScratchpadDir` / `isScratchpadEnabled` | zai system prompt management |
| `BackgroundRuntime` / `DefaultBackgroundRuntime` | zai background task subsystem; opencc has background tasks but different architecture |
| `TaskEvent` / `JsonTaskStore` / `BackgroundTaskRecord` | zai background task types and persistence |
| `resolveZaiPluginsDir` | zai-specific plugin directory resolver |
| `__resetProcessOutputErrorHandlersForTests` | Test seam for process output error handlers |
| `registerProcessOutputErrorHandlers` | EPIPE guard for stdout/stderr |

---

## Shim Layer Files to Create

```
src/compat/
  permissions.ts               # EXTERNAL_PERMISSION_MODES re-export + UserFacingPermissionMode alias
  permissionMode.ts            # PERMISSION_MODES re-export + PermissionMode re-export
  cwdStore.ts                 # CwdStore singleton (Map<sessionId, SessionCwd>) wrapping opencc pwd/cwd
  runWithSessionId.ts         # AsyncLocalStorage wrapper: runWithSessionId + getCurrentSessionId
  bashTracker.ts              # BashBackgroundTracker singleton (port from zai-agent-core)
  taskListStore.ts            # TaskListStore singleton (port from zai-agent-core)
  sandboxManager.ts           # setDefaultSandboxManager / getDefaultSandboxManager singleton
  requestApproveTool/
    RequestApproveTool.ts     # RequestApproveTool class (port from zai-agent-core)
    prompt.ts                 # REQUEST_APPROVE_TOOL_NAME constant
    schema.ts                 # RequestApproveInput / RequestApproveOutput types
  memory/
    loader.ts                 # loadMemoryForPrompt wrapping opencc's claudemd.ts
    watcher.ts                # startMemoryWatcher + stopMemoryWatcher (fs.watch wrapper, port from zai-agent-core)
  transcript/
    store.ts                  # TranscriptStore v2 (port from zai-agent-core, keep CompactMetadata)
    repair.ts                 # repairAndPersistTranscript + types (port from zai-agent-core)
  compactService.ts           # compactSession + CompactSessionOptions/Result types (wrap opencc autoCompact)
  stateChangeBus.ts           # stateChangeBus singleton (zai-specific SSE bridge bus)
  systemPrompt/
    index.ts                  # buildSystemPrompt / buildEffectiveSystemPrompt wrappers
    sections.ts               # systemPromptSection + clearSystemPromptSections
    constants.ts              # DEFAULT_STATIC_INTRO, SYSTEM_PROMPT_DYNAMIC_BOUNDARY
  background/
    runtime.ts                # DefaultBackgroundRuntime (port from zai-agent-core)
    store/
      jsonStore.ts            # JsonTaskStore (port from zai-agent-core)
    types.ts                  # TaskEvent, BackgroundTaskRecord types
  plugins/
    paths.ts                  # resolveZaiPluginsDir (zai-specific)
    defaultHookExecutor.ts    # createDefaultHookExecutor (wrap opencc hook system)
```

---

## Detailed Mapping Notes

### Permissions

opencc `src/types/permissions.ts` exports:
- `EXTERNAL_PERMISSION_MODES` — identical to zai
- `PermissionMode` = `InternalPermissionMode` — zai re-exports the same
- `PERMISSION_MODES` = `INTERNAL_PERMISSION_MODES` in opencc — identical const

zai adds `UserFacingPermissionMode` as a UI-facing alias. Shim: `export type UserFacingPermissionMode = ExternalPermissionMode`.

### Query / Runtime

opencc `src/query.ts` exports `query` as the main generator function. zai re-exports it as `query` (via `queryLoop` alias).

opencc `src/QueryEngine.ts` is the session-owning class. zai has `DefaultAgentRuntime` wrapping `QueryEngine`. The `AgentRuntime` interface in zai is a contract that maps to opencc's `QueryEngine` usage.

opencc does not have `abortSession` — instead it uses per-query `AbortController`. zai wraps this as `abortSession`. Shim: implement as `abortController.abort()`.

### CwdStore

opencc `src/utils/cwd.ts` has `pwd()` / `getCwd()` / `runWithCwdOverride()`. zai adds:
1. A `CwdStore` singleton (`Map<sessionId, SessionCwd>`) — zai-specific
2. `runWithSessionId` / `getCurrentSessionId` via `AsyncLocalStorage` — layered onto opencc's ALS-based cwd override

Shim: port zai's `cwdStore.ts` (already clean) and the ALS sessionId wrapper.

### bashBackgroundTracker

opencc `src/utils/ShellCommand.ts` has `ShellCommand` interface and `background()` method. opencc `src/utils/task/diskOutput.ts` has `DiskTaskOutput` for output persistence.

zai's `BashBackgroundTracker` is a process-level in-memory registry that:
- Tracks running/completed/failed/killed tasks by `taskId`
- Manages foreground↔background state machine
- Emits `stateChangeBus` events with debouncing
- LRU+TTL eviction for memory control
- `kill()` / `killAllForeground()` methods

opencc has NO equivalent in-memory tracker — it uses `AppState` + `setAppState`. Shim: port zai's `bashTracker.ts` verbatim.

### taskListStore

opencc `src/utils/tasks.ts` has `Task` / `TaskStatus` (different statuses: `pending|running|paused|completed|failed|killed`) and `listTasks()` / `getTask()` / etc.

zai's `TaskListStore` is for **TodoWrite-style task lists** managed by the LLM, NOT the same as opencc's background task system. It:
- Is session-isolated (one JSON file per `sessionId`)
- Has `create` / `list` / `get` / `update` methods
- Auto-cleans when all tasks reach terminal state

opencc has no equivalent. Shim: port zai's `TaskListStore.ts` verbatim.

### memoryLoader

opencc `src/utils/claudemd.ts` has memory file scanning + `@include` processing. zai's `loadMemoryForPrompt` wraps this with:
- Per-cwd module-level cache (`clearMemoryCache()`)
- `MemoryFile` / `MemoryType` types
- `MAX_INCLUDE_DEPTH = 5`

Shim: port zai's `loader.ts` but import from `../opencc-src/utils/claudemd.js`.

### memoryWatcher

opencc has no memory file watcher. zai uses `fs.watchFile` polling (1s interval). Shim: port zai's `watcher.ts` verbatim.

### transcript/store

opencc `src/utils/sessionStorage.ts` has `Session` / `saveSession` / `loadSession` — but these are for opencc's session persistence, not zai's v2 transcript.

zai's `TranscriptStore` v2 adds:
- `CompactMetadata` / `compact_boundary` message type
- Per-session JSON file storage with `lock` for atomic writes
- `repairAndPersistTranscript` for corrupted transcript repair
- `TranscriptRepairReport` / `TranscriptRepairResult` types

Shim: port zai's transcript store + repair logic verbatim.

### MCP

opencc `src/services/mcp/client.ts` has the MCP client pool. zai re-exports it as `MCPClientPool`. Direct re-export should work.

### Hooks

opencc has hook execution in `src/services/hooks/hookRunner.ts` (or similar). zai exports `HookRunner`, `DEFAULT_HOOK_TIMEOUT_MS`, `createDefaultHookExecutor`. The exact opencc hook runner API needs verification — if shape matches, direct re-export; if not, shim.

### Compact

opencc has compaction in `src/services/compact/` (autoCompact, snipCompact, sessionMemoryCompact). zai wraps this in `compactSession` service. The opencc compaction is streaming/callback-based; zai's `CompactSessionOptions` / `CompactSessionResult` are a different API shape. Shim: create a `compactService.ts` that wraps opencc's `autoCompactIfNeeded`.

### Background Runtime

opencc has background tasks in `src/tasks/` (LocalShellTask, LocalAgentTask, etc.) with `AppState`-backed tracking. zai's `DefaultBackgroundRuntime` is a separate persistence-backed system with JSON task store, SSE event streaming, and retry logic.

Different architectures — shim by porting zai's implementation.

---

## Ambiguities Encountered

| Item | Ambiguity | Resolution |
|---|---|---|
| `HookRunner` | opencc hook system spans multiple files (`hookRunner.ts`, `postSamplingHooks.ts`, etc.) | Best guess: `src/services/hooks/hookRunner.ts` is the main runner; verify exports in Task 8 |
| `DEFAULT_HOOK_TIMEOUT_MS` | opencc may not export this as a named constant | Shim to `5000` if not found; add TODO |
| `QueryEngine` | opencc `QueryEngine` has zio-specific SDK hooks (`setSDKStatus`, `handleElicitation`) that zai's `DefaultAgentRuntime` doesn't pass | Shim may need `// @ts-expect-error` for SDK-specific fields |
| `PluginRuntime` / `emptyPluginSnapshot` | opencc plugin system has multiple entry points | Best guess `src/utils/plugins/pluginLoader.ts`; verify in Task 8 |
| `resolveZaiPluginsDir` | zai-specific; opencc has `resolveOpenccPluginsDir` only | Shim: same as opencc but pointing to zai dir |
| `compactSession` | opencc compaction is spread across `src/services/compact/` and integrated into `QueryEngine` | Shim: wrap `autoCompactIfNeeded` + `snipCompactIfNeeded` into a session-scoped service |
| `TranscriptStore` (zai v2) | opencc has `sessionStorage.ts` which is NOT the same as zai's v2 transcript store | zai's v2 store has `CompactMetadata` support; must port zai implementation |

---

## Summary Counts

| Category | Count |
|---|---|
| Direct re-exports | ~30 |
| Shim items (zai-specific, port needed) | ~25 |
| Ambiguous (needs verification) | ~7 |
| **Total exports mapped** | **~62** |
