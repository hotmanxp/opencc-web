/**
 * openccQueryBridge — wraps opencc's vendored `query()` so zai can call it
 * from DefaultAgentRuntime.run() with zai-style QueryOptions.
 *
 * Status: Phase 5 scaffold. The full bridge (zai → opencc QueryParams,
 * opencc QueryEvents → zai RuntimeEvent translation) is large — the opencc
 * query() signature requires:
 *   - Message[] (Anthropic SDK message array, not just user prompt)
 *   - SystemPrompt (opencc's structured form)
 *   - canUseTool: CanUseToolFn (permission gate; zai has its own)
 *   - toolUseContext: ToolUseContext (20+ fields including setAppState /
 *     setToolJSX / readFileState / abortController etc.)
 *   - querySource: QuerySource (top-level vs subagent)
 *   - deps: QueryDeps (mcpServers, skills, sandbox, plugins, etc.)
 *
 * Until those are fully mapped, this bridge is a noop that yields one
 * runtime.error event explaining the gap. The contract.ts fallthrough
 * routes callers to compat/openccAdapter.ts as before.
 *
 * The companion file `sdkEventAdapter.ts` has the full Message →
 * RuntimeEvent shape mapping for when the bridge becomes live.
 */

import type { QueryOptions, OpenccAdapterConfig } from './types.js'
import type { RuntimeEvent } from './events.js'

export async function* runViaOpenccQuery(
  opts: QueryOptions,
  _config: OpenccAdapterConfig,
): AsyncIterable<RuntimeEvent> {
  const sessionId = opts.sessionId ?? opts.transcriptId ?? 'unknown'

  // Phase 5 scaffolding: surface a clear error so the contract.ts
  // try/catch falls back to compat/openccAdapter.ts. The bridge code
  // path will be filled in once zai-side tests expose the minimal
  // opencc QueryParams surface we actually need.
  yield {
    type: 'runtime.error',
    eventId: `evt-opencc-bridge-stub`,
    sessionId,
    turnIndex: 0,
    ts: Date.now(),
    message:
      '[zn-agent-core] openccQueryBridge is a Phase 5 stub — full bridge not yet implemented. ' +
      'DefaultAgentRuntime.run() will fall back to compat/openccAdapter.ts.',
    errorCategory: 'not_implemented',
  } as RuntimeEvent
}