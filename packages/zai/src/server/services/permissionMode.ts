import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { EXTERNAL_PERMISSION_MODES, type UserFacingPermissionMode } from '@zn-ai/zai-agent-core'

const VALID_MODES: ReadonlySet<UserFacingPermissionMode> = new Set(EXTERNAL_PERMISSION_MODES)

/**
 * Read the default permission mode from ~/.zai/settings.json.
 *
 * Resolution order:
 *   1. settings.defaultMode (if present and in the 5 valid modes)
 *   2. 'default' (hardcoded fallback)
 *
 * File IO errors other than ENOENT / SyntaxError are silently treated
 * as "no defaultMode configured" — same defensive pattern as the rest
 * of the zai server.
 */
export function getDefaultMode(): UserFacingPermissionMode {
  try {
    const path = join(homedir(), '.zai', 'settings.json')
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { defaultMode?: unknown }
    const candidate = parsed.defaultMode
    if (typeof candidate === 'string' && VALID_MODES.has(candidate as UserFacingPermissionMode)) {
      return candidate as UserFacingPermissionMode
    }
  } catch (err) {
    if (!(err instanceof SyntaxError) && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Real IO error — fall through to default.
    }
  }
  return 'default'
}
