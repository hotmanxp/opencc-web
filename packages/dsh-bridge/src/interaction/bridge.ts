/**
 * dsh 交互桥 — P1-4（真实化）。
 *
 * 设计目标：把 dsh 的 user-approval seam 桥接到 zai 的 approveRegistry。
 *
 * **AskUserQuestion 桥不在本文件** — 见 `tools/askUser.ts` 的
 * `registerAskUserProvider(ctx, sink)` 与 `registerAskUserTool(ctx)`:
 * - AskUserQuestion 的模型可调工具是 zai-side **自实现**的(`defineTool`),
 *   因为上游 `@deepseek-ai/dsh-tool-ask-user` 在 rc.8 阶段**未发布**
 *   (节点 modules 中无此包;只有 service definition `dsh-user-questions`)。
 * - 自实现 tool 的 execute 内部走 `ctx.userQuestions.ask` 上游 seam,
 *   provider 由 zai-side `registerAskUserProvider` 注入 zai askRegistry。
 *
 * 架构：
 *   1. dsh 侧 Consumer 在 tools/pre-execute 时通过 ctx.approval.request(req)
 *      发起询问；这些请求 emit 'approval/request' 事件给 answerer chain。
 *   2. bridge 注册一个 answerer，把请求翻译为 zai approveRegistry 调用；
 *   3. zai 前端 /api/agent/approve 触发 registry.resolve；
 *   4. bridge 把 zai 的结果转回 ApprovalOutcome。
 *
 * 与 zai 的连接通过回调注入（不直接 import zai 服务 — 避免反向依赖）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalOutcome, ApprovalRequest as DshApprovalRequest } from '@deepseek-ai/dsh-user-approval'

export interface ApprovalRequest {
  callId: string
  toolName: string
  input: unknown
  description: string
  filePath?: string
}

export type ApprovalDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason?: string }
  | { kind: 'allow_remember'; pattern: string }

/**
 * permissionMode 映射 — P1-4 T4.4。
 */
export type PermissionMode = 'bypassPermissions' | 'acceptEdits' | 'default' | 'plan'

export function mapPermissionMode(
  zaiMode: PermissionMode,
): { allowAll: boolean; requireApproval: boolean; planMode: boolean } {
  switch (zaiMode) {
    case 'bypassPermissions':
      return { allowAll: true, requireApproval: false, planMode: false }
    case 'acceptEdits':
      return { allowAll: false, requireApproval: true, planMode: false }
    case 'plan':
      return { allowAll: false, requireApproval: true, planMode: true }
    case 'default':
    default:
      return { allowAll: false, requireApproval: true, planMode: false }
  }
}

/**
 * Zai-side 桥接句柄 — 由 zai KernelAdapter 注入。
 *
 * 桥不直接 import zai 服务；通过 callback 解耦。这样 dsh-bridge
 * 可以独立 typecheck / 单测。
 *
 * **AskUserQuestion 不走本 sink** — AskUserQuestion sink 由 zai-side
 * 通过 `registerAskUserProvider(ctx, sink)` 注入到 `ctx.userQuestions`
 * 上游 seam,见 `tools/askUser.ts`。本 sink 只覆盖 approval。
 */
export interface ZaiInteractionSink {
  /**
   * 发起一次 approve 请求。返回 Promise，在用户答复后 resolve。
   *
   * 内部应调 zai approveRegistry.register(toolUseId, sessionId, filePath, signal)
   * 并 emit `prompt.approve` SSE。
   */
  requestApprove(req: {
    toolUseId: string
    sessionId: string
    filePath: string
    description: string
    abortSignal: AbortSignal
  }): Promise<ApprovalDecision>

  /** 当前 sessionId — 由 zai 侧注入（用于 registry 路由）。 */
  getSessionId(): string | undefined
}

/**
 * Approval Bridge — 把 dsh approval/request 事件翻译为 zai approveRegistry 调用。
 *
 * 注册一个 answerer 到 ctx.on('approval/request')；返回 disposer。
 */
export interface ApprovalBridge {
  /** 注入 zai 交互 sink（由 zai KernelAdapter 在 createSession 时注入）。 */
  setSink(sink: ZaiInteractionSink): void
  /** disposer — 卸载 answerer。 */
  dispose(): void
}

export function installApprovalBridge(ctx: Context): ApprovalBridge {
  let sink: ZaiInteractionSink | undefined
  const off = ctx.on('approval/request', async (req: DshApprovalRequest, next) => {
    if (!sink) {
      // 没有 zai sink 时走 fail-closed 默认（'unavailable'）
      console.warn('[dsh-bridge] approval/request but no zai sink installed — fail-closed')
      return (await next()) as ApprovalOutcome
    }
    const sessionId = sink.getSessionId() ?? ''
    const toolUseId = `apv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const decision = await sink
      .requestApprove({
        toolUseId,
        sessionId,
        filePath: typeof req.callId === 'string' ? req.callId : '',
        description: req.reason ?? `Approve ${req.toolName}?`,
        abortSignal: req.signal ?? new AbortController().signal,
      })
      .catch((err) => {
        console.warn('[dsh-bridge] approval bridge error:', err)
        return { kind: 'deny', reason: 'bridge_error' } as ApprovalDecision
      })

    switch (decision.kind) {
      case 'allow':
      case 'allow_remember':
        return 'allowed-once' as ApprovalOutcome
      case 'deny':
        return 'rejected' as ApprovalOutcome
      default:
        return 'unavailable' as ApprovalOutcome
    }
  })

  return {
    setSink(s: ZaiInteractionSink) {
      sink = s
    },
    dispose() {
      off?.()
      sink = undefined
    },
  }
}

/**
 * 一次性安装 approval bridge。
 *
 * **AskUserQuestion 不在本文件** — 由 zai-side 显式调用 `tools/askUser.ts`
 * 的 `registerAskUserProvider(ctx, sink)` + `registerAskUserTool(ctx)`
 * 装载(zai-side factories 不需要 interactionBridges 这层间接)。
 *
 * 返回 setSink / dispose 控制器。
 */
export function installInteractionBridges(ctx: Context): {
  setSink: (sink: ZaiInteractionSink) => void
  dispose: () => void
} {
  const approval = installApprovalBridge(ctx)
  return {
    setSink(sink: ZaiInteractionSink) {
      approval.setSink(sink)
    },
    dispose() {
      approval.dispose()
    },
  }
}