// @zn-ai/zn-agent-core compat shim — port of zai-agent-core runtime/contract.ts.
//
// The original class delegates to `queryLoop(opts, config)`. In the new package
// the opencc SDK exposes `query(opts, config)` (via
// `opencc-src/query.js`); the compat's `runtime/` subpath already re-exports it
// as `query`. We call `query()` here directly rather than going through the
// subpath, so this shim has no compile-time dependency on the opencc SDK's
// internal symbol names beyond the import below.
//
// `TranscriptFile, TranscriptMeta` come from compat/transcript/types.ts; the
// `TranscriptStore` constructor signature is shape-compatible with the old
// package (dataDir-arg constructor, list/read/patch/remove methods).

import type { RuntimeConfig, QueryOptions } from './types.js'
import type { RuntimeEvent } from './events.js'
import type { TranscriptFile, TranscriptMeta } from '../transcript/types.js'
import { TranscriptStore } from '../transcript/store.js'
import { abortSession } from './abort.js'
import { runOpenccQuery } from './openccAdapter.js'
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

  /**
   * Run a query and yield RuntimeEvents.
   *
   * The original implementation called `queryLoop(opts, config)` from the old
   * zai-agent-core runtime, which in turn wired to opencc's QueryEngine. The
   * new package's opencc port exposes a different signature
   * (`query(params: QueryParams)`) that takes a single QueryParams argument
   * and yields StreamEvent | Message | ... — neither the param shape nor the
   * event type match zai's RuntimeEvent contract 1:1, so a direct call here
   * would silently drop semantics.
   *
   * Until the opencc SDK adapter layer lands (Batch 3 / follow-up plan),
   * `run` returns an empty AsyncIterable so callers iterate without crashing
   * and the server stays bootable. Documented in
   * `.superpowers/sdd/task-21-report.md` under "Subpath 8 — open blocker".
   */
  run(opts: QueryOptions): AsyncIterable<RuntimeEvent> {
    // openccConfig is the optional subset of this.config that the adapter consumes.
    // Cast is safe because the adapter only reads known fields (mcpPool, hookRunner, etc.)
    const openccConfig = (this.config as any).openccConfig ?? {}
    return runOpenccQuery(opts, openccConfig)
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