import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { JsonTaskStore } from '../../../src/runtime/background/store/JsonTaskStore.js'
import { atomicWriteFile } from '../../../src/runtime/background/store/atomicWrite.js'
import type { BackgroundTask } from '../../../src/runtime/background/types.js'

let tmpDir: string
let store: JsonTaskStore
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zai-taskstore-corruption-'))
  store = new JsonTaskStore(tmpDir)
  await store.ensureDirs()
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  warnSpy.mockRestore()
  await rm(tmpDir, { recursive: true, force: true })
})

const makeTask = (id: string, status: BackgroundTask['status'] = 'completed'): BackgroundTask => ({
  id,
  status,
  input: { prompt: `prompt-${id}` },
  createdAt: 1700000000000,
  eventCount: 0,
})

describe('atomicWriteFile — tmp path hardening', () => {
  it('writes the target file atomically', async () => {
    const path = join(tmpDir, 'atomic-test.json')
    await atomicWriteFile(path, '{"a":1}')
    const { readFile } = await import('fs/promises')
    const raw = await readFile(path, 'utf-8')
    expect(raw).toBe('{"a":1}')
  })

  it('concurrent saves to same path produce valid JSON (no interleave)', async () => {
    const path = join(tmpDir, 'concurrent.json')
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        atomicWriteFile(path, JSON.stringify({ iteration: i })),
      ),
    )
    const { readFile } = await import('fs/promises')
    const raw = await readFile(path, 'utf-8')
    expect(() => JSON.parse(raw)).not.toThrow()
    const parsed = JSON.parse(raw) as { iteration: number }
    expect(parsed).toHaveProperty('iteration')
    expect(parsed.iteration).toBeGreaterThanOrEqual(0)
    expect(parsed.iteration).toBeLessThan(10)
  })
})

describe('JsonTaskStore.verifyWrite — post-write readback', () => {
  it('passes when file content matches expected', async () => {
    const path = join(tmpDir, 'verify-ok.json')
    await atomicWriteFile(path, '{"hello":"world"}')
    await expect(store.verifyWrite(path, '{"hello":"world"}', 'verify-ok')).resolves.toBeUndefined()
  })

  it('throws + removes file on byte mismatch', async () => {
    const path = join(tmpDir, 'verify-mismatch.json')
    await writeFile(path, '{"a":1} garbage', 'utf-8')
    await expect(
      store.verifyWrite(path, '{"a":1}', 'verify-mismatch'),
    ).rejects.toThrow(/post-write readback mismatch/)
    const { access } = await import('fs/promises')
    await expect(access(path)).rejects.toThrow()
  })

  it('throws + removes file when content is parse-broken JSON', async () => {
    const path = join(tmpDir, 'verify-parse.json')
    await writeFile(path, '{not valid json', 'utf-8')
    await expect(
      store.verifyWrite(path, '{not valid json', 'verify-parse'),
    ).rejects.toThrow(/post-write JSON.parse failed/)
    const { access } = await import('fs/promises')
    await expect(access(path)).rejects.toThrow()
  })

  it('throws when readFile fails (e.g. path missing)', async () => {
    const missing = join(tmpDir, 'nope.json')
    await expect(store.verifyWrite(missing, 'x', 'nope')).rejects.toThrow(/post-write readback failed/)
  })
})

describe('JsonTaskStore.save — end-to-end', () => {
  it('writes a valid task and loads it back unchanged', async () => {
    const task = makeTask('t-ok')
    await store.save(task)
    const loaded = await store.load('t-ok')
    expect(loaded).toEqual(task)
  })

  it('throws when post-write verify detects mismatch (simulates fs corruption)', async () => {
    vi.spyOn(store, 'verifyWrite').mockRejectedValueOnce(
      new Error('[JsonTaskStore] post-write readback mismatch for t-mismatch'),
    )
    await expect(store.save(makeTask('t-mismatch'))).rejects.toThrow(/post-write readback mismatch/)
  })
})

describe('JsonTaskStore.load — corruption tolerance + counter', () => {
  it('returns null for malformed JSON and warns once', async () => {
    const path = join(tmpDir, 'tasks', 't-corrupt.json')
    await writeFile(path, '{not valid json', 'utf-8')
    const result = await store.load('t-corrupt')
    expect(result).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/failed to parse task/)
  })

  it('returns null for ENOENT without warning', async () => {
    const result = await store.load('does-not-exist')
    expect(result).toBeNull()
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe('JsonTaskStore.list — aggregated warn', () => {
  it('emits a single aggregated warn when multiple files are corrupted', async () => {
    await store.save(makeTask('t-good'))
    for (const id of ['t-bad-1', 't-bad-2', 't-bad-3']) {
      await writeFile(join(tmpDir, 'tasks', `${id}.json`), '{broken', 'utf-8')
    }
    warnSpy.mockClear()
    const tasks = await store.list()
    expect(tasks.map((t) => t.id)).toEqual(['t-good'])
    const aggregated = warnSpy.mock.calls.find((call) =>
      String(call[0]).includes('list() skipped'),
    )
    expect(aggregated, 'expected aggregated list() warn').toBeDefined()
    expect(String(aggregated?.[0])).toMatch(/3 corrupted/)
  })

  it('does not emit aggregated warn when all tasks load cleanly', async () => {
    await store.save(makeTask('t-a'))
    await store.save(makeTask('t-b'))
    warnSpy.mockClear()
    const tasks = await store.list()
    expect(tasks).toHaveLength(2)
    const aggregated = warnSpy.mock.calls.find((call) =>
      String(call[0]).includes('list() skipped'),
    )
    expect(aggregated).toBeUndefined()
  })
})