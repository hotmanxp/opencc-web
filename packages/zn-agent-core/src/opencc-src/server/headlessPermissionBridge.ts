import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { PermissionDecision } from '../types/permissions.js'

/**
 * zai patch (2026-10-16, cc-002): per-async-chain sessionId resolver 的读取口。
 *
 * 本文件在 vendor 树内,**够不到** compat 的 `runWithSessionId` ALS(反向依赖)。
 * 所以由 compat 在 init 时经 globalThis 注册进来 —— 与同目录既有的
 * `__zaiIsNonInteractive` 同款 seam(见 compat/openccInit.ts)。
 *
 * 为什么必须有它:`globalThis.__zaiBridgeCtx.sessionId` 由
 * `createOpenccRuntime-impl.query` 在每次 query 前后做「存旧值 → 写本次 →
 * finally 恢复」,是**进程级**的,并发会话互相覆盖;B 先结束时的 finally 恢复
 * 还会让仍在跑的 A 读到无关旧值。审批登记因此串台。ALS 才是 per-chain 的。
 *
 * 未注册时(单元测试 / 不走 zai-server 的 headless)为 undefined,行为与修复前
 * 完全一致 —— 退回读全局。
 */
function resolveSessionIdFromAsyncContext(): string | undefined {
  const resolver = (globalThis as any).__zaiSessionIdResolver
  return typeof resolver === 'function' ? resolver() : undefined
}

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
    // zai patch (2026-10-16, cc-002): 与 AskUserQuestionTool.ts:28 对齐 ——
    // per-async-chain 的 ALS 优先,拿不到才退回进程级全局。
    //
    // 此前这里只读 `bridge.sessionId`,而那是 per-query 写、finally 恢复的
    // 进程级全局:并发会话会互相覆盖,B 先结束时的恢复还会让仍在跑的 A
    // 读到无关旧值。审批登记因此挂到别的会话上(见 __zaiSessionIdResolver
    // 上方注释)。
    const sessionId = resolveSessionIdFromAsyncContext() ?? bridge.sessionId
    if (
      !bridge.permissionRegistry ||
      !bridge.onYield ||
      !sessionId ||
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
        sessionId,
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
