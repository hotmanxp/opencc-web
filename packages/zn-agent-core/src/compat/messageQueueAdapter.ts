/**
 * zai patch (2026-09-07, plan P0-1.1, worktree-dsh, fix-area: vendor-enqueue-imports):
 * compat 层 messageQueueAdapter wrapper —— 22 个 vendor 调用方 import 替换
 * 的真正入口。vendor 文件 (opencc-src/*) 不能 import zai-server 路径
 * (循环依赖 + bundle isolation + zai 目录对 vendor 是 runtime 下游),
 * 所以 wrapper 放在 compat 层 (vendor 可以 `../compat/messageQueueAdapter`
 * 解析)。zai-server 层 `services/messageQueueAdapter.ts` 保留为 zai-side
 * wrapper 兼 re-export 本模块(单一来源)。
 *
 * 实现策略: globalThis 委托
 *   vendor 调用方经本模块进入, 本模块读 `globalThis.__zaiVendorEnqueue`
 *   / `globalThis.__zaiVendorEnqueuePendingNotification` 拿到真正的
 *   vendor 函数。这两个 global 由 zai-server 入口层在 createApp 时 set,
 *   持有 vendor enqueue 函数引用(bundle 单实例保证)。
 *   不直接 import vendor `messageQueueManager` —— 那样会让 tsc 在
 *   opencc-src/ vendor 文件中扫到 compat 引用, 且 compat 模块也不
 *   能 emit .js(emitDeclarationOnly:true), 形成 TS2307。
 *
 * dsh 视角特有设计 (2026-09-07, plan §0):
 *   - 独立 sessionId 字段, 不污染 vendor 子 agent agentId 命名空间。
 *   - sessionId 来源优先级: cmd.sessionId ?? cmd.agentId ?? bridgeCtx
 *     ?? currentSessionId (compat ALS)。
 *   - sessionId 缺失时 throw loud, 不静默入错队列。
 *
 * 与 vendor 区别:
 *   - vendor `enqueuePendingNotification` 不带 sessionId 注入
 *   - 本 wrapper 始终保证 sessionId 有值 (调用方不必显式传)
 *
 * 边界:
 *   - 22 处 vendor 调用方改成 `import { zaiEnqueuePendingNotification }
 *     from '../../compat/messageQueueAdapter.js'`
 *   - 测试 seam: `installMessageQueueAdapterBridges({ enqueue, enqueuePendingNotification })`
 *     由 zai-server createApp 调; vendor 单测不调 → throw loud (fail fast)。
 */
import { getCurrentSessionId as _compatGetSessionId } from './runWithSessionId.js'

/**
 * 测试 / zai-server 启动用: 把 vendor enqueue 函数安装到 globalThis,
 * 之后 vendor 调用方走本 compat wrapper 就拿到正确的 sessionId 注入。
 */
export function installMessageQueueAdapterBridges(bridges: {
  enqueue: (cmd: { value: unknown; mode: string; [k: string]: unknown }) => void
  enqueuePendingNotification: (cmd: { value: unknown; mode: string; [k: string]: unknown }) => void
}): void {
  globalThis.__zaiVendorEnqueue = bridges.enqueue
  globalThis.__zaiVendorEnqueuePendingNotification = bridges.enqueuePendingNotification
}

/**
 * 测试 seam: 清空 globalThis 桥。
 */
export function __resetMessageQueueAdapterBridgesForTests(): void {
  globalThis.__zaiVendorEnqueue = undefined
  globalThis.__zaiVendorEnqueuePendingNotification = undefined
}

/**
 * 公共入参类型 —— 不引用 vendor 的 QueuedCommand 类型 (避免 compat 依赖
 * opencc-src types 链), 用最小 shape 满足 22 处调用方语义。
 */
export interface ZaiQueuedCommand {
  value: unknown
  mode: string
  priority?: 'now' | 'next' | 'later'
  agentId?: string
  uuid?: string
  taskKind?: string
  enqueuedAt?: number
  isMeta?: boolean
  preExpansionValue?: string
  pastedContents?: Record<number, unknown>
  skipSlashCommands?: boolean
  bridgeOrigin?: boolean
  origin?: string
  workload?: string
  orphanedPermission?: unknown
  /** zai 入口注入的 sessionId, 优先于 agentId。 */
  sessionId?: string
  [k: string]: unknown
}

/**
 * Resolve the sessionId for the current async context. Priority:
 *   1. `cmd.sessionId` (调用方显式传入)
 *   2. `cmd.agentId` (vendor 子 agent 调用方原本会传的 agentId,兼容)
 *   3. `globalThis.__zaiBridgeCtx?.sessionId` (zai 入口层注入)
 *   4. compat ALS `getCurrentSessionId()` (runWithSessionId 上下文)
 */
export function __zaiGetCurrentSessionId(cmd?: ZaiQueuedCommand): string | undefined {
  return (
    cmd?.sessionId ??
    cmd?.agentId ??
    (globalThis.__zaiBridgeCtx?.sessionId as string | undefined) ??
    _compatGetSessionId()
  )
}

/**
 * zai wrapper: 自动注入独立 sessionId 字段。
 * vendor 调用方改为:
 *   import { zaiEnqueue } from '../../compat/messageQueueAdapter.js'
 *   zaiEnqueue({ value, mode: 'prompt' })
 *
 * @throws 缺 sessionId 时 throw loud。
 * @throws globalThis 桥未安装时 throw (test seam 漏配或 vendor CLI 裸跑)。
 */
export function zaiEnqueue(cmd: ZaiQueuedCommand): void {
  const sessionId = __zaiGetCurrentSessionId(cmd)
  if (!sessionId) {
    throw new Error(
      `[zaiEnqueue] sessionId required (cmd.sessionId=${cmd.sessionId ?? 'undefined'}, ` +
        `cmd.agentId=${cmd.agentId ?? 'undefined'}, ` +
        `bridgeCtx.sessionId=${globalThis.__zaiBridgeCtx?.sessionId ?? 'undefined'})`,
    )
  }
  const fn = globalThis.__zaiVendorEnqueue
  if (!fn) {
    throw new Error(
      `[zaiEnqueue] vendor bridge not installed. call installMessageQueueAdapterBridges() at server startup (or in test setup).`,
    )
  }
  return fn({ ...cmd, sessionId })
}

/**
 * zai wrapper: 自动注入独立 sessionId 字段(后台通知)。
 * 默认 priority 由调用方显式控制(vendor 原 wrapper 行为)。
 *
 * @throws 缺 sessionId 时 throw loud。
 * @throws globalThis 桥未安装时 throw。
 */
export function zaiEnqueuePendingNotification(cmd: ZaiQueuedCommand): void {
  const sessionId = __zaiGetCurrentSessionId(cmd)
  if (!sessionId) {
    throw new Error(
      `[zaiEnqueuePendingNotification] sessionId required (cmd.sessionId=${cmd.sessionId ?? 'undefined'}, ` +
        `cmd.agentId=${cmd.agentId ?? 'undefined'}, ` +
        `bridgeCtx.sessionId=${globalThis.__zaiBridgeCtx?.sessionId ?? 'undefined'})`,
    )
  }
  const fn = globalThis.__zaiVendorEnqueuePendingNotification
  if (!fn) {
    throw new Error(
      `[zaiEnqueuePendingNotification] vendor bridge not installed. call installMessageQueueAdapterBridges() at server startup (or in test setup).`,
    )
  }
  return fn({ ...cmd, sessionId })
}
