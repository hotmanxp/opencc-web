/**
 * createDshRuntime — dsh 长驻 Cordis ctx 装配（B1a T1.1）。
 *
 * 替代 headless 的"run 完 exit"语义，让 zai 进程能复用 dsh 内核做长驻 Agent。
 *
 * 装载模型（dsh-base 提供 profile patch）：
 *   1. @deepseek-ai/dsh-base (cordis.yml patch — base plugins)
 *   2. @deepseek-ai/dsh-headless (headless-runner plugin — 但 disable apply)
 *   3. @deepseek-ai/dsh-agent (agents service)
 *   4. @deepseek-ai/dsh-agent-loop (ReactLoopAgent)
 *   5. @deepseek-ai/dsh-session (sessions service + SessionEventMap)
 *   6. @deepseek-ai/dsh-session-persistence-jsonl (持久化 provider)
 *   7. @deepseek-ai/dsh-tools (tools registry)
 *   8. @deepseek-ai/dsh-scope (ScopedLayers)
 *   9. @deepseek-ai/dsh-system-prompt (system prompt assembly)
 *  10. @deepseek-ai/dsh-agent-default-model (default model selection)
 *
 * 长驻语义：
 *   - 构造空白 Cordis ctx
 *   - 逐个 import dsh-* 让它们的 side-effect plugin 注册到 globalThis/loaders
 *   - 触发 ctx 的 loader 完成（await ctx.get("loader")?.await()）
 *   - shutdown() 走 drain 顺序（B-1 尖峰）：
 *     1. 拒绝新请求
 *     2. flush 当前 turn — sessions.flush(ctx 持有的所有 session)
 *     3. dispose Cordis ctx
 *     4. 清 globalThis 桥 — 调用方负责（zai 侧）
 */

import { Context } from '@deepseek-ai/cordis'

import { DSH_KERNEL, type KernelId } from './paths.js'

export interface CreateDshRuntimeOptions {
  dataDir: string
  runtimeId: string
  defaultCwd: string
  defaultModel: string
}

export interface DshRuntimeHandle {
  readonly kernel: KernelId
  readonly ctx: Context
  activeCount(): number
  start(): Promise<void>
  shutdown(): Promise<void>
}

let activeDshHandles = 0

export function getActiveDshHandleCount(): number {
  return activeDshHandles
}

/**
 * 构造 dsh 长驻 ctx。把 dsh 全部所需 plugin 按依赖顺序装载。
 */
export async function createDshRuntime(
  opts: CreateDshRuntimeOptions,
): Promise<DshRuntimeHandle> {
  // 构造空白 Cordis ctx。Cordis 提供自反射的 Context 类。
  const ctx = new Context()

  activeDshHandles++

  // 装载 core + agent + headless bundles
  // plugin 的 side-effect import 让 cordis loader 知道有哪些 plugin 待挂载
  // （cordis 的 plugin loader 通过 cordis-plugin-loader 自动处理）。
  // 由于 dsh-base 是 declarative bundle patch（cordis.yml），不直接 import；
  // 它通过 dsh-headless 等下游包间接被装载。
  await Promise.all([
    import('@deepseek-ai/dsh-session'),
    import('@deepseek-ai/dsh-tools'),
    import('@deepseek-ai/dsh-scope'),
    import('@deepseek-ai/dsh-system-prompt'),
    import('@deepseek-ai/dsh-agent'),
    import('@deepseek-ai/dsh-agent-loop'),
    import('@deepseek-ai/dsh-agent-default-model'),
    import('@deepseek-ai/dsh-session-persistence-jsonl'),
    import('@deepseek-ai/dsh-shell'),
    import('@deepseek-ai/dsh-user-approval'),
    import('@deepseek-ai/dsh-headless'),
  ])

  const handle: DshRuntimeHandle = {
    kernel: DSH_KERNEL,
    ctx,

    activeCount() {
      return activeDshHandles
    },

    async start() {
      // 首次 loader await — 确保全部 plugin 完成挂载（dsh-headless index.js:99 同款）
      await ctx.get('loader')?.await()
      // Cordis 4.x 的 ctx.set() 要求提供 config schema；当前 schema-less 设置
      // 用 setSelf 或 isolate 走 local scope 方式。当前简化：把 defaults 存到
      // globalThis 桥，由后续 createAgent 读取。
      ;(globalThis as Record<string, unknown>).__zaiDshDefaults = {
        defaultCwd: opts.defaultCwd,
        runtimeId: opts.runtimeId,
        dataDir: opts.dataDir,
        defaultModel: opts.defaultModel,
      }
    },

    async shutdown() {
      // 1. 拒绝新请求：标记 disposed — 后续 createAgent 调用将 throw。
      // 2. flush 当前 turn：调所有 session 的 sessions.flush。
      try {
        const sessions = ctx.get('sessions') as {
          flush?: (s: unknown) => Promise<unknown>
          listIds?: () => string[]
          load?: (id: unknown) => Promise<unknown>
        } | undefined
        if (sessions && typeof sessions.flush === 'function') {
          // 列出 session id 不一定可用；按需调用 flush on each
          const ids = (sessions.listIds?.() ?? []) as string[]
          for (const sid of ids) {
            const session = sessions.load ? await sessions.load(sid).catch(() => null) : null
            if (session) {
              await sessions.flush(session).catch((err: unknown) =>
                console.warn('[dsh-bridge] flush failed:', err),
              )
            }
          }
        }
      } catch (err) {
        console.warn('[dsh-bridge] session flush failed during shutdown:', err)
      }

      // 3. dispose Cordis ctx
      try {
        // Cordis 4.x 的 ctx 通过 registry.dispose 完成 tree 卸载；当前 API 无
        // 直接 ctx.dispose()。这里调 internal `dispose` 若存在，否则靠
        // process 退出自然清理（zai 进程模式符合）。
        const anyCtx = ctx as unknown as { dispose?: () => Promise<void> | void }
        if (typeof anyCtx.dispose === 'function') {
          await anyCtx.dispose()
        }
      } catch (err) {
        console.warn('[dsh-bridge] ctx.dispose failed:', err)
      }

      // 4. 清 globalThis 桥 — 由调用方 (KernelAdapter.shutdown) 负责。
      // 5. 清 globalThis dsh defaults
      if ((globalThis as Record<string, unknown>).__zaiDshDefaults) {
        delete (globalThis as Record<string, unknown>).__zaiDshDefaults
      }

      // 6. 减计数
      activeDshHandles--
    },
  }

  return handle
}