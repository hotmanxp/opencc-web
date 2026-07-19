import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadMcpServers } from '../../src/server/services/mcpConfig.js'

/**
 * Regression test: `loadMcpServers` must inject a default `roots: [cwd]`
 * for every server so chrome-devtools-mcp and similar servers can stop
 * printing the "did not negotiate the MCP roots capability" warning.
 */
describe('loadMcpServers roots injection', () => {
  let cwd: string
  let homeBackup: string | undefined

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'zai-mcp-roots-'))
    // isolate from real ~/.zai.json / ~/.claude.json
    homeBackup = process.env.HOME
    process.env.HOME = cwd
  })

  afterEach(() => {
    if (homeBackup !== undefined) process.env.HOME = homeBackup
    rmSync(cwd, { recursive: true, force: true })
  })

  test('injects roots: [cwd] when spec is loaded from .mcp.json', () => {
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'sample-stdio': { command: 'echo', args: ['hello'] },
          'sample-http': { type: 'http', url: 'http://localhost:9999' },
        },
      }),
    )

    const servers = loadMcpServers(cwd)
    expect(servers).toHaveLength(2)
    for (const s of servers) {
      expect(s.roots, `spec ${s.name} should default roots`).toEqual([cwd])
    }
  })

  test('returns empty list (no fallback) when nothing configured', () => {
    expect(loadMcpServers(cwd)).toEqual([])
  })
})