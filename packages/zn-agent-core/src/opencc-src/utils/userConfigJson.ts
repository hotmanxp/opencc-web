/**
 * Unified reader/writer for the zai-owned top-level user config JSON file.
 *
 * Reads `~/.zai.json` first; if it doesn't exist, falls back to `~/.zai.json`
 * (so a Claude Code session's config can be picked up by zai on first run).
 * Writes target `~/.zai.json` if it exists, else `~/.zai.json`, else the
 * writer creates `~/.zai.json`. Unrelated top-level keys are preserved
 * (`mcpServers`, `numStartups`, etc.) via shallow merge.
 *
 * Scope of this helper: plugin `enabledPlugins` persistence, and any future
 * field that should live in the user-level single-file config rather than the
 * vendor settings cascade (`~/.zai/settings.json`). Other settings
 * (theme/outputStyle/model/permissions) keep going through
 * `updateSettingsForSource('userSettings', ...)`.
 *
 * Read returns `{}` (never throws) for: missing file, malformed JSON, or
 * non-object payload. Mirrors `parseSettingsFile` behavior so the rest of the
 * system can treat empty config and missing config uniformly.
 *
 * Concurrent-process safety: Node JS is single-threaded so two `setUserConfigJsonValue`
 * calls in the same process serialize. If two separate processes write to the
 * same path at the same time, last-writer-wins — same semantics as
 * `updateSettingsForSource`.
 */
import { existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'

import { logError } from './log.js'
import { safeParseJSON } from './json.js'
import { readFileSync } from './fileRead.js'
import { writeFileSyncAndFlush_DEPRECATED } from './file.js'
import { jsonStringify, clone } from './slowOperations.js'
import { markInternalWrite } from './settings/internalWrites.js'
import { resetSettingsCache } from './settings/settingsCache.js'

/**
 * Mirrors the top-level shape of `~/.zai.json` / `~/.zai.json`. The
 * `enabledPlugins` field type matches the vendor zod schema
 * (`utils/settings/types.ts:619-627`): values are `boolean` or `string[]`
 * (string[] is reserved for future version-constraint extensions).
 */
export type UserConfigJson = {
  enabledPlugins?: Record<string, boolean | string[]>
  /** Other top-level keys (e.g. `mcpServers`, `numStartups`) pass through untouched. */
  [key: string]: unknown
}

/** Read return type — `{}` (not `null`) is the universal empty config sentinel. */
export type UserConfigJsonRead = UserConfigJson

const ZAI_JSON_FILENAME = '.zai.json'
const CLAUDE_JSON_FILENAME = '.zai.json'

function getZaiJsonPath(): string {
  return join(homedir(), ZAI_JSON_FILENAME)
}

function getClaudeJsonPath(): string {
  return join(homedir(), CLAUDE_JSON_FILENAME)
}

type CacheEntry = {
  /** Resolved file path used for the cached read. */
  path: string
  /** Cloned snapshot of the parsed JSON. Callers receive a fresh clone. */
  data: UserConfigJson
}

let cached: CacheEntry | null = null

/**
 * Resolve which file to read: `~/.zai.json` if it exists, else `~/.zai.json`,
 * else null (caller returns `{}`).
 */
function resolveReadPath(): string | null {
  const zai = getZaiJsonPath()
  if (existsSync(zai)) return zai
  const claude = getClaudeJsonPath()
  if (existsSync(claude)) return claude
  return null
}

/**
 * Resolve which file to write: `~/.zai.json` if it exists, else
 * `~/.zai.json` if it exists, else `~/.zai.json` (caller creates it).
 */
function resolveWritePath(): { path: string; create: boolean } {
  const zai = getZaiJsonPath()
  if (existsSync(zai)) return { path: zai, create: false }
  const claude = getClaudeJsonPath()
  if (existsSync(claude)) return { path: claude, create: false }
  return { path: zai, create: true }
}

/**
 * Read a JSON file. Returns `{}` on ENOENT, malformed JSON, or non-object
 * payloads. Never throws.
 */
function readJsonFile(path: string): UserConfigJson {
  let content: string
  try {
    content = readFileSync(path)
  } catch (e) {
    // ENOENT or any other read error — caller treats as empty config.
    // Avoid log spam on the common cold-start case (no file yet).
    return {}
  }
  const parsed = safeParseJSON(content, false)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as UserConfigJson
  }
  logError(
    new Error(
      `Failed to parse user config JSON at ${path}; falling back to empty object`,
    ),
  )
  return {}
}

/**
 * Read the user-level config JSON. Returns a fresh clone so callers can
 * mutate the returned object without poisoning the in-process cache.
 *
 * Returns `{}` if neither `~/.zai.json` nor `~/.zai.json` exists.
 */
export function getUserConfigJson(): UserConfigJsonRead {
  const path = resolveReadPath()
  if (path === null) return {}

  if (cached !== null && cached.path === path) {
    return clone(cached.data)
  }

  const data = readJsonFile(path)
  cached = { path, data }
  return clone(data)
}

/**
 * Shallow-merge `{ [key]: value }` into the resolved file. Preserves all
 * other top-level keys (`mcpServers`, `numStartups`, etc.). Returns
 * `{ error }` matching `updateSettingsForSource`'s contract.
 *
 * Write target:
 *   1. `~/.zai.json` if it exists
 *   2. else `~/.zai.json` if it exists
 *   3. else creates `~/.zai.json`
 *
 * Side effects on success: marks the resolved path as an internal write
 * (so the file watcher ignores its own echo), invalidates the settings
 * cascade cache so `getSettingsForSource('userSettings')` re-reads on next
 * access, and invalidates this module's own cache so the next read in this
 * process picks up the new value.
 */
export function setUserConfigJsonValue(
  key: string,
  value: unknown,
): { error: Error | null } {
  try {
    const { path, create } = resolveWritePath()
    const existing: UserConfigJson = create ? {} : readJsonFile(path)
    existing[key] = value

    mkdirSync(dirname(path), { recursive: true })
    markInternalWrite(path)
    writeFileSyncAndFlush_DEPRECATED(
      path,
      jsonStringify(existing, null, 2) + '\n',
    )

    // Invalidate this module's cache so subsequent reads see the new value,
    // and clear the settings cascade since downstream reads may layer this
    // file's contents into the merged `getInitialSettings()`.
    cached = null
    resetSettingsCache()
    return { error: null }
  } catch (e) {
    return {
      error: new Error(`Failed to persist ${key} to user config JSON: ${e}`),
    }
  }
}

/**
 * Test/admin hook: drop the in-process read cache. The next `getUserConfigJson`
 * call will re-read from disk. Does NOT touch `~/.zai/settings.json`'s cache.
 */
export function resetUserConfigJsonCache(): void {
  cached = null
}