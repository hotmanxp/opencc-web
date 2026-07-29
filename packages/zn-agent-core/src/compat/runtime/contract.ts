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
import { runViaOpenccQuery } from './openccQueryBridge.js'
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
   * Two backends, env-gated (Phase 5 close-out):
   *
   * - **Default — Phase 1.b bypass** (`runOpenccQuery` in `./openccAdapter.ts`):
   *   Calls zai's own `modelCaller` (Anthropic SDK) directly and runs
   *   `tool.call()` with the compat tools. Skips opencc vendor entirely.
   *   Runtime-agnostic (works under Node/tsx + Bun). This is the path all
   *   current users hit — proven stable.
   *
   * - **Bridge — `runViaOpenccQuery`** (`./openccQueryBridge.ts`):
   *   Lazy-imports `opencc-src/query.js` (vendor), translates zai
   *   `QueryOptions → opencc QueryParams`, attaches 5 wrapped core tools
   *   (`defaultCoreToolsAsOpencc()`), and streams `SDKMessage → RuntimeEvent`.
   *   Requires `tsx --import ./bun-protocol.mjs` (or vite alias) so the
   *   `bun:` protocol resolves to the shim. Bridge yields a single
   *   `runtime.error` event on import failure, so a misconfigured runtime
   *   fails loudly rather than hanging.
   *
   * Switch: set `ZAI_OPENCC_BRIDGE=1` (or `'true'`) before constructing
   * the runtime. Off by default to preserve the Phase 1.b behavior.
   */
  run(opts: QueryOptions): AsyncIterable<RuntimeEvent> {
    // openccConfig is the optional subset of this.config that the adapter consumes.
    // Cast is safe because the adapter only reads known fields (mcpPool, hookRunner, etc.)
    const openccConfig = (this.config as any).openccConfig ?? {}
    const useBridge =
      process.env.ZAI_OPENCC_BRIDGE === '1' ||
      process.env.ZAI_OPENCC_BRIDGE === 'true'
    return useBridge
      ? runViaOpenccQuery(opts, openccConfig)
      : runOpenccQuery(opts, openccConfig)
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
