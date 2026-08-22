/**
 * dsh 交互桥 — B4 T4.1。
 *
 * 设计目标：把 dsh 的 user-approval / tool-ask-user / user-questions seam
 * 桥接到 zai 的 approveRegistry / askRegistry / requestApproveTool。
 *
 * 架构：
 *   1. dsh 侧 Consumer 在 tools/pre-execute / tool-ask-user 请求 approval
 *      或 ask-user 时调用回调；
 *   2. bridge 把回调翻译为 zai registry 调用；
 *   3. zai 前端交互结果（approve / deny / 答案）通过 registry 异步 resolve；
 *      bridge 把结果转回 dsh Provider。
 *
 * B4 T4.1 当前：定义接口 + 类型；T4.2/T4.3/T4.4 阶段分别实现 approval /
 * askUser / permissionMode。
 *
 * **TODO（P1-4）真实实现**：
 * 1. 装载 `@deepseek-ai/dsh-user-approval` 插件
 * 2. 在 dsh ctx 上订阅 `tools/pre-execute` 事件，调用 ApprovalBridge.request
 * 3. ApprovalBridge.request 调 zai `approveRegistry.register` + emit
 *    `prompt.approve` ServerEvent
 * 4. zai 前端 /api/agent/approve 回调时 resolve ApprovalBridge 等待中的 Promise
 *
 * 预计工作量 2 天。
 */

export interface ApprovalRequest {
  /** dsh tool execution 标识 — 与 tool/call.callId 配对。 */
  callId: string
  /** 工具名（zai 工具注册名）。 */
  toolName: string
  /** 输入（已序列化）。 */
  input: unknown
  /** 描述 — 前端审批弹窗展示。 */
  description: string
}

export type ApprovalDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason?: string }
  | { kind: 'allow_remember'; pattern: string }

export interface AskUserRequest {
  /** dsh 端 toolUseId — 与 tool/ask-user 配对。 */
  toolUseId: string
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description?: string }>
    multiSelect?: boolean
  }>
}

export type AskUserAnswer = {
  /** question index → answer label / free-form text。 */
  answers: Record<string, string>
}

/**
 * approval bridge 接口 — 由 B4 T4.2 真实实现。
 */
export interface ApprovalBridge {
  request(req: ApprovalRequest): Promise<ApprovalDecision>
}

/**
 * askUser bridge 接口 — 由 B4 T4.3 真实实现。
 */
export interface AskUserBridge {
  request(req: AskUserRequest): Promise<AskUserAnswer>
}

/**
 * permissionMode 映射 — B4 T4.4。
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