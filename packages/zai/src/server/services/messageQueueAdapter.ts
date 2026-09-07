/**
 * zai patch (2026-09-07, plan P0-1.1, worktree-dsh, fix-area: vendor-enqueue-imports):
 * zai-server 层 messageQueueAdapter wrapper —— vendor enqueue 22 个调用方
 * import 替换的统一入口。本模块是 zai-server 侧薄包装,真正的 sessionId
 * 注入逻辑在 zn-agent-core 的 compat 层 (`compat/messageQueueAdapter.js`,
 * 由 bundle-entry re-export 走主入口 `@zn-ai/zn-agent-core`)。
 *
 * 为什么不在 zai-server 写 wrapper:
 *   vendor 文件 (opencc-src/*) 不能 import zai-server 路径(循环依赖 +
 *   bundle isolation + zai 目录对 vendor 是 runtime 仅有的下游, 不是
 *   compile-time dependency)。所以 wrapper 必须放在 compat 层 (vendor
 *   可 import), zai-server 侧只剩 re-export + bridge 安装。
 *
 * dsh 视角特有设计 (2026-09-07, plan §0):
 *   - 独立 sessionId 字段,不污染 vendor 子 agent agentId 命名空间。
 *   - sessionId 来源优先级: cmd.sessionId ?? cmd.agentId ?? bridgeCtx
 *     ?? compat ALS (runWithSessionId)。
 *   - sessionId 缺失时 throw loud,不静默入错队列。
 *
 * Bridge 安装语义:
 *   vendor `enqueue` / `enqueuePendingNotification` 来自
 *   `@zn-ai/zn-agent-core`(bundle 单实例), zai-server 入口层
 *   (本模块加载时) installMessageQueueAdapterBridges 把这两个
 *   vendor 函数写到 globalThis。compat 层 wrapper 读 globalThis 拿到
 *   真实函数, 完成 sessionId 注入。
 */

import {
  enqueue as _vendorEnqueue,
  enqueuePendingNotification as _vendorEnqueuePendingNotification,
  installMessageQueueAdapterBridges,
  zaiEnqueue,
  zaiEnqueuePendingNotification,
  __zaiGetCurrentSessionId,
  type ZaiQueuedCommand,
} from '@zn-ai/zn-agent-core'

// 入口层 install 一次: bundle 单实例保证两边引用同一个模块函数。
installMessageQueueAdapterBridges({
  enqueue: _vendorEnqueue,
  enqueuePendingNotification: _vendorEnqueuePendingNotification,
})

export {
  zaiEnqueue,
  zaiEnqueuePendingNotification,
  __zaiGetCurrentSessionId,
  type ZaiQueuedCommand,
}
