/**
 * `createHeadlessContext` runtime implementation.
 *
 * Vendor's CLI bootstrap (`entrypoints/cli.tsx main`, `setup.ts setup`,
 * `cli/print.ts runHeadless`) initializes a long list of subsystems —
 * configs, AppState, default tool registry, permission harness,
 * hooks/plugins, MCP clients, sandbox — but the initialization is
 * driven by `process.argv`, `process.cwd()`, and a global `STATE`
 * singleton. zai-server runs many sessions in the same Node process;
 * using the CLI bootstrap as-is means the second session's
 * `setCwdState(cwd)` overwrites the first's cwd, and any
 * `runWithSdkContext` read inside the first session sees the second
 * session's state (multi-session race documented in the plan's
 * "STATE.parentSessionId / STATE.planSlugCache 风险点").
 *
 * This module is the IMPLEMENTATION. The public surface (types +
 * factory declaration) lives in `createHeadlessContext.ts` so the
 * emitted `dist/opencc-src/server/createHeadlessContext.d.ts` is
 * self-contained (the verify-server-types-self-contained script
 * rejects any cross-module import in the server public surface —
 * see `scripts/verify-server-types-self-contained.mjs`).
 *
 * Per the brief: "仅为缺失的显式依赖增加小型导出，不复制工具实现
 * 或权限规则". All vendor code is reused; this module is glue.
 */

// @ts-nocheck — see createHeadlessContext.ts for the explanation.
// This file's runtime calls reach into vendored opencc-src modules
// whose ambient types (MACRO, React 19 `use`, etc.) are not part of
// the server public surface. The public d.ts surface is captured by
// the sibling file; this implementation file is excluded from the
// d.ts emit so the transitive type errors don't leak into the
// package's published types. Runtime behavior is locked by the
// vitest contract in `test/unit/server/headless-context.test.ts`.

import type { CreateHeadlessContextOptions, HeadlessContext } from './createHeadlessContext.js'
import type { CanUseToolFn } from '../Tool.js'
import type { Tools } from '../tools.js'
import { installMacroStub } from '../../compat/openccInit.js'
import { wrapAskUserQuestionToolAsOpencc } from '../../compat/tools/opencc/AskUserQuestionTool.js'
import { getAgentDefinitionsWithOverrides } from '../tools/AgentTool/loadAgentsDir.js'
import { getMcpToolsCommandsAndResources } from '../services/mcp/client.js'
import { captureHooksConfigSnapshot } from '../utils/hooks/hooksConfigSnapshot.js'
import { SandboxManager } from '../utils/sandbox/sandbox-adapter.js'
import {
  type AppStateStore,
  createAppStateStore,
} from '../state/createAppStateStore.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import {
  type Command,
  type MCPServerConnection,
  type Tool,
} from '../Tool.js'
import { getEmptyToolPermissionContext } from '../Tool.js'
import {
  getIsNonInteractiveSession,
  setClientType,
  setCwdState,
  setIsInteractive,
  setOriginalCwd,
} from '../bootstrap/state.js'
import { enableConfigs } from '../utils/config.js'
import { getCanUseToolFn } from '../cli/print.js'
import { wrapHeadlessPermissionFn } from './headlessPermissionBridge.js'
import { getTools } from '../tools.js'
import { onTaskChanged } from '../utils/tasks.js'
import { applyPermissionRulesToPermissionContext } from '../utils/permissions/permissions.js'
import { loadAllPermissionRulesFromDisk } from '../utils/permissions/permissionsLoader.js'
// zai patch (2026-08-29, plan §A): read `permissions.disableBypassPermissionsMode`
// during dangerouslySkipPermissions fail-loud guard.
import { getSettings_DEPRECATED } from '../utils/settings/settings.js'

/**
 * Build a fully-initialized headless OpenCC context keyed by the
 * caller's explicit `cwd` / `dataDir` / `runtimeId`.
 *
 * Order matches vendor's CLI bootstrap (`entrypoints/cli.tsx main` +
 * `setup.ts setup` + `runHeadless`):
 *
 *   1. installMacroStub()              — globalThis.MACRO must exist
 *                                       before bundle eval
 *   2. enableConfigs()                 — settings/globalConfig readable
 *   3. setIsInteractive(isInteractive) — interactive by default; SDK mode
 *                                       passes `isInteractive: false`
 *   4. setOriginalCwd(opts.cwd)        — STATE.originalCwd
 *   5. setCwdState(opts.cwd)           — STATE.cwd
 *   6. setClientType(opts.clientType)  — STATE.clientType
 *   7. createAppStateStore(getDefaultAppState())  — AppState (no Ink)
 *   8. getTools(permissionContext)     — built-in tool registry
 *   9. getMcpToolsCommandsAndResources — MCP clients (best-effort)
 *  10. captureHooksConfigSnapshot      — hooks snapshot
 *  11. getCanUseToolFn(undefined, ...) — permission rules (no prompt)
 *  12. SandboxManager exposed but NOT initialized (deferred)
 *
 * Step 12 deferral rationale: `SandboxManager.initialize(...)` requires
 * a sandbox-ask callback that wires network-permission requests back
 * to the host (CLI uses stdio; SDK uses control_request; server uses
 * SSE — all different shapes). Task 4 adds the initialize call once
 * the server-side ask callback is in scope.
 *
 * Multi-session safety: this factory mutates `STATE` (singleton) at
 * steps 3-6. Two contexts in the same process will overwrite each
 * other's STATE values — that's the documented race. Task 3 / Task 4
 * fix the race by wrapping calls with `runWithSdkContext({ cwd,
 * dataDir, sessionId, ... })`; this factory captures the explicit
 * per-context values on `ctx.config` so the wrapping is straightforward.
 */
export async function createHeadlessContextImpl(
  options: CreateHeadlessContextOptions,
): Promise<HeadlessContext> {
  const cwd = options.cwd
  const dataDir = options.dataDir
  const runtimeId = options.runtimeId
  const clientType = options.clientType ?? 'zai-server'
  // zai-server runs as a local dev tool with no per-prompt
  // approval UI; we default to `bypassPermissions` so the model
  // can call Bash / Read / Edit / Write / Glob / Grep / etc.
  // directly. Vendor's `hasPermissionsToUseTool` returns
  // `{behavior: 'allow'}` immediately when this mode is set
  // (utils/permissions/permissions.ts:1270-1283), subject to:
  // - the bypassPermissionsKillswitch (Statsig gate
  //   `shouldDisableBypassPermissions` flips it off if the org's
  //   policy requires user approval; runs once at boot)
  // - content-specific ask rules from `tool.checkPermissions`
  //   (e.g. an explicit `Bash(npm publish:*)` ask rule is
  //   respected even in bypass mode, per permissions.ts:1240-1252)
  // - path safety checks (.git/, .zai/, .vscode/, shell
  //   configs — these still prompt, per permissions.ts:1254-1262)
  // Callers that need stricter per-tool rules can pass
  // `permissionMode: 'default'` and write `allow` / `deny` rules
  // in their `toolPermissionContext` themselves.
  const permissionMode = options.permissionMode ?? 'bypassPermissions'
  const connectMcp = options.connectMcp ?? true

  // Step 1: macro stub — required before any vendor module eval that
  // touches `MACRO.X`. We delegate to the existing compat helper so
  // the stub shape stays in sync with the production bundle path
  // (openccInit.ts owns the MACRO field list).
  installMacroStub()

  // Step 2: enableConfigs() — the vendor guard `configReadingAllowed`
  // is `false` by default. Without this call, `getConfig()` inside
  // `getDefaultAppState()` throws "Config accessed before allowed."
  // We call enableConfigs() directly (not enableOpenccConfigs()) so
  // tests under vitest don't pull in the production-only bundle.
  enableConfigs()

  // Steps 3-6: vendor STATE. Default is interactive (the server behaves
  // like an interactive OpenCC CLI; verified against the real zai Web UI —
  // permission asks and AskUserQuestion still bridge to the web via
  // headlessPermissionBridge / the AskUserQuestion wrapper). Pass
  // `isInteractive: false` for SDK / headless mode (no TTY): vendor
  // branches then read `getIsNonInteractiveSession() === true`. The
  // clientType marker stays set so vendor branches take the server path.
  const isInteractive = options.isInteractive ?? true
  setIsInteractive(isInteractive)
  setOriginalCwd(cwd)
  setCwdState(cwd)
  setClientType(clientType)

  // Sanity: getIsNonInteractiveSession() reads STATE.isInteractive.
  // Assert the invariant matches what we just set (either direction),
  // so a vendor bootstrap race is caught instead of silently flipping
  // the mode under us.
  if (isInteractive ? getIsNonInteractiveSession() : !getIsNonInteractiveSession()) {
    throw new Error(
      '[createHeadlessContext] STATE.isInteractive mismatch after setIsInteractive(' +
        `${isInteractive}). Vendor bootstrap may have raced; check setIsInteractive ` +
        'export in bootstrap/state.ts.',
    )
  }

  // Step 7: AppState. We build the initial state from the vendor
  // default then wrap in createAppStateStore — the brief mandates
  // "AppState 不加载 Ink", and the store surface is plain
  // { getState, setState, subscribe } (no React/Ink).
  //
  // `isBypassPermissionsModeAvailable: true` is required for
  // vendor's bypass path to fire — `getEmptyToolPermissionContext`
  // defaults it to false. Without this flag,
  // `hasPermissionsToUseToolInner` (`permissions.ts:1270-1283`)
  // returns `behavior: 'allow'` ONLY when mode is
  // `bypassPermissions`; setting mode alone isn't enough. Pair
  // with the bypassPermissionsKillswitch in
  // `utils/permissions/bypassPermissionsKillswitch.ts:19-47` which
  // can disable bypass at boot if the org's policy requires user
  // approval.
  // zai patch: load permission rules from settings (allow/deny/ask) into
  // the headless permission context. The previous code used
  // getEmptyToolPermissionContext() directly, leaving alwaysAllowRules
  // empty — a user's `permissions.allow: ["mcp__codegraph__*"]` never
  // took effect, so MCP tools fell through to `ask` (web confirm card)
  // even in 'default' mode. Mirrors vendor's initializeToolPermissionContext
  // (permissionSetup.ts:983-1028): loadAllPermissionRulesFromDisk then
  // applyPermissionRulesToPermissionContext.
  // zai patch (2026-08-29, plan §A): when dangerouslySkipPermissions=true,
  // lock `isBypassPermissionsModeAvailable` to true so turn-time mode
  // switches (plan → bypassPermissions) bypass vendor
  // `print.ts:4802-4823` guard. Otherwise let vendor's default rules
  // (and `permissionSetup.ts:1424-1458` async gate) decide.
  let permissionContext = {
    ...getEmptyToolPermissionContext(),
    mode: permissionMode,
    isBypassPermissionsModeAvailable:
      options.dangerouslySkipPermissions ?? false,
  }
  // zai patch (2026-08-29, plan §A): fail loud if user explicitly disabled
  // bypass in settings while dangerouslySkipPermissions=true is requested.
  // Prevents silent override of an explicit user opt-out.
  if (options.dangerouslySkipPermissions) {
    const settings = getSettings_DEPRECATED() || {}
    if (settings.permissions?.disableBypassPermissionsMode === 'disable') {
      throw new Error(
        '[createHeadlessContext] dangerouslySkipPermissions=true rejected: ' +
          'settings.permissions.disableBypassPermissionsMode is "disable"',
      )
    }
  }
  try {
    permissionContext = applyPermissionRulesToPermissionContext(
      permissionContext,
      loadAllPermissionRulesFromDisk(),
    )
  } catch (err) {
    console.warn('[createHeadlessContext] permission rules load failed:', err)
  }
  const initialState = getDefaultAppState()
  const appState = createAppStateStore({
    ...initialState,
    toolPermissionContext: permissionContext,
  })

  // Step 8: built-in tool registry.
  const tools: Tools = getTools(permissionContext as any)

  // zai patch: load agent definitions BEFORE tools are wired into the
  // toolUseContext path. Vendor's CLI bootstrap populates
  // AppState.agentDefinitions from `getAgentDefinitionsWithOverrides`
  // (main.tsx:2097-2119) before QueryEngine init; without it the
  // default `getDefaultAppState()` value — `{ activeAgents: [], allAgents: [] }`
  // (AppStateStore.ts:528) — flows through to AgentTool.tsx:481, and
  // any `Agent(subagent_type: 'general-purpose', ...)` call throws
  // "Agent type 'general-purpose' not found. Available agents: " (the
  // available list is empty so the error is unreadable). The loader
  // is memoized (first call may read disk for `.zai/agents/*.md`;
  // subsequent calls hit the cache) and has its own try/catch that
  // returns built-in agents on error (loadAgentsDir.ts:372-384), so
  // a broken user/project agent markdown can't take down the runtime.
  const agentDefinitions = await getAgentDefinitionsWithOverrides(cwd)
  appState.setState((prev: any) => ({ ...prev, agentDefinitions }))

  // zai patch: replace vendor's TUI-bound AskUserQuestion with the
  // zai-native wrapper. The vendor tool assumes an in-process
  // interactive prompt — its checkPermissions returns `behavior:'ask'`
  // and requiresUserInteraction() is true, so permissions.ts step 1e
  // (permissions.ts:1232-1238) keeps the decision 'ask' even in
  // bypassPermissions mode, and there's no TUI in the headless server
  // to answer it. Its `call()` returns empty answers and never emits
  // `tool_use:ask_pending`, so the Web UI QuestionCard never renders.
  // The wrapper (wrapAskUserQuestionToolAsOpencc) reads
  // __zaiBridgeCtx at call time (sessionId / askRegistry / onYield —
  // injected by zai-server's initAgentRuntime + createOpenccRuntime-
  // impl.query) and drives the server's AskRegistry + POST
  // /api/agent/answer flow, letting the frontend render the question
  // card and POST answers back.
  const askUserQuestionIdx = tools.findIndex(
    (t) => (t as Tool).name === 'AskUserQuestion',
  )
  if (askUserQuestionIdx >= 0) {
    tools[askUserQuestionIdx] = wrapAskUserQuestionToolAsOpencc() as unknown as Tool
  }

  // ExitPlanMode keeps vendor's original implementation (checkPermissions
  // returns `{behavior:'ask'}` when in plan mode). The `ask` decision flows
  // through the headless permission bridge (headlessPermissionBridge.ts,
  // wrapping `permission` below) which surfaces a web PermissionConfirmCard —
  // no TUI-only wrapper needed.
  //
  // Step 9: MCP. Best-effort — empty arrays on failure so the
  // headless context still boots without MCP servers. When
  // `connectMcp` is `false` (zai-server's default) we skip the
  // synchronous `getMcpToolsCommandsAndResources` call entirely;
  // the function can block indefinitely on the user's `~/.zai/`
  // MCP server config (a known issue when the user has live MCP
  // servers listed in `~/.zai.json` from interactive Claude
  // Code). zai-server refreshes MCP lazily via the QueryEngine's
  // own per-query refresh path (and via the `/mcp` slash command),
  // so an empty `mcp` surface at boot is acceptable.
  const mcp = {
    clients: [] as MCPServerConnection[],
    tools: [] as Tool[],
    commands: [] as Command[],
  }
  if (connectMcp) {
    try {
      await getMcpToolsCommandsAndResources(
        ({ client, tools: t, commands }) => {
          mcp.clients.push(client)
          mcp.tools.push(...t)
          mcp.commands.push(...commands)
        },
        undefined,
      )
      appState.setState((prev: any) => ({
        ...prev,
        mcp: {
          clients: mcp.clients,
          tools: mcp.tools,
          commands: mcp.commands,
          resources: {},
          pluginReconnectKey: 0,
        },
      }))
    } catch {
      // Best-effort — fall back to empty arrays.
    }
  }

  // Step 10: hooks snapshot.
  let snapshotCaptured = false
  try {
    captureHooksConfigSnapshot()
    snapshotCaptured = true
  } catch {
    // Same best-effort posture as MCP.
  }

  // Step 11: permission rules. Pass `permissionPromptToolName:
  // undefined` so `getCanUseToolFn` returns the rules-based fallback
  // (`hasPermissionsToUseTool`), not a stdio-style prompt.
  const permission: CanUseToolFn = wrapHeadlessPermissionFn(
    getCanUseToolFn(
      undefined,
      null as unknown as Parameters<typeof getCanUseToolFn>[1],
      () => mcp.tools,
    ),
  )

  // Step 12: sandbox. We expose the manager but DO NOT call
  // `SandboxManager.initialize(...)` — that requires a server-side
  // ask callback (network permission requests) that Task 4 supplies.
  const sandbox = {
    available: SandboxManager.isSandboxingEnabled(),
    manager: SandboxManager,
  }

  // zai patch: bridge vendor task mutations → SSE event bus via
  // globalThis.__zaiEventBus (set by zai-server's agentRuntime.ts).
  // This subscribes to the SAME bundle's taskChanged signal that the
  // TaskCreate/Update tools (from getTools() above) emit on.
  // The subscription is in createHeadlessContext-impl.js (not opencc-core.mjs)
  // because utils/tasks.ts is duplicated across bundles, and the tools
  // are created by this same bundle's getTools().
  onTaskChanged(({ taskListId, task, action }) => {
    const bus = (globalThis as any).__zaiEventBus as
      | { emit: (e: unknown) => void }
      | undefined
    if (!bus) return
    bus.emit({
      type: 'v2_task.changed' as const,
      sessionId: taskListId,
      task: {
        id: task.id,
        subject: task.subject ?? '',
        description: task.description,
        activeForm: task.activeForm,
        status: task.status ?? 'pending',
        blocks: Array.isArray(task.blocks) ? task.blocks : [],
        blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy : [],
        owner: task.owner,
        updatedAt: Date.now(),
      },
      action: action === 'delete' ? 'delete' : 'upsert',
    })
  })

  // Cast at the boundary: vendor types (AppStateStore, CanUseToolFn,
  // Tools, etc.) are structurally compatible with the public types in
  // createHeadlessContext.ts. The cast stays in this file so the
  // public d.ts doesn't drag in vendor type imports.
  return {
    config: {
      cwd,
      dataDir,
      runtimeId,
      clientType,
      isInteractive,
      permissionMode,
      connectMcp,
    },
    appState: appState as unknown as HeadlessContext['appState'],
    tools: tools as unknown as HeadlessContext['tools'],
    permission: permission as unknown as HeadlessContext['permission'],
    hooks: { snapshotCaptured },
    mcp,
    sandbox,
    // Task 3 replaces this placeholder with a real session facade.
    sessions: { placeholder: true },
  } as HeadlessContext
}