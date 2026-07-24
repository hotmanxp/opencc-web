import type { RuntimeConfig, QueryOptions } from './types.js'
import type { RuntimeEvent } from './events.js'
import type { TranscriptFile, TranscriptMeta } from '../transcript/types.js'
import { TranscriptStore } from '../transcript/store.js'
import { queryLoop } from './queryLoop.js'
import { abortSession } from './abort.js'
import { DefaultPluginRuntime } from '../plugins/index.js'

export interface AgentRuntime {
  run(opts: QueryOptions): AsyncIterable<RuntimeEvent>
  abort(sessionId: string, reason?: string): Promise<void>
  listSessions(opts?: { cwd?: string; excludeSubagent?: boolean; includeSubagent?: boolean }): Promise<TranscriptMeta[]>
  readSession(transcriptId: string, opts: { cwd: string; subagent?: boolean }): Promise<TranscriptFile>
  patchSession(transcriptId: string, patch: { title?: string; tags?: string[] }, opts: { cwd: string; subagent?: boolean }): Promise<void>
  removeSession(transcriptId: string, opts: { cwd: string; subagent?: boolean }): Promise<void>
}

export class DefaultAgentRuntime implements AgentRuntime {
  private store: TranscriptStore

  constructor(private config: RuntimeConfig) {
    this.store = new TranscriptStore(config.dataDir)
    if (!config.pluginRuntime && config.plugins) {
      config.pluginRuntime = new DefaultPluginRuntime(config.plugins)
    }
  }

  run(opts: QueryOptions): AsyncIterable<RuntimeEvent> {
    return queryLoop(opts, this.config)
  }

  async abort(sessionId: string, reason?: string): Promise<void> {
    await abortSession(this.config, sessionId, reason)
  }

  listSessions(opts?: { cwd?: string; excludeSubagent?: boolean; includeSubagent?: boolean }): Promise<TranscriptMeta[]> {
    return this.store.list(opts)
  }

  readSession(transcriptId: string, opts: { cwd: string; subagent?: boolean }): Promise<TranscriptFile> {
    return this.store.read(transcriptId, opts)
  }

  patchSession(transcriptId: string, patch: { title?: string; tags?: string[] }, opts: { cwd: string; subagent?: boolean }): Promise<void> {
    return this.store.patch(transcriptId, patch, opts)
  }

  removeSession(transcriptId: string, opts: { cwd: string; subagent?: boolean }): Promise<void> {
    return this.store.remove(transcriptId, opts)
  }
}
