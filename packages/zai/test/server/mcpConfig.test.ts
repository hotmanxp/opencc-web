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

  // ──────────────────────────────────────────────────────────────────────
  // Claude Code compat: disabledMcpServers / enabledMcpjsonServers /
  // disabledMcpjsonServers. See plan 2026-07-20-zai-mcp-disabled-servers.
  // ──────────────────────────────────────────────────────────────────────

  test('disabledMcpServers in user scope filters the server out', () => {
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'keep-me': { command: 'echo', args: ['k'] },
          'drop-me': { command: 'echo', args: ['d'] },
        },
      }),
    )
    writeFileSync(
      join(cwd, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          'keep-me': { command: 'echo', args: ['k'] },
          'drop-me': { command: 'echo', args: ['d'] },
        },
        disabledMcpServers: ['drop-me'],
      }),
    )

    const names = loadMcpServers(cwd).map((s) => s.name).sort()
    expect(names).toEqual(['keep-me'])
  })

  test('disabledMcpjsonServers in project .mcp.json suppresses that file', () => {
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'should-be-gone': { command: 'echo', args: ['x'] },
        },
        disabledMcpjsonServers: ['should-be-gone'],
      }),
    )

    expect(loadMcpServers(cwd)).toEqual([])
  })

  test('enabledMcpjsonServers is an allowlist (other servers disabled)', () => {
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'allowed': { command: 'echo', args: ['a'] },
          'not-listed': { command: 'echo', args: ['n'] },
        },
        enabledMcpjsonServers: ['allowed'],
      }),
    )

    const names = loadMcpServers(cwd).map((s) => s.name)
    expect(names).toEqual(['allowed'])
  })

  // ─── Task 4 regression coverage ──────────────────────────────────────

  test('user disabledMcpServers wins over project enabledMcpjsonServers allowlist', () => {
    // .mcp.json allows `allowed` only, but ~/.claude.json globally disables it.
    // User-scope blocklist overrides project-scope allowlist.
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'allowed': { command: 'echo', args: ['a'] },
          'other': { command: 'echo', args: ['o'] },
        },
        enabledMcpjsonServers: ['allowed', 'other'],
      }),
    )
    writeFileSync(
      join(cwd, '.claude.json'),
      JSON.stringify({
        disabledMcpServers: ['allowed'],
      }),
    )

    const names = loadMcpServers(cwd).map((s) => s.name)
    expect(names).toEqual(['other'])
  })

  test('disabledMcpServers with no matching server is a no-op (no error)', () => {
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'real-server': { command: 'echo', args: ['r'] },
        },
      }),
    )
    writeFileSync(
      join(cwd, '.claude.json'),
      JSON.stringify({
        disabledMcpServers: ['never-declared', 'also-missing'],
      }),
    )

    const names = loadMcpServers(cwd).map((s) => s.name)
    expect(names).toEqual(['real-server'])
  })

  test('non-array disabledMcpServers is tolerated (treated as unset)', () => {
    // A third-party tool may have written a string/object by mistake.
    // Per opencc repairArrayFields (config.ts:1867), upstream coerces to [].
    // zai mirrors that by silently ignoring non-arrays rather than throwing.
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'srv': { command: 'echo', args: ['s'] },
        },
      }),
    )
    writeFileSync(
      join(cwd, '.claude.json'),
      JSON.stringify({
        disabledMcpServers: 'srv' /* should be ignored, not crash */,
      }),
    )

    const names = loadMcpServers(cwd).map((s) => s.name)
    expect(names).toEqual(['srv'])
  })

  test('parseFile tolerates malformed JSON without throwing', () => {
    // Regression: a half-written .mcp.json must not crash startup.
    writeFileSync(
      join(cwd, '.mcp.json'),
      '{ "mcpServers": { "broken', // truncated
    )

    expect(loadMcpServers(cwd)).toEqual([])
  })
})