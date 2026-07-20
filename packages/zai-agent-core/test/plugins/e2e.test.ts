import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DefaultAgentRuntime } from '../../src/runtime/contract.js'
import { DefaultPluginRuntime } from '../../src/plugins/index.js'
import type { HookExecutor } from '../../src/plugins/types.js'

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/plugins', import.meta.url))

async function collect<T>(g: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of g) out.push(item)
  return out
}

function textOnlyModelCaller(captured: { systemPrompt?: string; tools?: Array<{ name: string }> }) {
  return (async function* (req: any) {
    captured.systemPrompt = String(req.systemPrompt)
    captured.tools = (req.tools ?? []).map((t: any) => ({ name: t.name }))
    yield { type: 'message_start', message: { id: 'm1' } }
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }
    yield { type: 'content_block_stop', index: 0 }
    yield { type: 'message_stop' }
  }) as any
}

let tmpRoot: string
let zaiPluginsDir: string

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'zai-plugin-e2e-'))
  zaiPluginsDir = join(tmpRoot, 'zai', 'plugins')
  await mkdir(zaiPluginsDir, { recursive: true })
  await cp(join(FIXTURES_DIR, 'opencc-plugin'), join(zaiPluginsDir, 'opencc-plugin'), { recursive: true })
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

describe('plugin e2e', () => {
  test('DefaultPluginRuntime 发现 OpenCC fixture 并填充 snapshot', async () => {
    const runtime = new DefaultPluginRuntime({
      zai: { pluginsDir: zaiPluginsDir },
    })
    const snapshot = await runtime.load({ cwd: tmpRoot, signal: new AbortController().signal })

    expect(snapshot.plugins.length).toBe(1)
    expect(snapshot.plugins[0]!.id).toBe('opencc-demo')

    const skillNames = snapshot.skills.map(s => s.name)
    expect(skillNames).toContain('plugin:opencc-demo:review')

    const review = snapshot.skills.find(s => s.name === 'plugin:opencc-demo:review')!
    expect(review.description).toBe('OpenCC review skill')

    // 没带 .mcp.json → 不应加载 MCP server.
    expect(snapshot.pluginMcpServerNames).toEqual([])

    // commands 也被加载为 skill: kind='command'.
    expect(skillNames).toContain('plugin:opencc-demo:build')

    // agents 也被加载.
    expect(snapshot.agents.map(a => a.name)).toContain('plugin:opencc-demo:reviewer')
  })

  test('端到端: DefaultAgentRuntime 跑出 runtime.done, plugin skill 进 system prompt, SessionStart hook 触发', async () => {
    const hookCalls: Array<{ event: string; command: string }> = []
    const hookExecutor: HookExecutor = async req => {
      hookCalls.push({ event: req.event, command: req.command })
      return { blocked: false, output: null }
    }

    const captured: { systemPrompt?: string; tools?: Array<{ name: string }> } = {}

    const runtime = new DefaultAgentRuntime({
      dataDir: tmpRoot,
      modelCaller: textOnlyModelCaller(captured),
      plugins: {
        zai: { pluginsDir: zaiPluginsDir },
        hookExecutor,
      },
    })

    const events = await collect(
      runtime.run({
        prompt: 'use the review plugin',
        cwd: tmpRoot,
      }),
    )

    expect(events.at(-1)?.type).toBe('runtime.done')

    // plugin skill 进入 system prompt 的 <skills> 段 (与 queryEngine 既有测试一致).
    expect(captured.systemPrompt).toBeDefined()
    expect(captured.systemPrompt).toContain('<name>plugin:opencc-demo:review</name>')
    expect(captured.systemPrompt).toContain('OpenCC review skill')

    // SkillTool 因为有 skills (包括 plugin skill) 而注册.
    expect(captured.tools?.some(t => t.name === 'Skill')).toBe(true)

    // SessionStart 至少被触发一次 (fixture 的 hooks/hooks.json 里有它).
    expect(hookCalls.some(c => c.event === 'SessionStart')).toBe(true)
  })

  test('ZAI 覆盖 OpenCC: 把 fixture 换成 zai-plugin 后, system prompt 用 ZAI 的 body', async () => {
    // 清掉旧的 OpenCC fixture, 拷贝 ZAI fixture 到同一 pluginsDir.
    await rm(join(zaiPluginsDir, 'opencc-plugin'), { recursive: true, force: true })
    await cp(join(FIXTURES_DIR, 'zai-plugin'), join(zaiPluginsDir, 'opencc-plugin'), { recursive: true })

    const captured: { systemPrompt?: string } = {}

    const runtime = new DefaultAgentRuntime({
      dataDir: tmpRoot,
      modelCaller: textOnlyModelCaller(captured),
      plugins: {
        zai: { pluginsDir: zaiPluginsDir },
      },
    })

    const events = await collect(
      runtime.run({
        prompt: 'use the review plugin',
        cwd: tmpRoot,
      }),
    )

    expect(events.at(-1)?.type).toBe('runtime.done')

    // ZAI 的 skill body 是 "Review via ZAI." (description 保持与 OpenCC fixture 一致,
    // 所以 system prompt <skills> 段里的 description 不变, 但 body 只在 skill 调用时才注入,
    // 而 fixture 的 SKILL.md 都被加载过; 通过 snapshot 中的 skill body 验证 ZAI 优先.)
    const pluginRuntime = new DefaultPluginRuntime({ zai: { pluginsDir: zaiPluginsDir } })
    const snapshot = await pluginRuntime.load({ cwd: tmpRoot, signal: new AbortController().signal })
    expect(snapshot.plugins.length).toBe(1)
    expect(snapshot.plugins[0]!.id).toBe('opencc-demo')

    const reviewSkill = snapshot.skills.find(s => s.name === 'plugin:opencc-demo:review')!
    expect(reviewSkill.markdown).toContain('Review via ZAI.')
    expect(reviewSkill.markdown).not.toContain('Review stub.')

    // build command 同样.
    const buildSkill = snapshot.skills.find(s => s.name === 'plugin:opencc-demo:build')!
    expect(buildSkill.markdown).toContain('Build via ZAI.')
    expect(buildSkill.markdown).not.toContain('Build stub.')
  })
})
