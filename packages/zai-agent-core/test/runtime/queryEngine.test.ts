import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { queryEngine } from '../../src/runtime/queryEngine.js'
import { makeMockModelCaller } from '../fixtures/MockModelCaller.js'
import { makeMockSandbox } from '../fixtures/MockSandbox.js'
import { TranscriptStore } from '../../src/transcript/store.js'
import type { PluginRuntime, PluginSnapshot } from '../../src/plugins/types.js'
import type { HookExecutor } from '../../src/plugins/types.js'

/**
 * Stub PluginRuntime that returns a hand-crafted PluginSnapshot on every
 * `load()`. Used by Task 6 plugin-runtime integration tests to avoid
 * pulling in the full DefaultPluginRuntime (filesystem + candidate
 * discovery). The shape returned mirrors what real plugins produce so
 * the runtime code paths exercise the same logic.
 */
function makeStubPluginRuntime(snapshot: Partial<PluginSnapshot>): PluginRuntime {
  return {
    async load() {
      return {
        plugins: [],
        skills: [],
        agents: [],
        mcpServers: [],
        pluginMcpServerNames: [],
        hooks: [],
        errors: [],
        ...snapshot,
      }
    },
    clearCache() {},
  }
}

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
        modelCaller: makeMockModelCaller('bash-then-text'),
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

  test('AGENTS.md 不存在时不报错, 默认空 systemPrompt', async () => {
    const events = await collect(queryEngine(
      { prompt: 'x', cwd: '/tmp' },
      { dataDir: tmpDir, modelCaller: makeMockModelCaller('text-only') },
    ))
    expect(events.at(-1)?.type).toBe('runtime.done')
  })

  // ---- available_agents system-prompt section -----------------------------

  test('system prompt 含 <available_agents> section, 列出 built-in agents', async () => {
    let captured: string | undefined
    const captureCaller = ((req: any) => {
      captured = String(req.systemPrompt)
      return (async function* () {
        yield { type: 'message_start', message: { id: 'm1' } }
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }
        yield { type: 'content_block_stop', index: 0 }
        yield { type: 'message_stop' }
      })()
    }) as any
    await collect(queryEngine(
      { prompt: 'x', cwd: '/tmp' },
      { dataDir: tmpDir, modelCaller: captureCaller, userAgentsDir: '' },
    ))
    expect(captured).toContain('<available_agents>')
    expect(captured).toContain('- general-purpose:')
    expect(captured).toContain('- Explore:')
    expect(captured).toContain('- Plan:')
    expect(captured).toContain('</available_agents>')
  })

  test('project agents/ 目录下的自定义 agent 也出现在 system prompt', async () => {
    // project-local custom agent
    await mkdir(`${tmpDir}/agents`, { recursive: true })
    await writeFile(`${tmpDir}/agents/custom.md`,
      `---\nname: custom\ndescription: my custom agent\n---\nCUSTOM_PROMPT`)

    let captured: string | undefined
    const captureCaller = ((req: any) => {
      captured = String(req.systemPrompt)
      return (async function* () {
        yield { type: 'message_start', message: { id: 'm1' } }
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }
        yield { type: 'content_block_stop', index: 0 }
        yield { type: 'message_stop' }
      })()
    }) as any
    await collect(queryEngine(
      { prompt: 'x', cwd: '/tmp' },
      { dataDir: tmpDir, modelCaller: captureCaller, userAgentsDir: '' },
    ))
    expect(captured).toContain('- custom: my custom agent')
    // built-ins 也仍然在
    expect(captured).toContain('- general-purpose:')
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

  // ---- transcript v2 write path (parentUuid chain + tool_use/tool_result) ----

  test('tool call → transcript 落盘 v2, parentUuid 链完整', async () => {
    const sessionId = `sess-${'1'.repeat(8)}-aaaa-bbbb-cccc-${'2'.repeat(12)}`
    // queryEngine 不会自己 create() — 在 agent route 入口会先建文件. 测试模拟这一步.
    await new TranscriptStore(tmpDir).create({ cwd: '/tmp', model: 'm' }, sessionId)
    await collect(queryEngine(
      { prompt: 'list', cwd: '/tmp', transcriptId: sessionId },
      {
        dataDir: tmpDir,
        modelCaller: makeMockModelCaller('bash-then-text'),
        sandbox: makeMockSandbox('/tmp'),
      },
    ))
    const file = await new TranscriptStore(tmpDir).read(sessionId)
    expect(file.version).toBe(2)

    // 期望顺序: user → assistant → tool_use → tool_result → assistant(text-only)
    const types = file.messages.map(m => m.type)
    expect(types).toEqual(['user', 'assistant', 'tool_use', 'user', 'assistant'])

    // 整条 parentUuid 链不应断 (没有 parentUuid === null 在非首条上)
    const uuids = file.messages.map(m => m.uuid)
    const parents = file.messages.map(m => m.parentUuid)
    expect(parents[0]).toBeNull()
    for (let i = 1; i < file.messages.length; i++) {
      // parent 应该指向 chain 里的某一条; 第一条 parent 是 null
      const prevUuid = uuids[i - 1]
      // 第二条 (assistant) 的 parent 是第一条 user, 但 tool_use 的 parent
      // 是 assistant, tool_result 的 parent 是 tool_use —— 都应该等于上一条 uuid
      expect(parents[i]).toBe(prevUuid)
    }

    // assistant 消息是 v2, 不再带 tool_uses (避免前端重复)
    const assistant = file.messages[1]!
    expect(assistant.version).toBe('2')
    expect(Array.isArray((assistant as any).message?.content)).toBe(true)
    expect((assistant as any).message.content.some((b: any) => b.type === 'tool_use')).toBe(false)

    // tool_use 单独一条 message
    const toolUse = file.messages[2]!
    expect((toolUse as any).message?.content?.[0]?.type).toBe('tool_use')
    expect((toolUse as any).message?.content?.[0]?.name).toBe('Bash')
  })

  // ---- resume regression: tool_use 单独 type 消息合并进 assistant ------
  //
  // 触发 2013 错误的根因. pre-fix: resume 时 type='tool_use' 整条 continue,
  // 模型拿到的 assistant content 只有 thinking, 但下一条 user 内容是
  // tool_result block → Anthropic API 找不到匹配的 tool_use_id 报错.
  test('resume v2 transcript: tool_use 单独消息合并进前一条 assistant content, 不漏 tool_use_id', async () => {
    // 1. 第一轮跑出一个带 tool_use + tool_result 的 v2 transcript
    const firstEvents = await collect(queryEngine(
      { prompt: 'list', cwd: '/tmp' },
      {
        dataDir: tmpDir,
        modelCaller: makeMockModelCaller('bash-then-text'),
        sandbox: makeMockSandbox('/tmp'),
      },
    ))
    expect(firstEvents.at(-1)?.type).toBe('runtime.done')

    const sessions = await new TranscriptStore(tmpDir).list()
    expect(sessions.length).toBe(1)
    const transcriptId = sessions[0]!.transcriptId

    // 确认前提: transcript 里 type='tool_use' 是单独一条消息 (这是触发 bug 的形态)
    const initial = await new TranscriptStore(tmpDir).read(transcriptId)
    expect(initial.messages.some(m => m.type === 'tool_use')).toBe(true)

    // 2. 第二轮 resume, 捕获喂给 modelCaller 的 messages 数组
    let capturedMsgs: any[] | undefined
    const captureCaller = ((req: any) => {
      capturedMsgs = req.messages
      return (async function* () {
        yield { type: 'message_start', message: { id: 'm1' } }
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'resumed' } }
        yield { type: 'content_block_stop', index: 0 }
        yield { type: 'message_stop' }
      })()
    }) as any

    await collect(queryEngine(
      { prompt: 'more', cwd: '/tmp', resumeFromTranscriptId: transcriptId },
      { dataDir: tmpDir, modelCaller: captureCaller, sandbox: makeMockSandbox('/tmp') },
    ))

    expect(capturedMsgs).toBeTruthy()

    // 找到含 tool_result 的 user 消息
    const toolResultMsg = capturedMsgs!.find(m =>
      m.role === 'user' && Array.isArray(m.content) &&
      (m.content as any[]).some((b: any) => b.type === 'tool_result'),
    )
    expect(toolResultMsg).toBeTruthy()
    const trBlock = (toolResultMsg!.content as any[]).find(b => b.type === 'tool_result')!

    // 必须存在 assistant 消息, 其 content 含一个 tool_use block, 且 id === tool_use_id
    const assistantWithMatchingToolUse = capturedMsgs!.find(m =>
      m.role === 'assistant' && Array.isArray(m.content) &&
      (m.content as any[]).some(
        (b: any) => b.type === 'tool_use' && b.id === trBlock.tool_use_id,
      ),
    )
    expect(assistantWithMatchingToolUse).toBeTruthy()

    // 该 assistant 消息的索引必须严格小于 tool_resultMsg 的索引 (顺序保证)
    const assistantIdx = capturedMsgs!.indexOf(assistantWithMatchingToolUse!)
    const trIdx = capturedMsgs!.indexOf(toolResultMsg!)
    expect(assistantIdx).toBeGreaterThanOrEqual(0)
    expect(trIdx).toBeGreaterThan(assistantIdx)
  })

  // ---- plugin runtime integration (Task 6) ------------------------------
  //
  // 这些测试只验证 queryEngine 在 pluginRuntime 存在时的行为:
  //   1. plugin skill 进 system prompt
  //   2. PreToolUse 阻断路径
  //   3. Stop 阻断路径 (空输出 → runtime.done; 非空输出 → continue)
  //
  // Plugin runtime 通过 stub 实现, 不走真实文件系统/discovery, 见
  // `makeStubPluginRuntime`. Hook executor 通过 `config.plugins.hookExecutor`
  // 注入 (queryEngine 内部已经走这条路径).

  test('pluginRuntime stub: skill 进 system prompt 的 <skills> 段', async () => {
    const pluginRuntime = makeStubPluginRuntime({
      skills: [{
        name: 'plugin:demo:review',
        description: 'Review code via plugin',
        source: 'plugin',
        pluginId: 'demo',
        baseDir: '/tmp/demo/skills/review',
        filePath: '/tmp/demo/skills/review/SKILL.md',
        frontmatter: { description: 'Review code via plugin', name: 'review' },
        markdown: 'PLUGIN_SKILL_BODY',
      }],
    })
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
      { prompt: 'x', cwd: '/tmp' },
      { dataDir: tmpDir, modelCaller: captureCaller, pluginRuntime, userAgentsDir: '' },
    ))
    expect(events.at(-1)?.type).toBe('runtime.done')
    expect(calls[0]!.systemPrompt).toContain('<skills>')
    expect(calls[0]!.systemPrompt).toContain('<name>plugin:demo:review</name>')
    // plugin skill body 不应进入 system prompt (与已有 skills 测试一致)
    expect(calls[0]!.systemPrompt).not.toContain('PLUGIN_SKILL_BODY')
  })

  test('pluginRuntime 缺省: system prompt 不应含任何 plugin skill', async () => {
    // 反向 sanity check: 没有 pluginRuntime 时 plugin skill 不该出现在 prompt.
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
    await collect(queryEngine(
      { prompt: 'x', cwd: '/tmp' },
      { dataDir: tmpDir, modelCaller: captureCaller, userAgentsDir: '' },
    ))
    expect(calls[0]!.systemPrompt).not.toContain('plugin:demo:review')
  })

  test('PreToolUse hook blocked → tool_use:denied, Bash 不执行', async () => {
    // 用 fake hookExecutor + 显式注册一个 PreToolUse hook: 任意 hook 都立即返回 blocked:true.
    // 这里需要 Bash 走到 PreToolUse 阶段并被阻断. 用 makeMockModelCaller
    // 的 'bash-then-text' 场景: 第一轮模型返回 Bash tool_use; 如果 PreToolUse
    // 阻断了, 第二轮模型才返回 text-only done.
    const hookExecutor: HookExecutor = async () => ({ blocked: true, output: 'denied-by-test-hook' })
    const pluginRuntime = makeStubPluginRuntime({
      hooks: [{ event: 'PreToolUse', command: 'fake-pre', pluginId: 'demo', pluginRoot: '/tmp/demo' }],
    })
    const events = await collect(queryEngine(
      { prompt: 'run', cwd: tmpDir },
      {
        dataDir: tmpDir,
        modelCaller: makeMockModelCaller('bash-then-text'),
        sandbox: makeMockSandbox(tmpDir),
        pluginRuntime,
        plugins: { hookExecutor },
      },
    ))
    // 1. tool_use:denied 事件出现
    expect(events.some(e => e.type === 'tool_use:denied')).toBe(true)
    // 2. tool_use:start / tool_use:done 不应出现 (Bash 被阻断, 没真跑)
    expect(events.some(e => e.type === 'tool_use:start')).toBe(false)
    expect(events.some(e => e.type === 'tool_use:done')).toBe(false)
    // 3. 仍然走到 runtime.done (模型在第二轮给 text-only)
    expect(events.at(-1)?.type).toBe('runtime.done')
  })

  test('Stop hook blocked with empty output → runtime.done', async () => {
    // hook 返回 blocked 但 outputs 为空 → 视为正常停止, 仍 yield runtime.done.
    const hookExecutor: HookExecutor = async () => ({ blocked: true, output: '' })
    const pluginRuntime = makeStubPluginRuntime({
      hooks: [{ event: 'Stop', command: 'fake-stop', pluginId: 'demo', pluginRoot: '/tmp/demo' }],
    })
    const events = await collect(queryEngine(
      { prompt: 'x', cwd: '/tmp' },
      {
        dataDir: tmpDir,
        modelCaller: makeMockModelCaller('text-only'),
        pluginRuntime,
        plugins: { hookExecutor },
      },
    ))
    expect(events.at(-1)?.type).toBe('runtime.done')
  })

  test('Stop hook blocked with non-empty output → 继续下一轮, 不 yield runtime.done', async () => {
    // 第一轮: text-only done (但 Stop hook 输出要追加 user, 模型需要第二轮).
    // 第二轮: 再 text-only done (这轮 Stop hook 也返回空, 真正结束).
    let turn = 0
    const modelCaller = (async function* (req: any) {
      turn++
      yield { type: 'message_start', message: { id: `m${turn}` } }
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `r${turn}` } }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_stop' }
    }) as any
    // hook 行为: 第一轮返回 blocked + 非空 output → 继续; 第二轮返回 blocked 但空 → runtime.done.
    let hookCallCount = 0
    const hookExecutor: HookExecutor = async () => {
      hookCallCount++
      if (hookCallCount === 1) {
        return { blocked: true, output: 'continue-this-turn' }
      }
      return { blocked: true, output: '' }
    }
    const pluginRuntime = makeStubPluginRuntime({
      hooks: [{ event: 'Stop', command: 'fake-stop', pluginId: 'demo', pluginRoot: '/tmp/demo' }],
    })
    const events = await collect(queryEngine(
      { prompt: 'x', cwd: '/tmp' },
      { dataDir: tmpDir, modelCaller, pluginRuntime, plugins: { hookExecutor } },
    ))
    // 模型被叫了两次 (被 hook 输出强制继续了一次)
    expect(turn).toBe(2)
    expect(hookCallCount).toBeGreaterThanOrEqual(1)
    // 最终 runtime.done (第二轮 Stop 阻断但 output 空 → 视为正常结束)
    expect(events.at(-1)?.type).toBe('runtime.done')
    // 关键: 第一轮的 Stop blocked + 非空 output 不能提前 yield runtime.done.
    // 如果 runtime 提前结束, turn 不会到 2.
  })

  test('pluginRuntime 缺省时 PreToolUse 不存在 → Bash 正常执行', async () => {
    // 反向: 没配 hookExecutor / pluginRuntime 时, Bash 应正常执行 (与既有
    // 'bash-then-text' 测试呼应). 防止 hook 路径误报 denylist.
    const events = await collect(queryEngine(
      { prompt: 'list', cwd: '/tmp' },
      {
        dataDir: tmpDir,
        modelCaller: makeMockModelCaller('bash-then-text'),
        sandbox: makeMockSandbox('/tmp'),
      },
    ))
    expect(events.some(e => e.type === 'tool_use:start')).toBe(true)
    expect(events.some(e => e.type === 'tool_use:done')).toBe(true)
    expect(events.at(-1)?.type).toBe('runtime.done')
  })
})
