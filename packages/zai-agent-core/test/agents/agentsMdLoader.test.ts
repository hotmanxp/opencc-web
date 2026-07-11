import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadAgentsMd, buildAgentsMdSystemPrompt } from '../../src/agents/agentsMdLoader.js'

let tmpDir: string
let fakeHome: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zai-agents-md-test-'))
  fakeHome = join(tmpDir, 'fakeHome')
  await mkdir(fakeHome)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('loadAgentsMd', () => {
  test('returns empty result when no AGENTS.md files exist', async () => {
    const result = await loadAgentsMd(tmpDir, { homedirOverride: fakeHome })
    expect(result.files).toEqual([])
    expect(result.raw).toBe('')
  })

  test('loads AGENTS.md from cwd', async () => {
    await writeFile(join(tmpDir, 'AGENTS.md'), '# Project rules\nUse TypeScript.', 'utf-8')
    const result = await loadAgentsMd(tmpDir, { homedirOverride: fakeHome })
    expect(result.files).toEqual([join(tmpDir, 'AGENTS.md')])
    expect(result.raw).toContain('Project rules')
    expect(result.raw).toContain('Use TypeScript')
  })

  test('loads .claude/AGENTS.md', async () => {
    await mkdir(join(tmpDir, '.claude'))
    await writeFile(join(tmpDir, '.claude', 'AGENTS.md'), '# .claude rules', 'utf-8')
    const result = await loadAgentsMd(tmpDir, { homedirOverride: fakeHome })
    expect(result.files).toEqual([join(tmpDir, '.claude', 'AGENTS.md')])
    expect(result.raw).toContain('.claude rules')
  })

  test('loads both cwd and .claude AGENTS.md when both exist', async () => {
    await writeFile(join(tmpDir, 'AGENTS.md'), '# Project', 'utf-8')
    await mkdir(join(tmpDir, '.claude'))
    await writeFile(join(tmpDir, '.claude', 'AGENTS.md'), '# Claude dir', 'utf-8')
    const result = await loadAgentsMd(tmpDir, { homedirOverride: fakeHome })
    expect(result.files).toHaveLength(2)
    expect(result.raw).toContain('Project')
    expect(result.raw).toContain('Claude dir')
  })

  test('skips empty AGENTS.md files', async () => {
    await writeFile(join(tmpDir, 'AGENTS.md'), '   \n  ', 'utf-8')
    const result = await loadAgentsMd(tmpDir, { homedirOverride: fakeHome })
    expect(result.files).toEqual([])
    expect(result.raw).toBe('')
  })

  test('also loads user-level ~/.claude/AGENTS.md', async () => {
    await writeFile(join(tmpDir, 'AGENTS.md'), '# Project', 'utf-8')
    await mkdir(join(fakeHome, '.claude'))
    await writeFile(join(fakeHome, '.claude', 'AGENTS.md'), '# User global', 'utf-8')
    const result = await loadAgentsMd(tmpDir, { homedirOverride: fakeHome })
    expect(result.files).toHaveLength(2)
    expect(result.raw).toContain('Project')
    expect(result.raw).toContain('User global')
  })
})

describe('buildAgentsMdSystemPrompt', () => {
  test('returns null for empty result', () => {
    const result = buildAgentsMdSystemPrompt({ raw: '', files: [] })
    expect(result).toBeNull()
  })

  test('wraps content with prefix', () => {
    const result = buildAgentsMdSystemPrompt({ raw: '<!-- /path/AGENTS.md -->\n# Rules', files: ['/path/AGENTS.md'] })
    expect(result).toContain('AGENTS.md 加载的指令')
    expect(result).toContain('Rules')
    expect(result).toContain('/path/AGENTS.md')
  })
})