/**
 * Hand-stub for opencc-src directories that copy-from-opencc strips
 * (see strip-list.ts: components, ink, state, memdir, coordinator,
 * integrations, services/autoDream, services/autoFix, etc.).
 *
 * Most of these are runtime dead code in zai:
 *   - memdir:    opencc's memory directory system (zai has its own)
 *   - coordinator: opencc's multi-agent coordinator (zai uses BackgroundRuntime)
 *   - state:     opencc's React-coupled AppState (zai has its own Zustand)
 *   - ink:       opencc's CLI TUI primitives (zai has React web UI)
 *   - components, screens, buddy, vim, voice, etc.: CLI/UI surfaces
 *
 * The strip list is applied at vendoring time (see
 * packages/zn-agent-core/scripts/copy-from-opencc.ts), but opencc's
 * transitive imports still reference these stripped paths as
 * "zombie" imports. This file's exports satisfy every name the hot
 * opencc runtime path actually reads, so the bridge can reach
 * deps.callModel without alias gymnastics per file.
 *
 * Each stub returns a safe default that lets the calling code skip
 * the stripped feature. Where a function is critical (e.g.
 * `loadMemoryPrompt`), the return is an empty string so the prompt
 * builder doesn't error but the runtime behavior is "no memory".
 *
 * Updated as new symbols surface during smoke tests. Each export is
 * kept narrow so the stub stays a leaf — if zai ever wants to
 * implement one of these properly, the call sites don't change.
 *
 * The vitest alias (vitest.config.ts) routes any `*.js` import whose
 * first non-`../` segment matches a stripped directory to this stub.
 */

// ─── memdir/paths.js ──────────────────────────────────────────────────
export function getAutoMemPath() { return '/tmp/zai-memdir/auto' }
export function getMemoryBaseDir() { return '/tmp/zai-memdir' }
export function isAutoMemoryEnabled() { return false }
export function isAutoMemPath() { return false }
export function hasAutoMemPathOverride() { return false }
export function getAutoMemEntrypoint() { return null }
export function isExtractModeActive() { return false }

// ─── memdir/memdir.js ──────────────────────────────────────────────────
export async function loadMemoryPrompt() { return '' }
export async function buildMemoryPrompt() { return '' }
export async function ensureMemoryDirExists() { /* noop */ }
export function truncateEntrypointContent(content: string) { return content }

// ─── coordinator/coordinatorMode.js ──────────────────────────────────
export function isCoordinatorMode() { return false }
export function getCoordinatorUserContext() { return {} }
export function getCoordinatorSystemPrompt() { return '' }

// ─── ink/ — opencc's TUI primitives. We don't render Ink in zai, but
// transitive imports still reach for these names.
export function stringWidth(_s: string): number { return 0 }
export function supportsHyperlinks(_stream: unknown): boolean { return false }
export function wrapAnsi(_s: string, _opts?: unknown): string { return _s }
export type RenderOptions = unknown
export type TextProps = unknown
export interface TerminalNotification { type: string; message: string }
export const Key = { ENTER: 'enter', ESCAPE: 'escape', TAB: 'tab' } as const

// ─── state/store.js ───────────────────────────────────────────────────
export function createAppStore() { return {} }
export function getStateStore() { return {} }

// ─── integrations/routeMetadata.js ────────────────────────────────────
export const ROUTE_METADATA: Record<string, unknown> = {}
export function getRouteMetadata() { return null }

// ─── services/analytics/index.js ──────────────────────────────────────
// opencc vendor's `services/analytics/` directory is missing the
// `index.ts` barrel, but transitive imports still reference it.
// These names are imported across the codebase:
export function logEvent(_event: string, _props?: unknown): void { /* noop */ }
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = unknown
export function getDynamicConfig_BLOCKS_ON_INIT() { return {} }
export function getFeatureValue_CACHED_MAY_BE_STALE(_flag: string, _defaultValue?: unknown) {
  return false
}
export function getFileExtensionForAnalytics(_path: string): string {
  return ''
}
export function isAnalyticsDisabled(): boolean { return true }
export function sanitizeToolNameForAnalytics(_name: string): string { return _name }

// ─── services/SessionMemory/prompts.js ────────────────────────────────
export const SESSION_MEMORY_PROMPTS: Record<string, string> = {}

// ─── services/SessionMemory/sessionMemoryUtils.js ─────────────────────
export function isSessionMemoryEmpty() { return true }
export function truncateSessionMemoryForCompact(content: string) {
  return content
}
export function setLastSummarizedMessageId(_id: string) { /* noop */ }
export function getLastSummarizedMessageId() { return null }
export function getSessionMemoryContent() { return '' }
export async function waitForSessionMemoryExtraction() { /* noop */ }

// ─── services/autoFix/autoFixConfig.js ────────────────────────────────
export const AUTO_FIX_CONFIG = {
  enabled: false,
  rules: [],
}
export function getAutoFixConfig() { return AUTO_FIX_CONFIG }
export const AutoFixConfigSchema = { parse: (x: unknown) => x }

// ─── services/autoFix/autoFixHook.js ─────────────────────────────────
export function shouldRunAutoFix() { return false }
export function buildAutoFixContext() { return {} }

// ─── services/autoFix/autoFixRunner.js ──────────────────────────────
export async function runAutoFixCheck() { return { triggered: false } }

// ─── utils/processUserInput/processUserInput.js ──────────────────────
export async function processUserInput(_input: unknown, _ctx?: unknown) {
  // Returns void in the original; consumers don't read the return.
  return
}
export interface ProcessUserInputContext {
  cwd?: string
  abortSignal?: AbortSignal
}

// ─── services/remoteManagedSettings — opencc's cloud-managed
// settings sync. zai uses its own settings loader (zai has no
// cloud-managed settings feature). Stub every name.
export function getRemoteManagedSettingsSyncFromCache(): null { return null }
export function isRemoteManagedSettingsEligible(): boolean { return false }
export function getRemoteManagedSettingsSyncCacheKey(): string { return '' }
export function setRemoteManagedSettingsSyncCache(_state: unknown): void { /* noop */ }
export function clearRemoteManagedSettingsSyncCache(): void { /* noop */ }
export function fetchRemoteManagedSettingsSync(): null { return null }

// ─── services/teamMemorySync — opencc's team memory sync. zai
// doesn't use this; stub every transitive name.
export function getTeamMemorySyncFromCache(): null { return null }
export function isTeamMemorySyncEligible(): boolean { return false }
export function fetchTeamMemorySync(): null { return null }

// ─── services/AgentSummary — opencc's agent summary aggregation.
// Stub names imported transitively.
export function getAgentSummaryFromCache(): null { return null }
export function isAgentSummaryEligible(): boolean { return false }
export function fetchAgentSummary(): null { return null }

// ─── services/SessionMemory — opencc's session memory persistence.
// Stub names imported transitively. (isSessionMemoryEmpty,
// truncateSessionMemoryForCompact, setLastSummarizedMessageId,
// getLastSummarizedMessageId, getSessionMemoryContent, and
// waitForSessionMemoryExtraction are already stubbed above.)
export function getSessionMemoryFromCache(_id: string): null { return null }

// ─── services/MagicDocs / wiki / extractMemories / goal / autoDream /
// autoFix / PromptSuggestion / voice — opencc's optional feature
// services. Stub the names opencc vendor's transitive imports reach.
export function getMagicDocsCache(): null { return null }
export function isMagicDocsEligible(): boolean { return false }
export function fetchMagicDocs(): null { return null }
export function getWikiCache(): null { return null }
export function fetchWiki(): null { return null }
export function getExtractMemoriesCache(): null { return null }
export function fetchExtractMemories(): null { return null }
export function getGoalCache(): null { return null }
export function fetchGoal(): null { return null }
export function getAutoDreamCache(): null { return null }
export function fetchAutoDream(): null { return null }
export function getAutoFixCache(): null { return null }
export function fetchAutoFix(): null { return null }
export function getPromptSuggestionCache(): null { return null }
export function fetchPromptSuggestion(): null { return null }
export function getVoiceCache(): null { return null }
export function fetchVoice(): null { return null }
export function getGithubCache(): null { return null }
export function fetchGithub(): null { return null }
export function getSettingsSyncCache(): null { return null }
export function fetchSettingsSync(): null { return null }

// ─── remoteManagedSettings/syncCache.js — same dir, different file.
export function getRemoteManagedSettingsSyncFromCache_v2(): null { return null }

// ─── integrations/routeMetadata — opencc's route table for
// integrations. zai doesn't use this. Stub names imported
// transitively. (ROUTE_METADATA, getRouteMetadata are already
// stubbed above.)
export function getTransportKindForRoute(_route: string): string { return '' }
export function resolveActiveRouteIdFromEnv(_env: unknown): string { return '' }

// ─── default export: Proxy fallback for any name not explicitly
// stubbed above. opencc vendor transitive imports frequently reach for
// names we haven't enumerated. The Proxy makes every missing name
// return a safe no-op callable / empty object / empty array so the
// import resolves and downstream code doesn't crash.
//
// This is best-effort: it covers DEFAULT imports but not NAMED
// imports (ESM named bindings are static). For named imports, see
// the explicit exports above.
const _stubDefault = {
  // Placeholder; the actual default export is below.
}

export default new Proxy(_stubDefault, {
  get(_target, prop: string | symbol) {
    if (typeof prop === 'symbol') return undefined
    if (prop in _stubDefault) return (_stubDefault as any)[prop]
    // Return a callable no-op for function-like access; consumers
    // can call it and get `undefined` back, which is the safe
    // default for analytics/config getters.
    return (..._args: unknown[]) => undefined
  },
  has(_target, prop: string | symbol) {
    return true
  },
})
