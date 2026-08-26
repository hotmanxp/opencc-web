/**
 * SessionHostRuntimeAdapter —— 把 `OpenccRuntime` 8 方法契约适配到 B1
 * 路径(spawn `opencc -p` 子进程)。
 *
 * 落点(spec §8 适配表):
 * - `query` / `abort` → SessionRegistry 的子进程 stdio(惟二需跨进程的调用)
 * - `getSession` / `listSessions` / `readTranscript` / `patchSession` /
 *   `removeSession` → sessionFacade 本地 JSONL(不经过子进程)
 * - `shutdown` → SessionRegistry.killAll()
 * - `plugins` → Phase A 最小 stub(routes/plugins.ts 不 500;完整 plugin API
 *   由 zai 内 PluginRuntime 承接,Phase B/F 落地)
 *
 * `OpenccRuntime` 契约不动(serverTypes.ts),zai `getRuntime()` 调用方
 * (routes/agent.ts / backgroundRuntime.ts / agentRuntime.ts)全部继续工作。
 */

import type {
  OpenccQueryInput,
  OpenccRuntime,
  OpenccServerEvent,
  OpenccTranscriptFile,
  OpenccTranscriptMeta,
} from '@zn-ai/zn-agent-core'
import { createSessionFacade } from '@zn-ai/zn-agent-core'
import type { SessionRegistry } from '../sessionHost/SessionRegistry.js'

type SessionFacade = Awaited<ReturnType<typeof createSessionFacade>>

export class SessionHostRuntimeAdapter implements OpenccRuntime {
  private readonly facade: SessionFacade
  private readonly cwd: string

  constructor(
    private readonly registry: SessionRegistry,
    facade: SessionFacade,
    cwd: string,
  ) {
    this.facade = facade
    this.cwd = cwd
  }

  async *query(
    input: OpenccQueryInput,
  ): AsyncIterable<OpenccServerEvent> {
    const host = this.registry.getOrSpawn(input.sessionId, {
      cwd: input.cwd ?? this.cwd,
      model: input.model,
    })
    // forwardQuery 产出 RuntimeEvent(Anthropic primitives + zai meta 字段),
    // 与 legacy query() 的产出词汇一致 —— 上层 translateRuntimeEvents 零改动。
    yield* host.forwardQuery(input)
  }

  async abort(sessionId: string, reason?: string): Promise<void> {
    await this.registry.get(sessionId)?.abort(reason)
  }

  async getSession(sessionId: string): Promise<OpenccTranscriptMeta | null> {
    const info = await this.facade.get(sessionId, { cwd: this.cwd })
    // legacy impl 同样直接 cast(facade SessionInfo ↔ OpenccTranscriptMeta 形状
    // 存在偏移,调用方当前只读其中公共字段)。
    return info as unknown as OpenccTranscriptMeta | null
  }

  async listSessions(
    opts?: { cwd?: string },
  ): Promise<OpenccTranscriptMeta[]> {
    const list = await this.facade.list({ cwd: opts?.cwd ?? this.cwd })
    return list as unknown as OpenccTranscriptMeta[]
  }

  readTranscript(sessionId: string): Promise<OpenccTranscriptFile> {
    return this.facade.readTranscript(sessionId) as unknown as Promise<OpenccTranscriptFile>
  }

  async patchSession(
    sessionId: string,
    patch: { title?: string; tags?: string[] },
  ): Promise<void> {
    await this.facade.patchSession(sessionId, patch as never)
  }

  async removeSession(sessionId: string): Promise<void> {
    this.registry.kill(sessionId, 'session removed')
    await this.facade.removeSession(sessionId)
  }

  async shutdown(): Promise<void> {
    await this.registry.killAll('runtime.shutdown')
  }

  plugins: OpenccRuntime['plugins'] = createPluginStub()
}

/**
 * Phase A 最小 plugin stub:所有方法返回空/成功+警告,保证 routes/plugins.ts
 * 在 B1 路径不 500。Phase B/F 把 plugin API 接到 zai 的 PluginRuntime。
 */
function createPluginStub(): OpenccRuntime['plugins'] {
  const UNSUPPORTED = 'opencc-cli runtime 下 plugin API 未接入(Phase B+ 落地)'
  return {
    async listInstalled() {
      console.warn('[SessionHostRuntimeAdapter] plugins.* 未接入:', UNSUPPORTED)
      return { plugins: [], errors: [] }
    },
    async listAvailable() {
      console.warn('[SessionHostRuntimeAdapter] plugins.* 未接入:', UNSUPPORTED)
      return []
    },
    async setEnabled() {
      return { success: false, message: UNSUPPORTED }
    },
    async install() {
      return { success: false, message: UNSUPPORTED }
    },
    async uninstall() {
      return { success: false, message: UNSUPPORTED }
    },
    async update() {
      return { success: false, message: UNSUPPORTED }
    },
    async reload() {
      return { success: true, message: UNSUPPORTED }
    },
    async listMarketplaces() {
      console.warn('[SessionHostRuntimeAdapter] plugins.* 未接入:', UNSUPPORTED)
      return []
    },
    async addMarketplace() {
      return { success: false, message: UNSUPPORTED }
    },
  }
}