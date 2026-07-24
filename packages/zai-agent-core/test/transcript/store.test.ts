import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readdir } from 'fs/promises'
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
    const id = await store.create({ cwd: '/test', model: 'gpt-4' }, { cwd: '/test' })
    expect(id).toMatch(/^sess-[0-9a-f-]{36}$/i)
  })

  it('read returns created file', async () => {
    const id = await store.create({ cwd: '/test', model: 'gpt-4' }, { cwd: '/test' })
    const file = await store.read(id, { cwd: '/test' })
    expect(file.transcriptId).toBe(id)
    expect(file.meta.cwd).toBe('/test')
    expect(file.messages).toEqual([])
  })

  it('append + read includes messages', async () => {
    const id = await store.create({ cwd: '/test', model: 'gpt-4' }, { cwd: '/test' })
    await store.append(id, v2Msg({ uuid: 'msg-1', message: { content: 'hello', role: 'user' } }), { cwd: '/test' })
    const file = await store.read(id, { cwd: '/test' })
    expect(file.messages).toHaveLength(1)
    expect(file.messages[0].message.content).toBe('hello')
  })

  it('list(cwd) returns only sessions in that cwd project', async () => {
    const idA = await store.create({ cwd: '/a', model: 'm1' }, { cwd: '/a' })
    const idB = await store.create({ cwd: '/b', model: 'm2' }, { cwd: '/b' })
    const listA = await store.list({ cwd: '/a' })
    expect(listA.map((m) => m.transcriptId)).toEqual([idA])
    const listB = await store.list({ cwd: '/b' })
    expect(listB.map((m) => m.transcriptId)).toEqual([idB])
  })

  it('list() with no args returns all sessions across all projects', async () => {
    const id1 = await store.create({ cwd: '/a', model: 'm1' }, { cwd: '/a' })
    await new Promise((r) => setTimeout(r, 10))
    const id2 = await store.create({ cwd: '/b', model: 'm2' }, { cwd: '/b' })
    const list = await store.list()
    expect(list).toHaveLength(2)
    expect(list[0].transcriptId).toBe(id2)
    expect(list[1].transcriptId).toBe(id1)
  })

  it('patch updates title and tags', async () => {
    const id = await store.create({ cwd: '/test', model: 'm1' }, { cwd: '/test' })
    await store.patch(id, { title: 'my session', tags: ['bug'] }, { cwd: '/test' })
    const file = await store.read(id, { cwd: '/test' })
    expect(file.meta.title).toBe('my session')
    expect(file.meta.tags).toEqual(['bug'])
  })

  it('remove deletes the file', async () => {
    const id = await store.create({ cwd: '/test', model: 'm1' }, { cwd: '/test' })
    await store.remove(id, { cwd: '/test' })
    await expect(store.read(id, { cwd: '/test' })).rejects.toThrow()
  })
})

describe('TranscriptStore path layout', () => {
  it('writes main session under <dataDir>/transcripts/projects/<sanitized>/<id>.json', async () => {
    const id = await store.create(
      { cwd: '/Users/ethan/code/opencc', model: 'm' },
      { cwd: '/Users/ethan/code/opencc' },
    )
    const projectDir = join(tmpDir, 'transcripts', 'projects', '-Users-ethan-code-opencc')
    const entries = await readdir(projectDir)
    expect(entries).toContain(`${id}.json`)
  })

  it('writes subagent session under <projectDir>/subagents/<id>.json', async () => {
    const id = await store.create(
      {
        cwd: '/Users/ethan/code/opencc',
        model: 'm',
        parentSessionId: 'sess-parent',
        subagentType: 'general-purpose',
      },
      { cwd: '/Users/ethan/code/opencc', subagent: true },
    )
    const subDir = join(
      tmpDir,
      'transcripts',
      'projects',
      '-Users-ethan-code-opencc',
      'subagents',
    )
    const entries = await readdir(subDir)
    expect(entries).toContain(`${id}.json`)
  })

  // 回归 (sync fork 双保险归类):
  //   AgentTool 的 sync fork 路径 (runForkedAgent → queryLoop) 只透传
  //   subagentType, 没透传 ctx.parentSessionId 到 toolUseContext.options.
  //   queryLoop / queryEngine 的 isSubagent 判定必须也看 subagentType,
  //   否则 sync fork 的 transcript 误落 projectDir 顶层而不是 subagents/.
  it('auto-classifies as subagent when only subagentType is set in meta (no parentSessionId)', async () => {
    const id = await store.create(
      {
        cwd: '/Users/ethan/code/opencc',
        model: 'm',
        subagentType: 'general-purpose',
      },
      { cwd: '/Users/ethan/code/opencc' },
    )
    const subDir = join(
      tmpDir,
      'transcripts',
      'projects',
      '-Users-ethan-code-opencc',
      'subagents',
    )
    const entries = await readdir(subDir)
    expect(entries).toContain(`${id}.json`)
  })

  it('does not write into the legacy flat transcripts/ root', async () => {
    await store.create({ cwd: '/proj', model: 'm' }, { cwd: '/proj' })
    // 老布局 `<dataDir>/transcripts/*.json` 应不再有 .json 顶层文件
    const root = join(tmpDir, 'transcripts')
    const entries = await readdir(root).catch(() => [] as string[])
    expect(entries.filter((e) => e.endsWith('.json'))).toEqual([])
  })

  it('different cwds live in different projectDirs', async () => {
    await store.create({ cwd: '/x', model: 'm' }, { cwd: '/x' })
    await store.create({ cwd: '/y', model: 'm' }, { cwd: '/y' })
    const projectsDir = join(tmpDir, 'transcripts', 'projects')
    const entries = await readdir(projectsDir)
    expect(entries.sort()).toEqual(['-x', '-y'])
  })
})

describe('TranscriptStore list excludes subagents by path', () => {
  it('list(cwd, {excludeSubagent}) skips subagents/ directory entirely', async () => {
    const mainId = await store.create(
      { cwd: '/proj', model: 'm' },
      { cwd: '/proj' },
    )
    await store.create(
      { cwd: '/proj', model: 'm', parentSessionId: mainId, subagentType: 'explore' },
      { cwd: '/proj', subagent: true },
    )
    const list = await store.list({ cwd: '/proj', excludeSubagent: true })
    expect(list.map((m) => m.transcriptId)).toEqual([mainId])
  })

  it('list(cwd, {includeSubagent}) returns subagents too', async () => {
    const mainId = await store.create(
      { cwd: '/proj', model: 'm' },
      { cwd: '/proj' },
    )
    const subId = await store.create(
      { cwd: '/proj', model: 'm', parentSessionId: mainId, subagentType: 'explore' },
      { cwd: '/proj', subagent: true },
    )
    const list = await store.list({ cwd: '/proj', includeSubagent: true })
    expect(new Set(list.map((m) => m.transcriptId))).toEqual(new Set([mainId, subId]))
  })
})