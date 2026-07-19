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

  test('respects @include directive', async () => {
    await mkdir(join(tmpDir, 'extra'), { recursive: true })
    await writeFile(join(tmpDir, 'extra', 'extra.md'), '# Extra content', 'utf-8')
    await writeFile(join(tmpDir, 'AGENTS.md'), '@./extra/extra.md\n# Main', 'utf-8')
    const files = await loadMemoryForPrompt(tmpDir)
    const main = files.find((f) => f.path.endsWith('AGENTS.md'))
    expect(main?.content).toContain('Extra content')
    expect(main?.content).toContain('Main')
  })

  test('honours MAX_INCLUDE_DEPTH (does not expand beyond depth N)', async () => {
    // Build a chain of N+1 files each @including the next, rooted at
    // AGENTS.md so the loader recognises the entrypoint.
    await writeFile(join(tmpDir, 'AGENTS.md'), '@./d1.md\n# ROOT', 'utf-8')
    // depth-1..6 files: each includes the next
    for (let i = 1; i <= 6; i++) {
      const next = i < 6 ? `@./d${i + 1}.md\n# d${i}` : `# d${i} leaf`
      await writeFile(join(tmpDir, `d${i}.md`), next, 'utf-8')
    }
    const files = await loadMemoryForPrompt(tmpDir)
    const root = files.find((f) => f.path.endsWith('AGENTS.md'))
    expect(root).toBeDefined()
    // d1..d4 should be reachable (depths 1..4, MAX=5 so d5+ is cut)
    expect(root?.content).toContain('# d1')
    expect(root?.content).toContain('# d4')
    // d5 and d6 should be cut off — neither marker is present
    expect(root?.content).not.toContain('d5 leaf')
    expect(root?.content).not.toContain('d6 leaf')
  })

  test('cycle guard: a.md includes b.md which includes a.md', async () => {
    await writeFile(join(tmpDir, 'a.md'), '@./b.md\n# A', 'utf-8')
    await writeFile(join(tmpDir, 'b.md'), '@./a.md\n# B', 'utf-8')
    await writeFile(join(tmpDir, 'AGENTS.md'), '@./a.md\n# ROOT', 'utf-8')
    const files = await loadMemoryForPrompt(tmpDir)
    const root = files.find((f) => f.path.endsWith('AGENTS.md'))
    expect(root).toBeDefined()
    // Content from B should be present (a.md -> b.md expanded)
    expect(root?.content).toContain('B')
    // a.md content appears once (not duplicated via the cycle back-edge)
    const aMatches = root?.content.match(/# A/g) ?? []
    expect(aMatches.length).toBe(1)
    // No infinite loop: the function returns within finite time.
  })

  test('top-level files can each include the same path without dropping it', async () => {
    // Regression: previously a global `visited` set meant once AGENTS.md
    // included a path, a second top-level entrypoint that also referenced
    // it would silently skip. Now each top-level gets its own chain.
    await writeFile(join(tmpDir, 'shared.md'), '# Shared', 'utf-8')
    await writeFile(join(tmpDir, 'AGENTS.md'), '@./shared.md\n# ROOT', 'utf-8')
    await writeFile(
      join(tmpDir, 'AGENTS.local.md'),
      '@./shared.md\n# LOCAL',
      'utf-8',
    )
    const files = await loadMemoryForPrompt(tmpDir)
    const root = files.find((f) => f.path.endsWith('AGENTS.md'))
    const local = files.find((f) => f.path.endsWith('AGENTS.local.md'))
    expect(root).toBeDefined()
    expect(local).toBeDefined()
    expect(root?.content).toContain('Shared')
    expect(local?.content).toContain('Shared')
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
