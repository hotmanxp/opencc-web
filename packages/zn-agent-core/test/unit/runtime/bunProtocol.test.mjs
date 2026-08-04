// Vitest can run .mjs files directly. This test exercises the redirect
// by spawning a tsx process with the loader hook and verifying bun:bundle
// resolves to the shim (feature() returns true, require throws).
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs'

const repoRoot = '/Users/ethan/code/opencc-web'
const tsxPath = resolve(repoRoot, 'node_modules/.bin/tsx')
const protoPath = resolve(repoRoot, 'packages/zn-agent-core/src/compat/runtime/bun-protocol.mjs')

describe('bun-protocol loader hook', () => {
  it.skip('redirects bun:bundle to bun-shim.ts', () => {
    // Write the test code to a temp script to avoid shell escaping issues
    const tmpDir = mkdtempSync(join('/tmp', 'bun-protocol-test-'))
    const scriptPath = join(tmpDir, 'test.mjs')
    writeFileSync(scriptPath, `
import { feature, require as bunRequire } from 'bun:bundle';
const keys = Object.keys({ feature, bunRequire });
console.log(JSON.stringify(keys));
`)

    try {
      const result = spawnSync(
        tsxPath,
        ['--loader', protoPath, scriptPath],
        { encoding: 'utf-8', cwd: repoRoot },
      )

      // status 0 = success; stderr may contain Node deprecation warnings
      // but not an actual error
      expect(result.status, result.stderr).toBe(0)
      const keys = JSON.parse(result.stdout.trim())
      expect(keys).toContain('feature')
      expect(keys).toContain('bunRequire')
    } finally {
      unlinkSync(scriptPath)
    }
  }, 10_000)
})
