import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { EXTERNAL_PERMISSION_MODES } from '@zn-ai/zn-agent-core/opencc-src/permissions'
import type { UserFacingPermissionMode } from "@zn-ai/zn-agent-core/compat/permissions";

const VALID_MODES: ReadonlySet<UserFacingPermissionMode> = new Set(EXTERNAL_PERMISSION_MODES)

/**
 * Read the default permission mode from ~/.zai/settings.json.
 *
 * Resolution order:
 *   1. settings.permissions.defaultMode — the opencc convention (the
 *      `permissions` block also carries allow/deny/ask rules). A user who
 *      writes `permissions.defaultMode: "bypassPermissions"` expects new
 *      sessions to boot in that mode; before this fix the value lived in
 *      `permissions`, so zai silently fell back to 'default' and MCP
 *      tools (e.g. codegraph) kept prompting even though allow rules
 *      were configured.
 *   2. settings.defaultMode (legacy top-level key, if present)
 *   3. 'default' (hardcoded fallback)
 *
 * File IO errors other than ENOENT / SyntaxError are silently treated
 * as "no defaultMode configured" — same defensive pattern as the rest
 * of the zai server.
 */
export function getDefaultMode(): UserFacingPermissionMode {
  try {
    const path = join(homedir(), '.zai', 'settings.json')
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
      defaultMode?: unknown
      permissions?: { defaultMode?: unknown }
    }
    const candidate = parsed.permissions?.defaultMode ?? parsed.defaultMode
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
