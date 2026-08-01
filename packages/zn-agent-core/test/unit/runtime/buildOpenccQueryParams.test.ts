import { describe, expect, it, vi } from 'vitest'
import { buildOpenccQueryParams } from '../../../src/compat/runtime/buildOpenccQueryParams.js'
import type { QueryOptions } from '../../../src/compat/runtime/types.js'

const minimalOpts: QueryOptions = {
  prompt: { role: 'user', content: 'hi' },
  cwd: '/tmp',
  model: 'm',
  tools: [],
  sessionId: 's-test',
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of gen) out.push(x)
  return out
}

describe('buildOpenccQueryParams — deps.callModel translator', () => {
  it('throws clear "not implemented" when no modelCaller is supplied', async () => {
    const params = await buildOpenccQueryParams(minimalOpts, {})
    const callModel = params.deps!.callModel as any
    await expect(callModel({ messages: [], signal: new AbortController().signal }))
      .rejects.toThrow(/deps\.callModel not implemented/)
  })

  it('translates opencc request → zai ModelCaller shape and yields events through', async () => {
    const fakeEvents = [
      { type: 'message_start', message: { id: 'm1' } },
      { type: 'content_block_start', index: 0 },
      { type: 'message_stop' },
    ]
    async function* fakeZaiStream() {
      for (const ev of fakeEvents) yield ev
    }
    const modelCaller = vi.fn().mockReturnValue(fakeZaiStream())

    const params = await buildOpenccQueryParams(minimalOpts, {
      modelCaller: modelCaller as any,
    })

    const openccReq = {
      messages: [{ role: 'user', content: 'hello' }],
      systemPrompt: 'sys',
      tools: [{ name: 'Bash' }],
      signal: new AbortController().signal,
      options: { model: 'claude-test' },
    }
    const events = await collect(params.deps!.callModel(openccReq as any) as AsyncIterable<any>)

    // zai ModelCaller was called once with the translated request
    expect(modelCaller).toHaveBeenCalledTimes(1)
    const zaiReq = modelCaller.mock.calls[0][0]
    expect(zaiReq.model).toBe('claude-test')
    expect(zaiReq.systemPrompt).toBe('sys')
    // zaiReq.messages is a NEW array (filter strips non-user/assistant
    // shapes — see `buildOpenccQueryParams — filters non-conversational
    // message shapes` below). The single user message should pass
    // through with the same role + content.
    expect(zaiReq.messages).toEqual([{ role: 'user', content: 'hello' }])
    expect(zaiReq.tools).toBe(openccReq.tools)
    expect(zaiReq.signal).toBe(openccReq.signal)
    // thinkingConfig intentionally dropped (not in zai shape)
    expect('thinkingConfig' in zaiReq).toBe(false)

    // Events from zai stream pass through untransformed
    expect(events).toEqual(fakeEvents)
  })

  it('uses "unknown" model when openccReq.options.model is absent', async () => {
    async function* empty() { /* no events */ }
    const modelCaller = vi.fn().mockReturnValue(empty())

    const params = await buildOpenccQueryParams(minimalOpts, {
      modelCaller: modelCaller as any,
    })

    await collect(params.deps!.callModel({
      messages: [],
      systemPrompt: '',
      tools: [],
      signal: new AbortController().signal,
    } as any) as AsyncIterable<any>)

    expect(modelCaller.mock.calls[0][0].model).toBe('unknown')
  })
})

describe('buildOpenccQueryParams — filters non-conversational message shapes', () => {
  // Regression (Bug G): after every tool execution opencc emits an
  // `attachment` message (e.g. `{type:'attachment', attachment:{type:
  // 'agent_listing_delta', ...}}`) to drive UI-only state. The
  // previous translator blindly mapped every opencc message to
  // `{role, content}` via `m.message ?? m` — for attachment messages
  // that landed `m.attachment` in `content` and left `role` undefined.
  // Sending `{role:undefined, content:<object>}` to the upstream
  // MiniMax-M3 / Anthropic-compatible API returned 400 "invalid
  // params, Syntax error no sources available, the input json is
  // empty", which the user saw as "AskUserQuestion completed with no
  // output, conversation stops" — the LLM never got a chance to
  // continue because the follow-up turn's request was rejected before
  // streaming. The fix filters attachment / system / other non
  // user+assistant messages at the boundary so only real
  // conversational messages reach the wire.
  it('translates opencc attachment messages into user system-reminder text', async () => {
    // Regression (Bug G — refined):
    //
    // opencc emits `attachment` SDK messages after every tool
    // execution — e.g. `{type:'attachment', attachment:{type:
    // 'agent_listing_delta', addedLines:[...], ...}}` carrying
    // model-facing metadata. The previous translator blindly
    // mapped every opencc message to `{role, content}` via
    // `m.message ?? m` — for attachment messages that landed
    // `m.attachment` in `content` and left `role` undefined, so
    // the request reached the upstream Anthropic-compatible API as
    // `{role:undefined, content:<object>}` and was rejected with
    // 400 "invalid params, Syntax error no sources available, the
    // input json is empty" (2013). The LLM never got a chance to
    // continue because the follow-up turn was rejected before
    // streaming.
    //
    // The current fix is to call vendor's
    // `normalizeAttachmentForAPI` (opencc-src/utils/messages.ts:2304)
    // so each attachment is rendered into user `<system-reminder>`
    // text blocks BEFORE reaching the wire. Translator-level
    // review flagged the prior broad-drop filter as functionally
    // lossy (it dropped `plan_mode_reentry` / `relevant_memories` /
    // etc. along with the agent list), so the contract is now:
    // attachments are TRANSLATED, not dropped.
    //
    // Note: this test uses a vendor-valid attachment shape
    // (`addedLines` + `removedTypes` + `isInitial`) — the previous
    // version of this test passed accidentally by feeding
    // `addedTypes` (not a vendor field), which caused
    // `normalizeAttachmentForAPI` to throw on
    // `attachment.addedLines.length` and fall through the catch in
    // compat, returning `[]`. With a valid shape, vendor returns
    // one user message; the surviving zaiMessages count rises to
    // 4 (3 user/assistant + 1 translated).
    async function* empty() {}
    const modelCaller = vi.fn().mockReturnValue(empty())
    const params = await buildOpenccQueryParams(minimalOpts, {
      modelCaller: modelCaller as any,
    })
    await collect(params.deps!.callModel({
      messages: [
        { type: 'user', message: { role: 'user', content: 'use AskUserQuestion' } },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call_1', name: 'AskUserQuestion', input: {} }],
            stop_reason: 'tool_use',
          },
        },
        {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', content: 'ok', tool_use_id: 'call_1' }],
          },
        },
        // opencc attachment carrying the agent listing — must be
        // translated into a user text block, NOT sent raw.
        {
          type: 'attachment',
          attachment: {
            type: 'agent_listing_delta',
            addedTypes: ['Explore', 'general-purpose'],
            addedLines: [
              '- Explore: read-only codebase explorer',
              '- general-purpose: general-purpose research agent',
            ],
            removedTypes: [],
            isInitial: true,
            showConcurrencyNote: false,
          },
          uuid: 'att-1',
          timestamp: '2026-08-01T00:00:00.000Z',
        },
      ],
      systemPrompt: 'sys',
      tools: [],
      signal: new AbortController().signal,
      options: { model: 'm' },
    } as any) as AsyncIterable<any>)

    const zaiReq = modelCaller.mock.calls[0][0]
    // 3 user/assistant messages + 1 translated-from-attachment
    // user message (vendor's `agent_listing_delta` renders a user
    // `<system-reminder>` block when addedLines is non-empty).
    expect(zaiReq.messages).toHaveLength(4)
    // All surviving messages have valid role + content (no undefined).
    for (const m of zaiReq.messages) {
      expect(['user', 'assistant']).toContain(m.role)
      expect(['string', 'object']).toContain(typeof m.content)
    }
    // Specifically: the translated-from-attachment message is a
    // user-role string containing the agent list (NOT a raw
    // attachment object — that would re-trigger 2013).
    const translated = zaiReq.messages.find(
      (m: any) =>
        typeof m.content === 'string' &&
        /Available agent types|New agent types/.test(m.content),
    )
    expect(translated).toBeDefined()
  })

  it('preserves user and assistant messages with tool_use / tool_result', async () => {
    async function* empty() {}
    const modelCaller = vi.fn().mockReturnValue(empty())
    const params = await buildOpenccQueryParams(minimalOpts, {
      modelCaller: modelCaller as any,
    })
    await collect(params.deps!.callModel({
      messages: [
        { type: 'user', message: { role: 'user', content: 'hi' } },
        { type: 'assistant', message: { role: 'assistant', content: 'hello back' } },
        { type: 'user', message: { role: 'user', content: 'followup' } },
      ],
      systemPrompt: 'sys',
      tools: [],
      signal: new AbortController().signal,
      options: { model: 'm' },
    } as any) as AsyncIterable<any>)

    const zaiReq = modelCaller.mock.calls[0][0]
    expect(zaiReq.messages.map((m: any) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ])
  })

  it('translates plan_mode_reentry into user system-reminder text (regression vs broad-drop)', async () => {
    // Verifier flagged the broad-drop filter as functionally lossy:
    //   the previous filter dropped `plan_mode_reentry` along with
    //   `agent_listing_delta`. plan_mode_reentry carries a one-shot
    //   re-entry flag and tells the model to read the previous plan
    //   file, evaluate it, and edit it before exiting plan mode. If
    //   we drop it, the model loses the only signal that it should
    //   re-enter plan mode. Vendor's normalizeAttachmentForAPI
    //   translates it into a user `<system-reminder>` text block.
    async function* empty() {}
    const modelCaller = vi.fn().mockReturnValue(empty())
    const params = await buildOpenccQueryParams(minimalOpts, {
      modelCaller: modelCaller as any,
    })
    await collect(params.deps!.callModel({
      messages: [
        { type: 'user', message: { role: 'user', content: 'resume after exit' } },
        {
          type: 'attachment',
          attachment: {
            type: 'plan_mode_reentry',
            planFilePath: '/tmp/plan.md',
          },
          uuid: 'att-pm',
          timestamp: '2026-08-01T00:00:00.000Z',
        },
      ],
      systemPrompt: 'sys',
      tools: [],
      signal: new AbortController().signal,
      options: { model: 'm' },
    } as any) as AsyncIterable<any>)

    const zaiReq = modelCaller.mock.calls[0][0]
    // The attachment translated into one or more user messages; the
    // plan-mode reentry state MUST reach the LLM (vendor renders it
    // as a `<system-reminder>` text block mentioning plan-mode).
    expect(zaiReq.messages.length).toBeGreaterThanOrEqual(2)
    const serialized = JSON.stringify(zaiReq.messages)
    // Vendor text contains "Re-entering Plan Mode" + the plan path
    // we passed in. Either of those being present confirms the
    // reentry state reached the LLM (instead of being dropped).
    expect(
      /Re-entering Plan Mode|plan[_-]mode/i.test(serialized) ||
        /\/tmp\/plan\.md/.test(serialized),
    ).toBe(true)
  })
})

describe('buildOpenccQueryParams — toolPermissionContext', () => {
  describe('buildOpenccQueryParams — toolPermissionContext (via toolUseContext)', () => {
  it('exposes mode "bypassPermissions" so vendor short-circuits headless deny', async () => {
    const params = await buildOpenccQueryParams(minimalOpts, {})
    const tpc = await params.toolUseContext.getToolPermissionContext()
    expect(tpc.mode).toBe('bypassPermissions')
  })

  it('keeps shouldAvoidPermissionPrompts true (transcriptTooLong boundary at vendor permissions.ts:825)', async () => {
    const params = await buildOpenccQueryParams(minimalOpts, {})
    const tpc = await params.toolUseContext.getToolPermissionContext()
    expect(tpc.shouldAvoidPermissionPrompts).toBe(true)
  })

  it('keeps isBypassPermissionsModeAvailable true', async () => {
    const params = await buildOpenccQueryParams(minimalOpts, {})
    const tpc = await params.toolUseContext.getToolPermissionContext()
    expect(tpc.isBypassPermissionsModeAvailable).toBe(true)
  })

  it('always-allow rule covers the 7 vendor core tools (Bash/Read/Edit/Write/Glob/Grep/AskUserQuestion)', async () => {
    const params = await buildOpenccQueryParams(minimalOpts, {})
    const tpc = await params.toolUseContext.getToolPermissionContext()
    expect([...tpc.alwaysAllowRules.session].sort()).toEqual(
      ['AskUserQuestion', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'].sort(),
    )
  })
})
})

describe('buildOpenccQueryParams — agentDefinitions (sub-agent prompt injection)', () => {
  // 前情: 修复前 compat 把 agentDefinitions 硬编码成
  //   { agents: [], builtinAgents: [], customAgents: [], forAgents: new Map() }
  // 这两点都不对:
  //   1. 内容永远是空 — AgentTool.prompt 拿 activeAgents 渲染 sub-agent list,
  //      LLM 看不到任何可用的 sub-agent, 自然也不知道能派 AgentTool。
  //   2. 形状也不对 — vendor 期望 { activeAgents, allAgents, failedFiles?, allowedAgentTypes? }
  //      (AppStateStore.ts:232),不是 compat 那套字段。
  // 修复后由 buildOpenccQueryParams 调 vendor 的 getAgentDefinitionsWithOverrides(cwd),
  // 至少吃到 4 个 builtin agents (general-purpose / statusline-setup /
  // Explore / Plan; claude-code-guide 在 SDK 入口下被排除)。
  it('populates activeAgents with the vendor builtin agents so AgentTool.prompt lists sub-agents', async () => {
    const params = await buildOpenccQueryParams({ ...minimalOpts }, {})
    const defs = params.toolUseContext.options.agentDefinitions as any
    expect(defs).toBeDefined()
    const active: Array<{ agentType: string }> = defs.activeAgents ?? []
    expect(active.length).toBeGreaterThanOrEqual(4)
    const types = active.map(a => a.agentType).sort()
    expect(types).toContain('general-purpose')
    expect(types).toContain('Explore')
    expect(types).toContain('Plan')
  })

  it('exposes vendor-shaped { activeAgents, allAgents, ... } (legacy compat shape is gone)', async () => {
    const params = await buildOpenccQueryParams({ ...minimalOpts }, {})
    const defs = params.toolUseContext.options.agentDefinitions as any
    expect(Array.isArray(defs.activeAgents)).toBe(true)
    expect(Array.isArray(defs.allAgents)).toBe(true)
    expect(defs.agents).toBeUndefined()
    expect(defs.builtinAgents).toBeUndefined()
    expect(defs.customAgents).toBeUndefined()
    expect(defs.forAgents).toBeUndefined()
  })
})
