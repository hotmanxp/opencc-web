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
  listSessions(): Promise<TranscriptMeta[]>
  readSession(transcriptId: string): Promise<TranscriptFile>
  patchSession(transcriptId: string, patch: { title?: string; tags?: string[] }): Promise<void>
  removeSession(transcriptId: string): Promise<void>
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

  listSessions(): Promise<TranscriptMeta[]> {
    return this.store.list()
  }

  readSession(transcriptId: string): Promise<TranscriptFile> {
    return this.store.read(transcriptId)
  }

  patchSession(transcriptId: string, patch: { title?: string; tags?: string[] }): Promise<void> {
    return this.store.patch(transcriptId, patch)
  }

  removeSession(transcriptId: string): Promise<void> {
    return this.store.remove(transcriptId)
  }
}
