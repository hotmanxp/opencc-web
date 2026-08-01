/**
 * openccInit — bridges opencc vendor's startup sequence into zai's boot
 * path. opencc vendor's `entrypoints/init.ts` runs ~21 startup steps; this
 * module re-implements the ones zai-server needs in the same order.
 *
 * Step coverage (per opencc's entrypoints/init.ts):
 *
 *   [x] 1.  installMacroStub()              — pre-populates globalThis.MACRO
 *       2.  enableConfigs()                  — calls bundle.enableConfigs()
 *       3.  setIsNonInteractive(true)        — compat-side; STATE.isInteractive=false
 *       4.  setOriginalCwd(cwd)              — bundle
 *       5.  setCwdState(cwd)                 — bundle
 *       6.  setSessionId(id)                 — SKIPPED (per-request, not global)
 *       7.  setClientType('zai-server')      — bundle
 *       8.  applySafeConfigEnvironmentVariables()  — compat-side (read ~/.zai/settings.json env)
 *       9.  applyExtraCACertsFromConfig()    — compat-side (NODE_EXTRA_CA_CERTS from settings)
 *      10.  setupGracefulShutdown()          — bundle
 *      11.  configureGlobalMTLS()            — SKIPPED (no bundle export; MTLS not in scope)
 *      12.  configureGlobalAgents()          — bundle
 *      13.  applyConfigEnvironmentVariables()       — compat-side (full env, trust-gated)
 *      14.  preconnectAnthropicApi()         — SKIPPED (optional perf win)
 *
 * Skipped items are deliberate:
 *  - setSessionId is per-session (randomUUID generated when each session starts)
 *  - configureGlobalMTLS requires the bundle's axios + undici stack; zai uses
 *    Anthropic SDK which configures its own agents on first call
 *  - preconnectAnthropicApi is a fire-and-forget TCP warmup; harmless to skip
 *
 * Imported lazily on first call to avoid pulling the opencc vendor
 * bundle (~18MB) into the zai-server boot path before needed.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Imported via the package's `./opencc-core` subpath export (see
// package.json `exports`). All opencc vendor code is bundled into
// this single .mjs by scripts/bundle-opencc.ts.
const BUNDLE_URL = '@zn-ai/zn-agent-core/opencc-core'

/**
 * zai patch: pre-populate `globalThis.MACRO` before the opencc bundle
 * evaluates. vendor's built-time macro substitutions are normally
 * injected via `bun --define MACRO=...` (see opencc-src/main.tsx:2554,
 * utils/sessionStorage.ts:100, tools/AgentTool/built-in/
 * claudeCodeGuideAgent.ts:94 and 181 other unrguarded call sites).
 * zai-server doesn't pass `--define`, so the first time vendor code
 * touches `MACRO.VERSION` (e.g. when the bridge yields
 * `claudeCodeGuideAgent.prompt` for an Explore sub-agent's system
 * prompt at runAgent.ts:1011) we hit `ReferenceError: MACRO is not
 * defined` and the user gets `<tool_result>MACRO is not
 * defined</tool_result>` for every sub-agent dispatch.
 *
 * Injecting a runtime stub here — before the dynamic-import of the
 * bundle — guarantees the global is in place when bundle evaluation
 * encounters those 182 unrguarded MACRO.X references. Three vendor
 * sites already use `typeof MACRO !== 'undefined' ? MACRO.X :
 * 'unknown'` (utils/doctorDiagnostic.ts:599, utils/sessionStorage.ts:
 * 100, commands/insights.ts:2507) — those would degrade gracefully;
 * the rest throw if MACRO isn't defined. The stub covers all 9
 * fields discovered via `grep -rho "MACRO\\.[A-Z_]\\+" src/opencc-src
 * | sort -u`.
 *
 * Values mirror what zai's product surface exposes:
 *   - VERSION: this package's own version (we are the vendor from
 *     zai-server's perspective — main.tsx:2554 treats MACRO.VERSION
 *     as the running product's identifier)
 *   - others: simple fallback strings / booleans; revisit when
 *     /feedback command is wired through.
 */
export function installMacroStub(): void {
  const g = globalThis as any
  if (g.MACRO && typeof g.MACRO === 'object' && typeof g.MACRO.VERSION === 'string') {
    return
  }
  // zai's own pkg version is a reasonable proxy; build-time
  // reflection isn't worth the bundle-size cost here.
  const VERSION = '0.1.0'
  const DISPLAY_VERSION = '0.1.0'
  const BUILD_TIME = new Date().toISOString()
  const IS_DEVELOPMENT_BUILD = true
  const PACKAGE_URL = 'https://www.npmjs.com/package/@zn-ai/zn-agent-core'
  const ISSUES_EXPLAINER =
    '请通过 `/feedback` 命令提交 bug 或建议,或在仓库 issue tracker 中报告。'
  const FEEDBACK_CHANNEL = '/feedback'
  const VERSION_CHANGELOG =
    'https://github.com/zn-ai/opencc-web/blob/main/packages/zn-agent-core/CHANGELOG.md'
  g.MACRO = {
    VERSION,
    DISPLAY_VERSION,
    BUILD_TIME,
    IS_DEVELOPMENT_BUILD,
    PACKAGE_URL,
    // ant-only field; absent in zai builds. Use undefined rather
    // than '' so truthy-checks (e.g. `if (MACRO.NATIVE_PACKAGE_URL)`)
    // behave the same as if the global hadn't been populated.
    NATIVE_PACKAGE_URL: undefined,
    ISSUES_EXPLAINER,
    FEEDBACK_CHANNEL,
    VERSION_CHANGELOG,
  }
}

// ----- compat-side re-implementations of un-exported startup steps -----

/**
 * Step 3. Set `STATE.isInteractive = false` so opencc code paths that
 * branch on `getIsNonInteractiveSession()` (Ink UI dialogs, prompts,
 * notifications — 83 callers across the vendor tree) take the
 * headless / non-interactive branch. opencc vendor's main.tsx calls
 * `setIsInteractive(false)` when it detects `!process.stdin.isTTY`
 * (or `--print` / piped output); zai is a non-interactive HTTP server
 * with no TTY at all, so we set it unconditionally.
 *
 * The vendor STATE singleton lives inside the bundle (opencc-src/
 * bootstrap/state.ts:307, default isInteractive: false). The bundle
 * exports `setIsInteractive` / `setClientType` / etc., but
 * `setIsNonInteractive` is NOT exported. Easiest compat impl: read
 * the existing STATE through `getIsInteractive` and call
 * `setIsInteractive(false)` via the bundle export. We do that
 * inside `enableOpenccConfigs()` after the bundle is loaded.
 *
 * Exposed separately so tests can call it without the bundle (e.g.
 * to pin the helper signature).
 */
export function setZaiIsNonInteractive(): void {
  const g = globalThis as any
  // The bundle may not be loaded yet (e.g. test-only path). Fall back
  // to setting the flag directly on globalThis so any state.ts access
  // before bundle evaluation still sees the headless mode. Once the
  // bundle is loaded, `enableOpenccConfigs` calls the bundle's
  // `setIsInteractive(false)` to keep the vendor STATE in sync.
  if (!g.__zaiIsNonInteractive) {
    g.__zaiIsNonInteractive = true
  }
}

/**
 * Step 8 / 13 — apply environment variables from
 * `~/.zai/settings.json → env` to `process.env`.
 *
 * Vendor's `applySafeConfigEnvironmentVariables()` reads from
 * `getGlobalConfig()` (~/.claude.json) and `getSettingsForSource('userSettings')`
 * (~/.claude/settings.json). zai stores its own settings at
 * `~/.zai/settings.json` (see packages/zai/src/shared/settings.ts
 * `ZaiSettings`), so we can't directly call the vendor function even
 * if it were exported — the path layout differs.
 *
 * Re-implement the env-application semantics here with two modes:
 *
 *   `safe` (default for first pass before trust dialog):
 *     Only apply env vars that aren't already set on process.env. This
 *     mirrors vendor's safe-mode priority — process.env wins over
 *     settings. Returns the list of keys applied.
 *
 *   `full` (post-trust, optional second pass):
 *     Apply ALL env vars from settings, overwriting process.env.
 *     Matches vendor's `applyConfigEnvironmentVariables()` semantics.
 *     zai-server doesn't currently use this (no trust dialog); keep
 *     available so /settings + future trust-gated flows can opt in.
 *
 * Both modes silently no-op when settings.json is missing or
 * malformed — startup should not fail on a corrupt settings file.
 */
type SettingsEnvShape = Record<string, string | undefined>
type SettingsShape = {
  env?: SettingsEnvShape
  [k: string]: unknown
}

export function readZaiSettingsEnv(): SettingsEnvShape {
  const home = homedir()
  const dataDir = process.env.ZAI_DATA_DIR ?? join(home, '.zai')
  const settingsPath = join(dataDir, 'settings.json')
  if (!existsSync(settingsPath)) return {}
  try {
    const raw = readFileSync(settingsPath, 'utf8')
    if (!raw.trim()) return {}
    const parsed = JSON.parse(raw) as SettingsShape
    const env = parsed?.env
    if (!env || typeof env !== 'object') return {}
    // Coerce unknown value types to string (matches vendor behavior of
    // treating settings.env as Record<string, string>).
    const out: SettingsEnvShape = {}
    for (const [k, v] of Object.entries(env)) {
      if (v === null || v === undefined) continue
      out[k] = String(v)
    }
    return out
  } catch {
    // Corrupt JSON — log and move on. Vendor's parseSettingsFile
    // returns null on schema validation failure; we don't have a
    // schema, but JSON.parse failure is the only way to bail here.
    return {}
  }
}

/**
 * Apply env vars from ~/.zai/settings.json to process.env with the
 * "safe" priority rules (process.env wins; settings fills only
 * missing keys). Returns the list of keys applied.
 */
export function applySafeZaiSettingsEnv(): string[] {
  const settingsEnv = readZaiSettingsEnv()
  const applied: string[] = []
  for (const [key, value] of Object.entries(settingsEnv)) {
    if (value === undefined) continue
    if (process.env[key] === undefined) {
      process.env[key] = value
      applied.push(key)
    }
  }
  return applied
}

/**
 * Apply env vars from ~/.zai/settings.json to process.env with the
 * "full" / trust-gated semantics — overwrites process.env with
 * settings.env values. Caller must have ensured trust has been
 * granted before invoking. zai-server currently doesn't run a
 * trust dialog; exposed for future trust flows.
 */
export function applyZaiSettingsEnvFull(): string[] {
  const settingsEnv = readZaiSettingsEnv()
  const applied: string[] = []
  for (const [key, value] of Object.entries(settingsEnv)) {
    if (value === undefined) continue
    process.env[key] = value
    applied.push(key)
  }
  return applied
}

/**
 * Step 9 — apply NODE_EXTRA_CA_CERTS from settings.json. Vendor's
 * `applyExtraCACertsFromConfig()` reads the same path but writes to
 * `process.env.NODE_EXTRA_CA_CERTS`. We replicate that logic for
 * zai's settings.json shape. Skips when the env var is already set
 * (vendor parity).
 */
export function applyZaiExtraCACertsFromConfig(): string | undefined {
  if (process.env.NODE_EXTRA_CA_CERTS) {
    return process.env.NODE_EXTRA_CA_CERTS
  }
  const settingsEnv = readZaiSettingsEnv()
  const path = settingsEnv.NODE_EXTRA_CA_CERTS
  if (path && typeof path === 'string') {
    process.env.NODE_EXTRA_CA_CERTS = path
    return path
  }
  return undefined
}

// ----- entry point -----

let enabled = false

export type EnableOpenccConfigsOptions = {
  /** Project cwd; defaults to process.cwd() if omitted. */
  cwd?: string
}

/**
 * Run the opencc startup sequence. Idempotent — repeated calls
 * short-circuit after the first successful run.
 *
 * Order (matches vendor's entrypoints/init.ts):
 *
 *   1. installMacroStub (must run before bundle evaluation)
 *   2. bundle.enableConfigs()  — sets configReadingAllowed = true
 *   3. setIsInteractive(false) via bundle — non-interactive session
 *   4. bundle.setOriginalCwd(cwd)  — STATE.originalCwd
 *   5. bundle.setCwdState(cwd)     — STATE.cwd (same value initially)
 *   6. SKIP setSessionId           — per-request, not global
 *   7. bundle.setClientType('zai-server')
 *   8. applySafeZaiSettingsEnv()   — compat-side; safe-mode env
 *   9. applyZaiExtraCACertsFromConfig() — compat-side; NODE_EXTRA_CA_CERTS
 *  10. bundle.setupGracefulShutdown()  — SIGINT/SIGTERM handlers
 *  11. SKIP configureGlobalMTLS         — bundle export not exposed
 *  12. bundle.configureGlobalAgents()   — proxy/mTLS HTTP agents
 *  13. applyZaiSettingsEnvFull()        — compat-side; full env
 *  14. SKIP preconnectAnthropicApi      — optional TCP warmup
 *
 * `bundle.*` calls are guarded with typeof checks; if the bundle
 * loses an export in a future opencc rev, the compat-side steps
 * still run.
 */
export async function enableOpenccConfigs(
  opts: EnableOpenccConfigsOptions = {},
): Promise<void> {
  if (enabled) return
  enabled = true

  // Step 1: pre-populate globalThis.MACRO BEFORE importing the bundle.
  // (See comment on installMacroStub.) The bundle evaluates top-level
  // code that references MACRO.X — without this stub the first
  // reference throws ReferenceError and aborts startup.
  installMacroStub()
  setZaiIsNonInteractive()

  const cwd = opts.cwd ?? process.cwd()

  // Pre-flight resolve so the error points to the build step rather
  // than a deep "Cannot find module" from Node's resolver.
  try {
    const url = (await import.meta.resolve?.(BUNDLE_URL)) ?? BUNDLE_URL
    if (url.startsWith('file://') && !existsSync(fileURLToPath(url))) {
      throw new Error('bundle path does not exist on disk')
    }
  } catch {
    throw new Error(
      `[openccInit] cannot resolve ${BUNDLE_URL}. ` +
      `Run \`pnpm --filter @zn-ai/zn-agent-core build\` to (re)generate the bundle.`,
    )
  }

  // Lazy-import the bundle so the ~18MB opencc-core.mjs isn't on the
  // critical boot path. Anything we can do without the bundle should
  // be done before this import (step 8 + 9 env reads).
  //
  // Step 8 + 9: compat-side env reads can run before the bundle
  // import — they only touch process.env and the on-disk settings
  // file. Doing them first means even if the bundle import fails,
  // env-derived config (CA certs, model name, base URL) is in place
  // for any fallback code path.
  applySafeZaiSettingsEnv()
  applyZaiExtraCACertsFromConfig()

  const bundle = (await import(/* @vite-ignore */ BUNDLE_URL as any)) as any

  // Step 2: enableConfigs() — sets configReadingAllowed = true so
  // subsequent getConfig() calls don't throw.
  if (typeof bundle.enableConfigs === 'function') {
    bundle.enableConfigs()
  }

  // Step 3: setIsInteractive(false) — non-interactive (HTTP server,
  // no TTY). Use the bundle's exported setter so vendor STATE stays
  // in sync; falls back to the compat global if the setter is gone.
  if (typeof bundle.setIsInteractive === 'function') {
    bundle.setIsInteractive(false)
  }

  // Step 4 + 5: originalCwd + cwdState — both same value initially;
  // cwdState diverges later when LLM self-tracks cwd via BashTool
  // trailer (see compat/cwdStore.ts).
  if (typeof bundle.setOriginalCwd === 'function') {
    bundle.setOriginalCwd(cwd)
  }
  if (typeof bundle.setCwdState === 'function') {
    bundle.setCwdState(cwd)
  }

  // Step 7: client type — 'zai-server' doesn't collide with any
  // opencc clientType (which are 'claude-cli', 'claude-vscode',
  // 'sdk-cli', 'remote', 'web-internal', etc. — see
  // opencc-src/bootstrap/state.ts preferThirdPartyAuthentication).
  if (typeof bundle.setClientType === 'function') {
    bundle.setClientType('zai-server')
  }

  // Step 10: graceful shutdown — registers SIGINT/SIGTERM handlers
  // for cleanup (vendor's gracefulShutdown.ts uses registerCleanup).
  if (typeof bundle.setupGracefulShutdown === 'function') {
    bundle.setupGracefulShutdown()
  }

  // Step 11: configureGlobalMTLS — NOT exported by the bundle.
  // zai-server doesn't currently use the vendor proxy/mTLS agent
  // stack (Anthropic SDK configures its own transport on first
  // call). If/when mTLS support lands, re-implement here using
  // opencc's utils/mtls.ts reference semantics.

  // Step 12: configureGlobalAgents — proxy + mTLS HTTP agents.
  // Safe to call even when no proxy/mTLS is configured; no-ops on
  // empty env. After this, the global undici dispatcher respects
  // HTTPS_PROXY + NO_PROXY.
  if (typeof bundle.configureGlobalAgents === 'function') {
    bundle.configureGlobalAgents()
  }

  // Step 13: full env application — overwrites process.env with
  // settings.env values. Vendor semantics: post-trust. zai-server
  // doesn't gate on a trust dialog yet, so we apply unconditionally
  // but this function is exported (`applyZaiSettingsEnvFull`) for
  // trust flows to invoke explicitly instead.
  applyZaiSettingsEnvFull()
}