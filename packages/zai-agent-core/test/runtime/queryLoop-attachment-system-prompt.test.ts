import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { QueryOptions, ModelCaller } from '../../src/runtime/types.js'
import { queryLoop } from '../../src/runtime/queryLoop.js'
import type { PluginRuntime, PluginSnapshot } from '../../src/plugins/types.js'
import type { LoadedSkill } from '../../src/runtime/skills/types.js'

let tmpDir: string
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zai-attach-sysprompt-'))
})
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

/** Stub PluginRuntime returning a static snapshot. */
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

function makeSkill(name: string, description: string): LoadedSkill {
  return {
    name,
    description,
    source: 'plugin',
    frontmatter: { name, description },
  }
}

interface Capture {
  systemPrompt: unknown
  messages: unknown
}

async function runQueryLoopWithCapture(options: {
  skills?: LoadedSkill[]
}): Promise<Capture> {
  let captured: Capture = { systemPrompt: undefined, messages: undefined }
  // Abort after the first model call so the messages array snapshot is stable
  // before queryLoop appends the assistant turn and loops to turn 2.
  const abortCtrl = new AbortController()
  const stub: ModelCaller = (async function* (opts: any) {
    // Shallow-copy systemPrompt (it is a readonly branded array; the reference
    // is stable but we copy it to be explicit).
    captured = {
      systemPrompt: Array.isArray(opts.systemPrompt)
        ? [...(opts.systemPrompt as unknown[])]
        : opts.systemPrompt,
      // Shallow-copy messages so post-yield mutations (appendAssistantMessage)
      // do not affect our snapshot.
      messages: [...(opts.messages as unknown[])],
    }
    yield { type: 'message_start' }
    yield {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }
    yield {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'ok' },
    }
    yield { type: 'content_block_stop', index: 0 }
    yield { type: 'message_stop' }
    // Halt immediately — prevents queryLoop from pushing the assistant turn
    // into messages and making a second model call.
    abortCtrl.abort()
  }) as any

  const cwd = process.cwd()
  const stream = queryLoop(
    {
      prompt: 'hi',
      cwd,
      model: 'stub',
      maxTurns: 1,
      enableAgentsMd: false,
    } as QueryOptions,
    {
      dataDir: tmpDir,
      modelCaller: stub,
      defaultModel: 'stub',
      pluginRuntime: makeStubPluginRuntime({ skills: options.skills ?? [] }),
      signal: abortCtrl.signal,
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
    const captured = await runQueryLoopWithCapture({
      skills: [makeSkill('demo', 'Demo skill description')],
    })

    // messages should contain ONLY the user prompt (no attachment pollution)
    const msgs = captured.messages as Array<{ role: string; content: unknown }>
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('user')

    // systemPrompt should be a string[] ending with the joined reminder.
    const sp = captured.systemPrompt as string[]
    expect(Array.isArray(sp)).toBe(true)
    const last = sp[sp.length - 1] ?? ''
    expect(last.length).toBeGreaterThan(0)
    expect(last.startsWith('<system-reminder>')).toBe(true)
    expect(last.endsWith('</system-reminder>')).toBe(true)
    expect(last).toContain('The following skill is available: demo')
  })

  test('Case 2: messages array strictly alternates user/assistant after attachment injection (no 2013)', async () => {
    const captured = await runQueryLoopWithCapture({
      skills: [makeSkill('demo', 'Demo skill description')],
    })
    const msgs = captured.messages as Array<{ role: string }>
    // Walk through messages; any consecutive same-role pair is a regression.
    for (let i = 1; i < msgs.length; i++) {
      expect(msgs[i].role).not.toBe(msgs[i - 1].role)
    }
    // And specifically: the first message must NOT be assistant (the v1.0 bug).
    expect(msgs[0].role).toBe('user')
  })

  test('Case 3: empty pluginSnapshot → no empty reminder string appended to systemPrompt', async () => {
    const captured = await runQueryLoopWithCapture({ skills: [] })
    const sp = captured.systemPrompt as string[]
    // reminderText empty → queryLoop does NOT append an empty string.
    // Verify the tail is either absent or non-empty.
    if (sp.length > 0) {
      const last = sp[sp.length - 1] ?? ''
      // If anything is at the tail, it must be substantive (not '').
      expect(last).not.toBe('')
      // And it must NOT be a `<system-reminder>` wrapper, because no skills
      // were provided.
      expect(last.startsWith('<system-reminder>')).toBe(false)
    }
  })

  test('Case 4: multi-source attachments → joined with newline, reminder tags balanced', async () => {
    const captured = await runQueryLoopWithCapture({
      skills: [
        makeSkill('alpha', 'First skill'),
        makeSkill('beta', 'Second skill'),
      ],
    })
    const sp = captured.systemPrompt as string[]
    expect(sp.length).toBeGreaterThan(0)
    const last = sp[sp.length - 1] ?? ''

    // The appended reminder entry must have balanced <system-reminder> tags.
    // Scope the match to the tail entry only (base sections may contain
    // literal `<system-reminder>` as prose, so whole-prompt counting would
    // give false positives / negatives).
    const opens = last.match(/<system-reminder>/g) ?? []
    const closes = last.match(/<\/system-reminder>/g) ?? []
    expect(opens.length).toBe(closes.length)
    expect(opens.length).toBeGreaterThanOrEqual(2) // 2 skills → ≥2 reminders

    // Joining happens with a single newline; verify both skills appear in last.
    expect(last).toContain('The following skill is available: alpha')
    expect(last).toContain('The following skill is available: beta')
    expect(last).toContain('\n') // joined, not concatenated
    // No literal "undefined" leak.
    expect(last).not.toContain('undefined')
  })

  test('Case 5: base systemPrompt sections preserved at head, reminder appended at tail', async () => {
    const captured = await runQueryLoopWithCapture({
      skills: [makeSkill('demo', 'Demo skill description')],
    })
    const sp = captured.systemPrompt as string[]
    expect(sp.length).toBeGreaterThan(1) // ≥1 base section + 1 reminder

    // The tail is the reminder wrapper.
    const last = sp[sp.length - 1] ?? ''
    expect(last).toMatch(/^<system-reminder>/)

    // Head is preserved — at least 1 entry remains before the reminder.
    const head = sp.slice(0, -1)
    expect(head.length).toBeGreaterThan(0)
    // The first (or any head) entry must NOT start with the reminder wrapper
    // — this guards against the splice replacing the whole prompt wholesale.
    expect(head.some((entry) => !entry.startsWith('<system-reminder>'))).toBe(true)
  })
})
