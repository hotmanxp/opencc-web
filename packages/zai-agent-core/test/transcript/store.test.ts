import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { TranscriptStore } from '../../src/transcript/store.js'
import type { TranscriptMessage } from '../../src/transcript/types.js'

let tmpDir: string
let store: TranscriptStore

const v2Msg = (overrides: Partial<TranscriptMessage> = {}): TranscriptMessage => ({
  uuid: 'msg-1',
  parentUuid: null,
  type: 'user',
  timestamp: 1,
  message: { content: 'hello', role: 'user' },
  cwd: '/test',
  userType: 'zai',
  sessionId: 'sess-test',
  version: '2',
  isSidechain: false,
  ...overrides,
})

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zai-transcript-test-'))
  store = new TranscriptStore(tmpDir)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('TranscriptStore', () => {
  it('create returns a valid transcriptId', async () => {
    const id = await store.create({ cwd: '/test', model: 'gpt-4' })
    expect(id).toMatch(/^sess-[0-9a-f-]{36}$/i)
  })

  it('read returns created file', async () => {
    const id = await store.create({ cwd: '/test', model: 'gpt-4' })
    const file = await store.read(id)
    expect(file.transcriptId).toBe(id)
    expect(file.meta.cwd).toBe('/test')
    expect(file.messages).toEqual([])
  })

  it('append + read includes messages', async () => {
    const id = await store.create({ cwd: '/test', model: 'gpt-4' })
    await store.append(id, v2Msg({ uuid: 'msg-1', message: { content: 'hello', role: 'user' } }))
    const file = await store.read(id)
    expect(file.messages).toHaveLength(1)
    expect(file.messages[0].message.content).toBe('hello')
  })

  it('list returns all sessions sorted by updatedAt desc', async () => {
    const id1 = await store.create({ cwd: '/a', model: 'm1' })
    await new Promise((r) => setTimeout(r, 10))
    const id2 = await store.create({ cwd: '/b', model: 'm2' })
    const list = await store.list()
    expect(list).toHaveLength(2)
    expect(list[0].transcriptId).toBe(id2)
    expect(list[1].transcriptId).toBe(id1)
  })

  it('patch updates title and tags', async () => {
    const id = await store.create({ cwd: '/test', model: 'm1' })
    await store.patch(id, { title: 'my session', tags: ['bug'] })
    const file = await store.read(id)
    expect(file.meta.title).toBe('my session')
    expect(file.meta.tags).toEqual(['bug'])
  })

  it('remove deletes the file', async () => {
    const id = await store.create({ cwd: '/test', model: 'm1' })
    await store.remove(id)
    await expect(store.read(id)).rejects.toThrow()
  })
})
