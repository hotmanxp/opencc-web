import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { PermissionDecision } from '../types/permissions.js'

/**
 * Bridge context for the headless permission flow — same shape as
 * AskUserQuestion's `AskUserQuestionBridgeContext` (compat/tools/opencc/
 * AskUserQuestionTool.ts). zai-server injects the static parts
 * (permissionRegistry / onYield) in initAgentRuntime; createOpenccRuntime-impl
 * merges the per-query sessionId. The wrapper reads it at CALL time.
 */
export interface HeadlessPermissionBridgeContext {
  sessionId?: string
  permissionRegistry?: any
  onYield?: (event: any) => void
}

/**
 * Wrap the headless `CanUseToolFn` (getCanUseToolFn(undefined) →
 * `hasPermissionsToUseTool`) so a `behavior: 'ask'` permission decision is
 * surfaced to the zai web UI instead of being rejected by toolExecution
 * (toolExecution.ts:1191 treats every non-allow decision as a denial).
 *
 * Without this, the headless server has no in-process dialog: vendor's
 * interactive permission handler (interactiveHandler.ts, used by the TUI's
 * useCanUseTool) never runs in the headless path, so `ask` falls straight
 * through to a `tool_use_error` and the model never gets user approval —
 * e.g. ExitPlanMode (checkPermissions returns `ask`, requiresUserInteraction
 * true) would be silently denied instead of prompting the user.
 *
 * The wrapper:
 *   1. calls the underlying canUseTool; non-ask decisions pass through;
 *   2. on `ask`, emits a `tool_use:permission_pending` yield via the bridge's
 *      onYield (zai-server translates it to a `prompt.permission` SSE event),
 *      then awaits the user's allow/deny through permissionRegistry (POST
 *      /api/agent/permission-response);
 *   3. resolves allow → `{behavior:'allow', updatedInput}` so the tool runs,
 *      deny → `{behavior:'deny', message}` so toolExecution surfaces the
 *      rejection to the model.
 *
 * If no bridge is configured (unit tests / headless without zai-server) the
 * decision is returned unchanged — behaviour identical to today.
 */
export function wrapHeadlessPermissionFn(
  rawCanUseTool: CanUseToolFn,
): CanUseToolFn {
  return async (
    tool,
    input,
    toolUseContext,
    assistantMessage,
    toolUseID,
    forceDecision,
  ) => {
    const decision = await rawCanUseTool(
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseID,
      forceDecision,
    )
    if (decision.behavior !== 'ask') return decision

    const bridge = ((globalThis as any).__zaiBridgeCtx ??
      {}) as HeadlessPermissionBridgeContext
    if (
      !bridge.permissionRegistry ||
      !bridge.onYield ||
      !bridge.sessionId ||
      !toolUseID
    ) {
      return decision
    }

    // Human-readable description for the web confirm card. Falls back to
    // the decision message when the tool can't render one.
    let description = decision.message ?? ''
    try {
      const rendered = await tool.description(input as any, {
        isNonInteractiveSession: true,
        toolPermissionContext: toolUseContext.getAppState().toolPermissionContext,
        tools: toolUseContext.options.tools,
      })
      if (typeof rendered === 'string' && rendered.trim()) {
        description = rendered
      }
    } catch {
      // keep the decision-message fallback
    }

    // Must yield BEFORE awaiting the registry: zai-server's bridge pushes
    // the SSE `prompt.permission` synchronously (the tool loop is itself
    // blocked on this await), so the web confirm card mounts before the
    // registry promise hangs.
    bridge.onYield({
      type: 'tool_use:permission_pending',
      id: toolUseID,
      toolUseId: toolUseID,
      toolName: tool.name,
      description,
      input,
      message: decision.message ?? '',
    })

    const signal = toolUseContext.abortController.signal
    try {
      const response = await bridge.permissionRegistry.register(
        toolUseID,
        bridge.sessionId,
        signal,
      )
      if (response && response.decision === 'allow') {
        const updated: PermissionDecision = {
          behavior: 'allow',
          updatedInput: response.updatedInput ?? input,
          decisionReason: decision.decisionReason,
        }
        return updated
      }
      return {
        behavior: 'deny',
        message:
          (response && typeof response.message === 'string' && response.message) ||
          '用户拒绝了该操作',
        decisionReason:
          decision.decisionReason ?? { type: 'other', reason: 'user_rejected_permission' },
      }
    } catch (err) {
      // Session abort / timeout — propagate so the tool loop aborts cleanly.
      throw err instanceof Error ? err : new Error(String(err))
    }
  }
}
