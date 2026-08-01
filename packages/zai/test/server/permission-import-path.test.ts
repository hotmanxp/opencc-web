import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const AGENT_TS = readFileSync(
  join(__dirname, '../../src/server/routes/agent.ts'),
  'utf-8',
)
const PERMISSION_MODE_TS = readFileSync(
  join(__dirname, '../../src/server/services/permissionMode.ts'),
  'utf-8',
)

// Strip the new opencc-src import so the negative assertion below
// doesn't false-positive on the new path. We want to detect any
// re-import from package root, not the new subpath.
function stripOpenccSrcImport(src: string): string {
  return src.replace(
    /import\s*\{[^}]*EXTERNAL_PERMISSION_MODES[^}]*\}\s*from\s*['"]@zn-ai\/zn-agent-core\/opencc-src\/permissions['"]\s*;?/g,
    '',
  )
}

describe('permissions import path regression', () => {
  it('routes/agent.ts imports EXTERNAL_PERMISSION_MODES from opencc-src subpath', () => {
    expect(AGENT_TS).toMatch(
      /from\s+['"]@zn-ai\/zn-agent-core\/opencc-src\/permissions['"]/,
    )
  })

  it('routes/agent.ts imports UserFacingPermissionMode from compat', () => {
    expect(AGENT_TS).toMatch(
      /import\s+type\s*\{[^}]*UserFacingPermissionMode[^}]*\}\s+from\s+['"]@zn-ai\/zn-agent-core\/compat\/permissions['"]/,
    )
  })

  it('routes/agent.ts does NOT import EXTERNAL_PERMISSION_MODES from package root', () => {
    const stripped = stripOpenccSrcImport(AGENT_TS)
    const m = stripped.match(
      /import\s*\{[^}]*EXTERNAL_PERMISSION_MODES[^}]*\}\s*from\s*['"]@zn-ai\/zn-agent-core['"]/,
    )
    expect(m).toBeNull()
  })

  it('services/permissionMode.ts imports EXTERNAL_PERMISSION_MODES from opencc-src subpath', () => {
    expect(PERMISSION_MODE_TS).toMatch(
      /from\s+['"]@zn-ai\/zn-agent-core\/opencc-src\/permissions['"]/,
    )
  })

  it('services/permissionMode.ts imports UserFacingPermissionMode from compat', () => {
    expect(PERMISSION_MODE_TS).toMatch(
      /import\s+type\s*\{[^}]*UserFacingPermissionMode[^}]*\}\s+from\s+['"]@zn-ai\/zn-agent-core\/compat\/permissions['"]/,
    )
  })

  it('services/permissionMode.ts does NOT import EXTERNAL_PERMISSION_MODES from package root', () => {
    const stripped = stripOpenccSrcImport(PERMISSION_MODE_TS)
    const m = stripped.match(
      /import\s*\{[^}]*EXTERNAL_PERMISSION_MODES[^}]*\}\s*from\s*['"]@zn-ai\/zn-agent-core['"]/,
    )
    expect(m).toBeNull()
  })
})
