import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { QueryOptions, ModelCaller } from '../../src/runtime/types.js'
import type { PluginRuntime, PluginSnapshot } from '../../src/plugins/types.js'
import type { LoadedSkill } from '../../src/runtime/skills/types.js'
import { queryLoop } from '../../src/runtime/queryLoop.js'

let tmpDir: string
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zai-attach-sysprompt-'))
})
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

interface Capture {
  systemPrompt: unknown
  messages: unknown
}

function makeStubPluginRuntime(snapshot: Partial<PluginSnapshot>): PluginRuntime {
  return {
    async load() {
      return {
        plugins: [], skills: [], agents: [], mcpServers: [],
        pluginMcpServerNames: [], hooks: [], errors: [], ...snapshot,
      }
    },
    clearCache() {},
  }
}

function makeSkill(name: string, description: string): LoadedSkill {
  return {
    name, description, source: 'plugin',
    frontmatter: { name, description },
  }
}

async function runQueryLoopWithCapture(options: {
  skills?: LoadedSkill[]
}): Promise<Capture> {
  let captured: Capture = { systemPrompt: undefined, messages: undefined }
  const stub: ModelCaller = (async function* (opts: any) {
    // DEEP-CLONE messages — queryLoop mutates this array after model returns.
    captured = {
      systemPrompt: Array.isArray(opts.systemPrompt)
        ? [...(opts.systemPrompt as unknown[])]
        : opts.systemPrompt,
      messages: JSON.parse(JSON.stringify(opts.messages ?? [])),
    }
    yield { type: 'message_start' }
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }
    yield { type: 'content_block_stop', index: 0 }
    yield { type: 'message_stop' }
  }) as any

  const cwd = process.cwd()
  const stream = queryLoop(
    { prompt: 'hi', cwd, model: 'stub', maxTurns: 1, enableAgentsMd: false } as QueryOptions,
    {
      dataDir: tmpDir, modelCaller: stub, defaultModel: 'stub',
      pluginRuntime: makeStubPluginRuntime({ skills: options.skills ?? [] }),
    } as any,
  )
  for await (const _ of stream) { /* drain */ }
  return captured
}

function flattenSystemPrompt(sp: unknown): string {
  if (typeof sp === 'string') return sp
  if (Array.isArray(sp)) return (sp as unknown[]).map((s) => String(s)).join('\n')
  return ''
}

describe('integration: queryLoop splices attachments into systemPrompt (v1.1)', () => {
  test('Case 1: fresh session + skill-prefetch → messages has only user prompt, systemPrompt gains <system-reminder>', async () => {
    const captured = await runQueryLoopWithCapture({ skills: [makeSkill('demo', 'Demo skill description')] })

    const msgs = captured.messages as Array<{ role: string; content: unknown }>
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('user')

    const sp = captured.systemPrompt as string[]
    expect(Array.isArray(sp)).toBe(true)
    const last = sp[sp.length - 1] ?? ''
    expect(last.length).toBeGreaterThan(0)
    expect(last.startsWith('<system-reminder>')).toBe(true)
    expect(last.endsWith('</system-reminder>')).toBe(true)
    expect(last).toContain('The following skill is available: demo')
  })

  test('Case 2: messages array strictly alternates user/assistant (no 2013 regression)', async () => {
    const captured = await runQueryLoopWithCapture({ skills: [makeSkill('demo', 'Demo skill description')] })
    const msgs = captured.messages as Array<{ role: string }>
    for (let i = 1; i < msgs.length; i++) {
      expect(msgs[i].role).not.toBe(msgs[i - 1].role)
    }
    expect(msgs[0].role).toBe('user')
  })

  test('Case 3: empty pluginSnapshot → no empty reminder string appended to systemPrompt', async () => {
    const captured = await runQueryLoopWithCapture({ skills: [] })
    const sp = captured.systemPrompt as string[]
    if (sp.length > 0) {
      const last = sp[sp.length - 1] ?? ''
      expect(last).not.toBe('')
      expect(last.startsWith('<system-reminder>')).toBe(false)
    }
  })

  test('Case 4: multi-source attachments → joined with newline, reminder tags balanced', async () => {
    const captured = await runQueryLoopWithCapture({
      skills: [makeSkill('alpha', 'First skill'), makeSkill('beta', 'Second skill')],
    })
    const sp = captured.systemPrompt as string[]
    expect(sp.length).toBeGreaterThan(0)
    const last = sp[sp.length - 1] ?? ''
    const opens = last.match(/<system-reminder>/g) ?? []
    const closes = last.match(/<\/system-reminder>/g) ?? []
    expect(opens.length).toBe(closes.length)
    expect(opens.length).toBeGreaterThanOrEqual(2)
    expect(last).toContain('The following skill is available: alpha')
    expect(last).toContain('The following skill is available: beta')
    expect(last).toContain('\n')
    expect(last).not.toContain('undefined')
  })

  test('Case 5: base systemPrompt sections preserved at head, reminder appended at tail', async () => {
    const captured = await runQueryLoopWithCapture({ skills: [makeSkill('demo', 'Demo skill description')] })
    const sp = captured.systemPrompt as string[]
    expect(sp.length).toBeGreaterThan(1)
    const last = sp[sp.length - 1] ?? ''
    expect(last).toMatch(/^<system-reminder>/)
    const head = sp.slice(0, -1)
    expect(head.length).toBeGreaterThan(0)
    expect(head.some((entry) => !entry.startsWith('<system-reminder>'))).toBe(true)
  })
})
