/**
 * zai patch (2026-09-07, plan P0-1.1, worktree-dsh): zai 维度 1+2 隔离的
 * 关键 adapter 层。zai 是多 session 服务,vendor 是单进程单 session CLI;
 * vendor 内部 `commandQueue` 是模块级单例(`messageQueueManager.ts:52`),
 * 5 个消费者共享, 没有 session 隔离。zai 在 vendor 入队处包装一层
 * 自动注入独立 `sessionId?` 字段(vendor patch ≤3 处:类型 + filter + 签名)。
 *
 * dsh 视角特有设计(2026-09-07, plan §0 修正):
 *   - 用**独立 sessionId 字段**,不复用 vendor `agentId`
 *     实测 vendor 内部 `toolUseContext.agentId` 在 30+ 处被引用
 *     (BashTool preventCwdChanges / attachments plan 路径 /
 *     PermissionContext / SDK 输出), 灌 sessionId 会污染 vendor
 *     子 agent 文件系统 + 误判主线程。本 adapter 注入 `cmd.sessionId`,
 *     不动 `cmd.agentId`。
 *   - sessionId 来源优先级: `cmd.sessionId ?? cmd.agentId ?? globalThis`
 *     zai 入口层 (`agentRuntime.ts:178` `__zaiBridgeCtx.sessionId`) 在
 *     调 vendor query 前 set, 大多数调用方 (vendor 22 个 enqueue 调用方
 *     实测, 不是 26) 不在 vendor query 调用栈内, ALS `getSessionId()`
 *     在 async callback 不可达。globalThis sessionId 是 zai 入参注入
 *     的统一通道, 类似 dsh `runWithSdkContext` 模式的 globalThis 兜底。
 *
 * 边界:
 *   - `zaiEnqueue` / `zaiEnqueuePendingNotification` 接受 zai 调用方传的
 *     QueuedCommand(类型已扩展 sessionId? 字段), 自动注入并转发给 vendor
 *   - 22 个 vendor 调用方 import 替换 + 调用替换是另一个工单范围(plan
 *     §2.1), 本文件只暴露 wrapper
 */

import {
  enqueue as _vendorEnqueue,
  enqueuePendingNotification as _vendorEnqueuePendingNotification,
  // zai patch (2026-09-07, plan P0-1.1, worktree-dsh): zai 入口层注入的
  // globalThis sessionId(zai 在调 vendor query 前 set)。fallback 到 vendor
  // ALS `getSessionId()` —— vendor `hooks.ts:3609/3704/3763/4083` 已实现,
  // 但在 async callback 不可达, 仅作兜底。
  getCurrentSessionId as _vendorGetSessionId,
} from '@zn-ai/zn-agent-core'
import type { QueuedCommand } from '@zn-ai/zn-agent-core'

// zai patch (2026-09-07, plan P0-1.1, worktree-dsh): zai 入口层
// (agentRuntime.ts:178) set, 由调用方读, 全局兜底 sessionId。
declare global {
  // eslint-disable-next-line no-var
  var __zaiBridgeCtx:
    | {
        sessionId?: string
        // 其他字段 (askRegistry / onYield / permissionRegistry) 已存在,
        // 不在本 adapter 消费, 类型留作隐式兼容
        [k: string]: unknown
      }
    | undefined
}

export type ZaiQueuedCommand = QueuedCommand & {
  /** zai 入口注入的 sessionId, 优先于 agentId。 */
  sessionId?: string
}

/**
 * Resolve the sessionId for the current async context. Priority:
 *   1. `cmd.sessionId`(调用方显式传入,例如 `__zaiGetCurrentSessionId()`)
 *   2. `cmd.agentId`(vendor 子 agent 调用方原本会传的 agentId,兼容)
 *   3. `globalThis.__zaiBridgeCtx?.sessionId`(zai 入口层注入)
 *   4. vendor ALS `getSessionId()`(兜底,async callback 不可达场景失败)
 */
export function __zaiGetCurrentSessionId(cmd?: ZaiQueuedCommand): string | undefined {
  return (
    cmd?.sessionId ??
    cmd?.agentId ??
    (globalThis.__zaiBridgeCtx?.sessionId as string | undefined) ??
    (_vendorGetSessionId() as string | undefined)
  )
}

/**
 * zai wrapper: zaiEnqueue 自动注入独立 sessionId 字段。
 *
 * 旧 (vendor 原始):
 *   enqueue({ value, mode: 'prompt' })
 * 新 (zai 调用方替换为):
 *   import { zaiEnqueue } from '@zn-ai/zai/server/services/messageQueueAdapter'
 *   zaiEnqueue({ value, mode: 'prompt', sessionId: __zaiGetCurrentSessionId() })
 *
 * @throws 缺 sessionId 时 throw loud, 不静默入错队列(2026-09-07 plan 修订:
 *   原提案允许静默, 改 throw 后调试更直观)。
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
  return _vendorEnqueue({ ...cmd, sessionId } as QueuedCommand)
}

/**
 * zai wrapper: zaiEnqueuePendingNotification 自动注入独立 sessionId 字段。
 * 默认 priority: 'later' (vendor 原 wrapper 行为), 后台通知不阻塞主线。
 *
 * @throws 缺 sessionId 时 throw loud。
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
  return _vendorEnqueuePendingNotification({ ...cmd, sessionId } as QueuedCommand)
}
