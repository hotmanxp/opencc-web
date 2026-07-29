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

// ─── state/store.js ───────────────────────────────────────────────────
export function createAppStore() { return {} }
export function getStateStore() { return {} }

// ─── integrations/routeMetadata.js ────────────────────────────────────
export const ROUTE_METADATA: Record<string, unknown> = {}
export function getRouteMetadata() { return null }

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
