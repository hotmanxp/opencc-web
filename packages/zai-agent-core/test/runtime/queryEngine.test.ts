import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { queryEngine } from '../../src/runtime/queryEngine.js'
import { makeMockModelCaller } from '../fixtures/MockModelCaller.js'
import { makeMockSandbox } from '../fixtures/MockSandbox.js'
import { TranscriptStore } from '../../src/transcript/store.js'
import { getLastCacheSafeParams, saveCacheSafeParams } from '../../src/opencc-internals/utils/forkedAgent.js'

async function collect(g: AsyncGenerator<any>) {
  const out: any[] = []
  for await (const e of g) out.push(e)
  return out
}

let tmpDir: string
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'zai-qe-')) })
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }) })

describe('queryEngine', () => {
  test('无 modelCaller → runtime.error(no modelCaller configured)', async () => {
    const events = await collect(queryEngine(
      { prompt: 'hi', cwd: '/tmp' },
      { dataDir: tmpDir },
    ))
    expect(events.at(-1)?.type).toBe('runtime.error')
    expect(events.at(-1)?.error?.message).toMatch(/no modelCaller configured/)
  })

  test('text-only happy path → ends with runtime.done', async () => {
    const events = await collect(queryEngine(
      { prompt: 'hi', cwd: '/tmp' },
      { dataDir: tmpDir, modelCaller: makeMockModelCaller('text-only') },
    ))
    expect(events.at(-1)?.type).toBe('runtime.done')
    expect(events.some(e => e.type === 'message_start')).toBe(true)
    expect(events.some(e => e.type === 'content_block_delta')).toBe(true)
  })

  test('tool call: Bash 跑 echo, 输出回流 → 第二轮 done', async () => {
    const events = await collect(queryEngine(
      { prompt: 'list', cwd: '/tmp' },
      {
        dataDir: tmpDir,
        modelCaller: makeMockModelCaller('one-tool'),
        sandbox: makeMockSandbox('/tmp'),
      },
    ))
    expect(events.some(e => e.type === 'tool_use:start')).toBe(true)
    expect(events.some(e => e.type === 'tool_use:done')).toBe(true)
    expect(events.at(-1)?.type).toBe('runtime.done')
  })

  test('maxTurns=5 + infinite-loop → runtime.error(code: max_turns_reached)', async () => {
    const events = await collect(queryEngine(
      { prompt: 'loop', cwd: '/tmp', maxTurns: 5 },
      {
        dataDir: tmpDir,
        modelCaller: makeMockModelCaller('infinite-loop'),
        sandbox: makeMockSandbox('/tmp'),
      },
    ))
    const err = events.find(e => e.type === 'runtime.error')
    expect(err).toBeTruthy()
    expect(err?.error?.code).toBe('max_turns_reached')
  })

  test('abort signal → runtime.aborted 事件', async () => {
    const controller = new AbortController()
    const events: any[] = []
    const iter = queryEngine(
      { prompt: 'x', cwd: '/tmp', abortSignal: controller.signal },
      { dataDir: tmpDir, modelCaller: makeMockModelCaller('infinite-loop'), sandbox: makeMockSandbox('/tmp') },
    )
    setTimeout(() => controller.abort(), 20)
    for await (const e of iter) {
      events.push(e)
      if (e.type === 'runtime.aborted' || e.type === 'runtime.error') break
    }
    expect(events.some(e => e.type === 'runtime.aborted' || e.type === 'runtime.error')).toBe(true)
  })

  test('queryEngine saves CacheSafeParams after each turn', async () => {
    saveCacheSafeParams(null)
    const events = await collect(queryEngine(
      { prompt: 'hi', cwd: '/tmp' },
      { dataDir: tmpDir, modelCaller: makeMockModelCaller('text-only') },
    ))
    expect(events.at(-1)?.type).toBe('runtime.done')
    const snapshot = getLastCacheSafeParams()
    expect(snapshot).not.toBeNull()
    expect(String(snapshot?.systemPrompt).length).toBeGreaterThan(0)
  })
  test('AGENTS.md 不存在时不报错, 默认空 systemPrompt', async () => {
    const events = await collect(queryEngine(
      { prompt: 'x', cwd: '/tmp' },
      { dataDir: tmpDir, modelCaller: makeMockModelCaller('text-only') },
    ))
    expect(events.at(-1)?.type).toBe('runtime.done')
  })

  test('sessionId 在 events 上有', async () => {
    const events = await collect(queryEngine(
      { prompt: 'x', cwd: '/tmp' },
      { dataDir: tmpDir, modelCaller: makeMockModelCaller('text-only') },
    ))
    expect(events[0]?.sessionId).toMatch(/^sess-/)
  })

  // ---- skills (Task 6) ---------------------------------------------------

  async function setupSkillsDir(relPath: string, fm: string, body = 'BODY'): Promise<string> {
    const dir = `${tmpDir}/skills/${relPath}`
    await mkdir(dir, { recursive: true })
    await writeFile(`${dir}/SKILL.md`, `---\n${fm}\n---\n${body}`, 'utf-8')
    return `${tmpDir}/skills`
  }

  test('skillsDirs 非空 → SkillTool 出现在 tools, system prompt 含 <skills>', async () => {
    const skillsDir = await setupSkillsDir('pdf', 'description: Read PDFs', 'PDF body')
    const calls: Array<{ tools: Array<{ name: string }>; systemPrompt: string }> = []
    const captureCaller = ((req: any) => {
      calls.push({ tools: req.tools, systemPrompt: String(req.systemPrompt) })
      return (async function* () {
        yield { type: 'message_start', message: { id: 'm1' } }
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }
        yield { type: 'content_block_stop', index: 0 }
        yield { type: 'message_stop' }
      })()
    }) as any
    const events = await collect(queryEngine(
      { prompt: 'hi', cwd: '/tmp' },
      { dataDir: tmpDir, modelCaller: captureCaller, skillsDirs: [skillsDir] },
    ))
    expect(events.at(-1)?.type).toBe('runtime.done')
    expect(calls[0]!.tools.some(t => t.name === 'Skill')).toBe(true)
    expect(calls[0]!.systemPrompt).toContain('<skills>')
    expect(calls[0]!.systemPrompt).toContain('<name>pdf</name>')
    expect(calls[0]!.systemPrompt).toContain('Read PDFs')
    // body 不暴露在 system prompt
    expect(calls[0]!.systemPrompt).not.toContain('PDF body')
  })

  test('skillsDirs 缺失 → SkillTool 不注册, system prompt 无 <skills>', async () => {
    const calls: Array<{ tools: Array<{ name: string }>; systemPrompt: string }> = []
    const captureCaller = ((req: any) => {
      calls.push({ tools: req.tools, systemPrompt: String(req.systemPrompt) })
      return (async function* () {
        yield { type: 'message_start', message: { id: 'm1' } }
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }
        yield { type: 'content_block_stop', index: 0 }
        yield { type: 'message_stop' }
      })()
    }) as any
    const events = await collect(queryEngine(
      { prompt: 'hi', cwd: '/tmp' },
      { dataDir: tmpDir, modelCaller: captureCaller },
    ))
    expect(events.at(-1)?.type).toBe('runtime.done')
    expect(calls[0]!.tools.some(t => t.name === 'Skill')).toBe(false)
    expect(calls[0]!.systemPrompt).not.toContain('<skills>')
  })

  test('SkillTool 调不存在的 skill → tool_result isError=true', async () => {
    const skillsDir = await setupSkillsDir('pdf', 'description: x')
    const events = await collect(queryEngine(
      { prompt: 'hi', cwd: '/tmp', maxTurns: 4 },
      {
        dataDir: tmpDir,
        modelCaller: makeMockModelCaller('skill-not-found'),
        sandbox: makeMockSandbox('/tmp'),
        skillsDirs: [skillsDir],
      },
    ))
    // SkillTool 找不到时返回 isError=true, 内容含 not found.
    const toolDone = events.find(e => e.type === 'tool_use:done') as any
    expect(toolDone).toBeTruthy()
    expect(String(toolDone?.output ?? '')).toContain("'nope' not found")
    // 该 mock 每次都返回 Skill(nope), 会到 maxTurns 撞 max_turns_reached.
    const err = events.find(e => e.type === 'runtime.error') as any
    expect(err?.error?.code).toBe('max_turns_reached')
  })

  test('SkillTool 调用成功 → 追加 user message 含 skill body, transcript 落盘', async () => {
    const skillsDir = await setupSkillsDir('pdf', 'description: x', 'INJECT-BODY-XYZ')
    const events = await collect(queryEngine(
      { prompt: 'hi', cwd: '/tmp' },
      {
        dataDir: tmpDir,
        modelCaller: makeMockModelCaller('skill-call-then-text'),
        sandbox: makeMockSandbox('/tmp'),
        skillsDirs: [skillsDir],
      },
    ))
    expect(events.at(-1)?.type).toBe('runtime.done')
    // transcript 中应能找到含 INJECT-BODY-XYZ 的 user message (skill body 已落盘).
    const store = new TranscriptStore(tmpDir)
    const sessions = await store.list()
    expect(sessions.length).toBeGreaterThan(0)
    const t = await store.read(sessions[0]!.transcriptId)
    const allText = JSON.stringify(t.messages)
    expect(allText).toContain('INJECT-BODY-XYZ')
  })

  test('一个 SKILL.md frontmatter 损坏 → 其他 skill 仍加载', async () => {
    const skillsDir = `${tmpDir}/skills`
    await mkdir(`${skillsDir}/good`, { recursive: true })
    await writeFile(`${skillsDir}/good/SKILL.md`, '---\ndescription: good\n---\nbody', 'utf-8')
    await mkdir(`${skillsDir}/bad`, { recursive: true })
    await writeFile(`${skillsDir}/bad/SKILL.md`, '---\nno closing', 'utf-8')
    const calls: Array<{ systemPrompt: string }> = []
    const captureCaller = ((req: any) => {
      calls.push({ systemPrompt: String(req.systemPrompt) })
      return (async function* () {
        yield { type: 'message_start', message: { id: 'm1' } }
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }
        yield { type: 'content_block_stop', index: 0 }
        yield { type: 'message_stop' }
      })()
    }) as any
    const events = await collect(queryEngine(
      { prompt: 'hi', cwd: '/tmp' },
      { dataDir: tmpDir, modelCaller: captureCaller, skillsDirs: [skillsDir] },
    ))
    expect(events.at(-1)?.type).toBe('runtime.done')
    expect(calls[0]!.systemPrompt).toContain('<name>good</name>')
    expect(calls[0]!.systemPrompt).not.toContain('<name>bad</name>')
  })
})
