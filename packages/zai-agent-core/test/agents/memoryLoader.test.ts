import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadMemoryForPrompt, clearMemoryCache, hasExternalIncludes } from '../../src/agents/memoryLoader.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zai-memory-test-'))
  clearMemoryCache()
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('loadMemoryForPrompt', () => {
  test('returns empty array when cwd has no AGENTS.md and no .claude/', async () => {
    const files = await loadMemoryForPrompt(tmpDir)
    expect(files).toEqual([])
  })

  test('never throws even when cwd path is bogus', async () => {
    const files = await loadMemoryForPrompt('/nonexistent/path/that/does/not/exist')
    expect(Array.isArray(files)).toBe(true)
  })

  test('loads AGENTS.md from cwd', async () => {
    await writeFile(join(tmpDir, 'AGENTS.md'), '# Project rules\nUse TypeScript.', 'utf-8')
    const files = await loadMemoryForPrompt(tmpDir)
    expect(files.length).toBeGreaterThan(0)
    const project = files.find((f) => f.path.endsWith('AGENTS.md') && f.type === 'Project')
    expect(project).toBeDefined()
    expect(project?.content).toContain('Project rules')
  })

  test('loads AGENTS.local.md from cwd (not parent)', async () => {
    await writeFile(join(tmpDir, 'AGENTS.local.md'), '# Local overrides', 'utf-8')
    const files = await loadMemoryForPrompt(tmpDir)
    const local = files.find((f) => f.path.endsWith('AGENTS.local.md') && f.type === 'Local')
    expect(local).toBeDefined()
  })

  test('loads .claude/rules/*.md', async () => {
    await mkdir(join(tmpDir, '.claude', 'rules'), { recursive: true })
    await writeFile(join(tmpDir, '.claude', 'rules', 'build.md'), '# Build rule', 'utf-8')
    const files = await loadMemoryForPrompt(tmpDir)
    const rule = files.find((f) => f.path.includes('.claude/rules/build.md') && f.type === 'Rule')
    expect(rule).toBeDefined()
  })

  test('respects @include directive', async () => {
    await mkdir(join(tmpDir, 'extra'), { recursive: true })
    await writeFile(join(tmpDir, 'extra', 'extra.md'), '# Extra content', 'utf-8')
    await writeFile(join(tmpDir, 'AGENTS.md'), '@./extra/extra.md\n# Main', 'utf-8')
    const files = await loadMemoryForPrompt(tmpDir)
    const main = files.find((f) => f.path.endsWith('AGENTS.md'))
    expect(main?.content).toContain('Extra content')
    expect(main?.content).toContain('Main')
  })
})

describe('clearMemoryCache', () => {
  test('forces next call to re-read from disk', async () => {
    await writeFile(join(tmpDir, 'AGENTS.md'), '# v1', 'utf-8')
    const first = await loadMemoryForPrompt(tmpDir)
    expect(first[0]?.content).toContain('v1')
    await writeFile(join(tmpDir, 'AGENTS.md'), '# v2', 'utf-8')
    const stale = await loadMemoryForPrompt(tmpDir)
    expect(stale[0]?.content).toContain('v1') // cached
    clearMemoryCache()
    const fresh = await loadMemoryForPrompt(tmpDir)
    expect(fresh[0]?.content).toContain('v2')
  })
})

describe('hasExternalIncludes', () => {
  test('returns false for cwd with no @include', async () => {
    await writeFile(join(tmpDir, 'AGENTS.md'), '# Project', 'utf-8')
    const has = await hasExternalIncludes(tmpDir)
    expect(has).toBe(false)
  })
})
