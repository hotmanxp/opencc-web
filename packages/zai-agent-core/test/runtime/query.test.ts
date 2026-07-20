import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { query } from '../../src/runtime/query.js'
import { makeMockModelCaller } from '../fixtures/MockModelCaller.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zai-query-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

async function collect(g: AsyncGenerator<any>) {
  const out: any[] = []
  for await (const e of g) out.push(e)
  return out
}

describe('query()', () => {
  test('emits events with sessionId', async () => {
    const events = await collect(query({
      prompt: 'hello', cwd: '/test',
    }, { dataDir: tmpDir, modelCaller: makeMockModelCaller('text-only') }))
    expect(events.length).toBeGreaterThan(0)
    expect(events[0].sessionId).toBeTruthy()
    expect(events[0].eventId).toBeTruthy()
  })

  test('ends with runtime.done', async () => {
    const events = await collect(query({
      prompt: 'hello', cwd: '/test',
    }, { dataDir: tmpDir, modelCaller: makeMockModelCaller('text-only') }))
    expect(events[events.length - 1].type).toBe('runtime.done')
  })

  test('无 modelCaller → runtime.error', async () => {
    const events = await collect(query({
      prompt: 'hello', cwd: '/test',
    }, { dataDir: tmpDir }))
    expect(events.at(-1)?.type).toBe('runtime.error')
  })

  test('abortSignal triggers early termination', async () => {
    const controller = new AbortController()
    const events: any[] = []
    setTimeout(() => controller.abort(), 20)
    for await (const event of query({
      prompt: 'x', cwd: '/test', abortSignal: controller.signal,
    }, { dataDir: tmpDir, modelCaller: makeMockModelCaller('infinite-loop') })) {
      events.push(event)
      if (event.type === 'runtime.aborted' || event.type === 'runtime.error') break
    }
    expect(events.some((e) => e.type === 'runtime.aborted' || e.type === 'runtime.error')).toBe(true)
  })

  test('resumeFromTranscriptId sets sessionId', async () => {
    const events = await collect(query({
      prompt: 'hello', cwd: '/test', resumeFromTranscriptId: 'sess-abc-123',
    }, { dataDir: tmpDir, modelCaller: makeMockModelCaller('text-only') }))
    expect(events[0].sessionId).toBe('sess-abc-123')
  })
})
