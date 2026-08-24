import type { Context, AgentToolParentAgent } from '@zn-ai/dsh-bridge'
import { DshSubagentControlAdapter, DshJobsControlAdapter } from '@zn-ai/dsh-bridge'
import type { SeamRegistry } from './seamRegistry.js'

/**
 * 把 dsh-bridge adapters 绑定到 SeamRegistry。
 *
 * 调用时机:kernel factory 创建 DSH runtime 后(zai-side `factories/dsh.ts`)立即调。
 * 失败 fail loud — 缺失 dsh-bridge adapters 抛 `MissingVendorSeamError`。
 */

export interface BindSeamsOpts {
  registry: SeamRegistry
  ctx: Context
  eventBus: { emit: (e: unknown) => void }
  getParentAgent: (sessionId: string) => AgentToolParentAgent | undefined
}

export function bindSeams(opts: BindSeamsOpts): void {
  const subagent = new DshSubagentControlAdapter({
    ctx: opts.ctx,
    // DshSubagentAdapterOptions.getParentAgent expects Agent from @deepseek-ai/dsh-agent
    // which zai doesn't import directly. Use any to bypass.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getParentAgent: opts.getParentAgent as any,
    eventBus: opts.eventBus,
  })
  const jobs = new DshJobsControlAdapter({
    ctx: opts.ctx,
  })
  opts.registry.register('subagent', subagent)
  opts.registry.register('jobs', jobs)
}
