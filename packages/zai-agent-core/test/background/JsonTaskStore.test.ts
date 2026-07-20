import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { JsonTaskStore } from '../../src/runtime/background/store/JsonTaskStore.js'
import { atomicWriteFile } from '../../src/runtime/background/store/atomicWrite.js'
import type { BackgroundTask, TaskEvent } from '../../src/runtime/background/types.js'

let tmpDir: string
let store: JsonTaskStore

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zai-jsonstore-'))
  store = new JsonTaskStore(tmpDir)
  await store.ensureDirs()
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function makeTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: 'a1b2c3d4e5f6',
    status: 'queued',
    input: { prompt: 'hello' },
    createdAt: Date.now(),
    eventCount: 0,
    ...overrides,
  }
}

describe('atomicWriteFile', () => {
  test('writes and renames, leaving no .tmp residue', async () => {
    const p = join(tmpDir, 'nested', 'config.json')
    await atomicWriteFile(p, '{"a":1}')
    expect((await stat(p)).isFile()).toBe(true)
    const files = await readdir(join(tmpDir, 'nested'))
    expect(files).toEqual(['config.json'])
  })
})

describe('JsonTaskStore.save + load', () => {
  test('round-trip preserves all fields', async () => {
    const task = makeTask({ eventCount: 7, status: 'running', startedAt: 42 })
    await store.save(task)
    const loaded = await store.load(task.id)
    expect(loaded).toEqual(task)
  })

  test('load returns null for nonexistent id', async () => {
    expect(await store.load('nonexistent')).toBeNull()
  })

  test('load returns null for corrupted JSON (does not throw)', async () => {
    const id = 'corrupt01'
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(tmpDir, 'tasks', `${id}.json`), '{bad json', 'utf-8')
    expect(await store.load(id)).toBeNull()
  })
})

describe('JsonTaskStore.list', () => {
  test('returns empty list when no tasks', async () => {
    expect(await store.list()).toEqual([])
  })

  test('filters by status', async () => {
    await store.save(makeTask({ id: 'aaaa00000001', status: 'completed' }))
    await store.save(makeTask({ id: 'aaaa00000002', status: 'running' }))
    await store.save(makeTask({ id: 'aaaa00000003', status: 'running' }))
    const running = await store.list({ status: 'running' })
    expect(running.map((t) => t.id).sort()).toEqual([
      'aaaa00000002',
      'aaaa00000003',
    ])
  })

  test('sorts by createdAt desc and applies limit', async () => {
    await store.save(makeTask({ id: 'aaaa00000001', createdAt: 100 }))
    await store.save(makeTask({ id: 'aaaa00000002', createdAt: 300 }))
    await store.save(makeTask({ id: 'aaaa00000003', createdAt: 200 }))
    const all = await store.list()
    expect(all.map((t) => t.id)).toEqual([
      'aaaa00000002',
      'aaaa00000003',
      'aaaa00000001',
    ])
    const limited = await store.list({ limit: 2 })
    expect(limited.map((t) => t.id)).toEqual([
      'aaaa00000002',
      'aaaa00000003',
    ])
  })
})

describe('JsonTaskStore.appendEvent + readEvents', () => {
  function makeEvent(seq: number, type = 'runtime.done'): TaskEvent {
    return { seq, eventId: `evt-${seq}`, ts: 1000 + seq, type, data: { x: seq } }
  }

  test('appends NDJSON lines in order', async () => {
    const id = 'evtaaaa00001'
    await store.appendEvent(id, makeEvent(1))
    await store.appendEvent(id, makeEvent(2))
    await store.appendEvent(id, makeEvent(3))
    const content = await readFile(
      join(tmpDir, 'events', `${id}.log`),
      'utf-8',
    )
    const lines = content.split('\n').filter(Boolean)
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[2]).seq).toBe(3)
  })

  test('readEvents skips seq <= fromSeq', async () => {
    const id = 'evtaaaa00002'
    for (let i = 1; i <= 5; i++) await store.appendEvent(id, makeEvent(i))
    const out: number[] = []
    for await (const ev of store.readEvents(id, 2)) {
      out.push(ev.seq)
    }
    expect(out).toEqual([3, 4, 5])
  })

  test('readEvents yields nothing for nonexistent log', async () => {
    const out: TaskEvent[] = []
    for await (const ev of store.readEvents('does-not-exist')) {
      out.push(ev)
    }
    expect(out).toEqual([])
  })

  test('readEvents skips malformed NDJSON lines', async () => {
    const id = 'evtaaaa00003'
    await store.appendEvent(id, makeEvent(1))
    const { appendFile } = await import('node:fs/promises')
    await appendFile(join(tmpDir, 'events', `${id}.log`), '{not-json\n')
    await store.appendEvent(id, makeEvent(2))
    const out: TaskEvent[] = []
    for await (const ev of store.readEvents(id)) out.push(ev)
    expect(out.map((e) => e.seq)).toEqual([1, 2])
  })
})

describe('JsonTaskStore.delete', () => {
  test('removes both task and event files', async () => {
    const id = 'delaaa00001'
    await store.save(makeTask({ id }))
    await store.appendEvent(id, {
      seq: 1,
      eventId: 'e1',
      ts: 1,
      type: 'runtime.done',
      data: {},
    })
    await store.delete(id)
    expect(await store.load(id)).toBeNull()
    const evOut: TaskEvent[] = []
    for await (const ev of store.readEvents(id)) evOut.push(ev)
    expect(evOut).toEqual([])
  })
})