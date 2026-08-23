/**
 * DshTranscriptAdapter 单测(dsh-020 / transcript 恢复修复)。
 *
 * 验证:
 *   - create() 生成 sessionId 并落 zai meta,空 cwd 也能跑
 *   - read() 合并 zai meta + dsh session.log(events + cwd + createdAt)
 *   - list() 扫描 dsh-sessions 目录 + zai meta cache,按 updatedAt 排序
 *   - patch() 写 zai meta + 尝试追加 session/title 到 dsh log(若 agent 在线)
 *   - remove() 删除 zai meta + dsh session 目录
 *   - inferTitle 优先 session/title,否则首条 user message
 *   - encodeDshSessionSegment / decodeDshSessionSegment 与 dsh-side 算法一致
 *
 * 用 mock ctx 替代真实 dsh ctx(不依赖 plugin 装载,~10s 启动开销)—
 * `ctx.get('sessionPersistence').loadStored` 提供 mock 实现。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DshTranscriptAdapter, _internal as transcriptAdapterInternal } from '../../src/sessions/transcriptAdapter'

interface FakeCtx {
  storage: Map<string, { meta: { cwd: string; createdAt: number; id: string; parentSession?: string }; events: any[] }>
  sessions: Map<string, any> // live agent sessions
  get(key: string): any
}

function makeFakeCtx(): FakeCtx {
  const storage = new Map<string, { meta: { cwd: string; createdAt: number; id: string; parentSession?: string }; events: any[] }>()
  const sessions = new Map<string, any>()
  return {
    storage,
    sessions,
    get(key: string) {
      if (key === 'sessionPersistence') {
        return {
          async loadStored(id: unknown) {
            const stored = storage.get(id as string)
            if (!stored) return undefined
            return stored
          },
        }
      }
      if (key === 'agents') {
        return {
          get(id: unknown) {
            return sessions.get(id as string)
          },
        }
      }
      return undefined
    },
  }
}

describe('DshTranscriptAdapter (dsh-020)', () => {
  let tmpDir: string
  let ctx: FakeCtx
  let adapter: DshTranscriptAdapter

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dsh-transcript-'))
    ctx = makeFakeCtx()
    adapter = new DshTranscriptAdapter(ctx as any, tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // ─── create / read ─────────────────────────────────────────────────

  it('create 生成 sess-* 格式 sessionId 并落 zai meta', async () => {
    const sid = await adapter.create({
      cwd: '/Users/x/y',
      model: 'MiniMax-M3',
      permissionMode: 'plan',
    }, { cwd: '/Users/x/y' })
    expect(sid).toMatch(/^sess-\d+-[a-z0-9]+$/)

    // metaPath = dsh-session-meta/<projectKeyForCwd('/Users/x/y')> = '--Users-x-y--'
    const metaPath = join(tmpDir, 'dsh-session-meta', '--Users-x-y--', `${sid}.meta.json`)
    expect(existsSync(metaPath)).toBe(true)

    const read = await adapter.read(sid, { cwd: '/Users/x/y' })
    expect(read.meta.sessionId).toBe(sid)
    expect(read.meta.model).toBe('MiniMax-M3')
    expect(read.meta.permissionMode).toBe('plan')
    expect(read.meta.cwd).toBe('/Users/x/y')
    expect(read.messages).toEqual([])
  })

  it('read 合并 dsh session.log 的 events + meta.cwd/createdAt', async () => {
    const sid = 'sess-test-events'
    ctx.storage.set(sid, {
      meta: { cwd: '/Users/x/y', createdAt: 1700000000000, id: sid },
      events: [
        { type: 'turn/start', seq: 0, time: 1700000000001, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: 1700000000002, data: { content: 'hello world' } },
        { type: 'assistant/chunk', seq: 2, time: 1700000000003, data: { turn: 1, step: 1, chunk: { type: 'text', text: 'hi' } } },
        { type: 'assistant/message', seq: 3, time: 1700000000004, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } } },
        { type: 'turn/end', seq: 4, time: 1700000000005, data: { turn: 1, reason: 'completed' } },
      ],
    })

    await adapter.create({ cwd: '/Users/x/y', model: 'MiniMax-M3' }, { cwd: '/Users/x/y' })
    // 覆盖 zai meta 的 sid:让 read 拿到我们 mock 的 sid
    const cwd = '/Users/x/y'
    const metaDir = join(tmpDir, 'dsh-session-meta', '--Users-x-y--')
    writeFileSync(join(metaDir, `${sid}.meta.json`), JSON.stringify({
      cwd, model: 'MiniMax-M3', sessionId: sid, createdAt: 1700000000000,
    }))

    const read = await adapter.read(sid, { cwd })
    // dsh 5 个 events 经转换只剩 2 个可渲染 msg:
    //   - turn/start, turn/end, assistant/chunk → 跳过
    //   - user/message, assistant/message → 产出
    expect(read.messages.length).toBe(2)
    expect(read.messages[0].type).toBe('user')
    expect(read.messages[0].uuid).toBe('e-1')
    expect(read.messages[0].timestamp).toBe(1700000000002)
    expect(read.messages[0].message.role).toBe('user')
    expect(read.messages[0].message.content).toBe('hello world')
    expect(read.messages[1].type).toBe('assistant')
    expect(read.messages[1].uuid).toBe('e-3')
    expect(read.messages[1].timestamp).toBe(1700000000004)
    expect(read.messages[1].message.role).toBe('assistant')
    expect(read.messages[1].message.content).toEqual([{ type: 'text', text: 'hi' }])
    expect(read.meta.cwd).toBe('/Users/x/y')
    expect(read.meta.createdAt).toBe(1700000000000)
    expect(read.meta.model).toBe('MiniMax-M3')
  })

  it('inferTitle 优先 session/title,其次首条 user message 文本', async () => {
    const sid = 'sess-title-infer'
    ctx.storage.set(sid, {
      meta: { cwd: '/Users/x/y', createdAt: 0, id: sid },
      events: [
        { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'A very long user message that should not be the title if a custom one exists' }] } },
        { type: 'session/title', seq: 1, time: 2, data: { title: 'My Custom Title' } },
      ],
    })
    const cwd = '/Users/x/y'
    mkdirSync(join(tmpDir, 'dsh-session-meta', '--Users-x-y--'), { recursive: true })
    writeFileSync(join(tmpDir, 'dsh-session-meta', '--Users-x-y--', `${sid}.meta.json`), JSON.stringify({
      cwd, model: '', sessionId: sid, createdAt: 0,
    }))
    const read = await adapter.read(sid, { cwd })
    expect(read.meta.title).toBe('My Custom Title')

    // 移除 session/title → 回落首条 user message
    ctx.storage.set(sid, {
      meta: { cwd: '/Users/x/y', createdAt: 0, id: sid },
      events: [
        { type: 'user/message', seq: 0, time: 1, data: { content: 'fallback title here' } },
      ],
    })
    const read2 = await adapter.read(sid, { cwd })
    expect(read2.meta.title).toBe('fallback title here')
  })

  it('read 转 dsh events → opencc Anthropic 形态(对齐 useAgentStore.loadTranscriptMessages)', async () => {
    const sid = 'sess-shape'
    ctx.storage.set(sid, {
      meta: { cwd: '/Users/x/y', createdAt: 0, id: sid },
      events: [
        // turn start 计数但不渲染
        { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } },
        // user/message with text content
        { type: 'user/message', seq: 1, time: 101, data: { content: 'hi there', source: { kind: 'user' } } },
        // assistant/text
        { type: 'assistant/message', seq: 2, time: 102, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } } },
        // tool call
        { type: 'tool/call', seq: 3, time: 103, data: { call: { id: 'call-1', name: 'Bash', input: { cmd: 'ls' } } } },
        // tool result
        { type: 'tool/result', seq: 4, time: 104, data: { callId: 'call-1', output: 'file.txt', isError: false } },
        // system user message (subagent notification etc.) — isMeta true,前端跳过
        { type: 'user/message', seq: 5, time: 105, data: { content: '<task-notification>foo</task-notification>', source: { kind: 'subagent_notification' } } },
        // turn end
        { type: 'turn/end', seq: 6, time: 106, data: { turn: 1, reason: 'completed' } },
      ],
    })
    mkdirSync(join(tmpDir, 'dsh-session-meta', '--Users-x-y--'), { recursive: true })
    writeFileSync(join(tmpDir, 'dsh-session-meta', '--Users-x-y--', `${sid}.meta.json`), JSON.stringify({
      cwd: '/Users/x/y', model: '', sessionId: sid, createdAt: 0,
    }))
    const read = await adapter.read(sid, { cwd: '/Users/x/y' })
    // 7 events:turn/start + turn/end 跳过,5 产出(system user isMeta=true
    // 但 zai adapter 仍产出形态,前端 loadTranscriptMessages 按 isMeta 过滤)
    expect(read.messages.length).toBe(5)
    // 1. user text
    expect(read.messages[0]).toMatchObject({
      type: 'user',
      uuid: 'e-1',
      timestamp: 101,
      runtime: { turnIndex: 1 },
      message: { role: 'user', content: 'hi there' },
    })
    expect(read.messages[0].isMeta).toBeUndefined()
    // 2. assistant text
    expect(read.messages[1]).toMatchObject({
      type: 'assistant',
      uuid: 'e-2',
      timestamp: 102,
      runtime: { turnIndex: 1 },
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    })
    // 3. tool_use
    expect(read.messages[2]).toMatchObject({
      type: 'tool_use',
      uuid: 'e-3',
      timestamp: 103,
      runtime: { turnIndex: 1 },
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { cmd: 'ls' } }],
      },
    })
    // 4. tool_result
    expect(read.messages[3]).toMatchObject({
      type: 'tool_result',
      uuid: 'e-4',
      timestamp: 104,
      runtime: { turnIndex: 1 },
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'file.txt', is_error: false }],
      },
    })
    // 5. system user (subagent notification) — isMeta true,前端跳过
    expect(read.messages[4]).toMatchObject({
      type: 'user',
      uuid: 'e-5',
      timestamp: 105,
      isMeta: true,
      message: { role: 'user', content: '<task-notification>foo</task-notification>' },
    })
  })

  // ─── thinking / reasoning 翻译 ────────────────────────────────────
  //
  // dsh ↔ zai 形态差异:
  //   - dsh ReasoningBlock = { type: 'reasoning', text: string }
  //   - zai 前端期望 block  = { type: 'thinking', thinking: string }
  //
  // reasoning 数据来源(任一):
  //   A. assistant/message.content 数组里直接含 reasoning block(dsh 端装配完成)
  //   B. assistant/chunk.reasoning-delta 流式累积(dsh-side 落到 session.log)
  //
  // 这两个测试覆盖两条路径 → eventsToMessages 必须把两种来源都还原为 zai thinking 块。

  it('thinking 翻译 path A: message.content 里的 dsh reasoning block 重写为 zai thinking block', async () => {
    const sid = 'sess-think-a'
    ctx.storage.set(sid, {
      meta: { cwd: '/Users/x/y', createdAt: 0, id: sid },
      events: [
        { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: 101, data: { content: 'ping', source: { kind: 'user' } } },
        {
          type: 'assistant/message', seq: 2, time: 102,
          data: {
            message: {
              role: 'assistant',
              content: [
                // dsh reasoning block(type='reasoning' + text)— 必须重写为 zai 形态
                { type: 'reasoning', text: 'let me think about this carefully' },
                { type: 'text', text: 'pong' },
              ],
            },
          },
        },
        { type: 'turn/end', seq: 3, time: 103, data: { turn: 1, reason: 'completed' } },
      ],
    })
    const cwd = '/Users/x/y'
    mkdirSync(join(tmpDir, 'dsh-session-meta', '--Users-x-y--'), { recursive: true })
    writeFileSync(join(tmpDir, 'dsh-session-meta', '--Users-x-y--', `${sid}.meta.json`), JSON.stringify({
      cwd, model: '', sessionId: sid, createdAt: 0,
    }))
    const read = await adapter.read(sid, { cwd })
    // 期望:content 数组里 reasoning 块被改写为 {type:'thinking', thinking:'...'},
    // text 块保持不变,顺序保留(reasoning 在前)
    const assistantMsg = read.messages.find((m) => m.type === 'assistant')
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg!.message.content).toEqual([
      { type: 'thinking', thinking: 'let me think about this carefully' },
      { type: 'text', text: 'pong' },
    ])
  })

  it('thinking 翻译 path B: assistant/chunk 累积 reasoning-delta → assistant/message 注入为 thinking 块', async () => {
    const sid = 'sess-think-b'
    ctx.storage.set(sid, {
      meta: { cwd: '/Users/x/y', createdAt: 0, id: sid },
      events: [
        { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: 101, data: { content: 'q', source: { kind: 'user' } } },
        // dsh 流式:多个 reasoning-delta + text-delta 累积
        { type: 'assistant/chunk', seq: 2, time: 102, data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: 'thinking part 1. ' } } },
        { type: 'assistant/chunk', seq: 3, time: 103, data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'answer part 1. ' } } },
        { type: 'assistant/chunk', seq: 4, time: 104, data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: 'thinking part 2.' } } },
        { type: 'assistant/chunk', seq: 5, time: 105, data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'answer part 2.' } } },
        // 装配后的 message — content 里可能只有 text(reasoning 由 chunk 累积负责)
        { type: 'assistant/message', seq: 6, time: 106, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'answer part 1. answer part 2.' }] } } },
        { type: 'turn/end', seq: 7, time: 107, data: { turn: 1, reason: 'completed' } },
      ],
    })
    const cwd = '/Users/x/y'
    mkdirSync(join(tmpDir, 'dsh-session-meta', '--Users-x-y--'), { recursive: true })
    writeFileSync(join(tmpDir, 'dsh-session-meta', '--Users-x-y--', `${sid}.meta.json`), JSON.stringify({
      cwd, model: '', sessionId: sid, createdAt: 0,
    }))
    const read = await adapter.read(sid, { cwd })
    const assistantMsg = read.messages.find((m) => m.type === 'assistant')
    expect(assistantMsg).toBeDefined()
    // 期望:reasoning-delta 累积成单个 thinking 块,排在 text 块之前
    expect(assistantMsg!.message.content).toEqual([
      { type: 'thinking', thinking: 'thinking part 1. thinking part 2.' },
      { type: 'text', text: 'answer part 1. answer part 2.' },
    ])
  })

  it('thinking 翻译 path A+B 双源并存:message.content 已有 reasoning + chunk 也累积时,两者合并(不重复)', async () => {
    const sid = 'sess-think-ab'
    ctx.storage.set(sid, {
      meta: { cwd: '/Users/x/y', createdAt: 0, id: sid },
      events: [
        { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: 101, data: { content: 'q', source: { kind: 'user' } } },
        // chunk 也累积了 reasoning(罕见 — 但如果 dsh 写了,我们要正确处理)
        { type: 'assistant/chunk', seq: 2, time: 102, data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: 'from chunk' } } },
        // message.content 里同时有 reasoning block(权威源,优先于 chunk)
        {
          type: 'assistant/message', seq: 3, time: 103,
          data: {
            message: {
              role: 'assistant',
              content: [
                { type: 'reasoning', text: 'from message.content' },
                { type: 'text', text: 'answer' },
              ],
            },
          },
        },
        { type: 'turn/end', seq: 4, time: 104, data: { turn: 1, reason: 'completed' } },
      ],
    })
    const cwd = '/Users/x/y'
    mkdirSync(join(tmpDir, 'dsh-session-meta', '--Users-x-y--'), { recursive: true })
    writeFileSync(join(tmpDir, 'dsh-session-meta', '--Users-x-y--', `${sid}.meta.json`), JSON.stringify({
      cwd, model: '', sessionId: sid, createdAt: 0,
    }))
    const read = await adapter.read(sid, { cwd })
    const assistantMsg = read.messages.find((m) => m.type === 'assistant')
    expect(assistantMsg).toBeDefined()
    // 期望:message.content 里的 reasoning 已改写为 thinking;chunk 累积的
    // 在 message 来时已 flush(per-turn buffer),不重复出现。
    expect(assistantMsg!.message.content).toEqual([
      { type: 'thinking', thinking: 'from message.content' },
      { type: 'text', text: 'answer' },
    ])
  })

  // ─── list ──────────────────────────────────────────────────────────

  it('list 扫描 dsh-sessions/<projectKey>/* 目录,合并 zai meta', async () => {
    const cwd = '/Users/x/y'
    // mock 两个 dsh session
    ctx.storage.set('sess-aaa', {
      meta: { cwd, createdAt: 1000, id: 'sess-aaa' },
      events: [
        { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'aaa first' }] } },
      ],
    })
    ctx.storage.set('sess-bbb', {
      meta: { cwd, createdAt: 2000, id: 'sess-bbb' },
      events: [],
    })
    // zai meta:bbb 有 model,a 没 patch
    mkdirSync(join(tmpDir, 'dsh-session-meta', '--Users-x-y--'), { recursive: true })
    writeFileSync(join(tmpDir, 'dsh-session-meta', '--Users-x-y--', 'sess-bbb.meta.json'), JSON.stringify({
      cwd, model: 'MiniMax-M2.7', sessionId: 'sess-bbb', createdAt: 2000, updatedAt: 2000,
    }))

    // 模拟 dsh 磁盘 session 目录 — sanitizePath('/Users/x/y') = '--Users-x-y--'
    const dshDir = join(tmpDir, 'dsh-sessions', '--Users-x-y--')
    mkdirSync(join(dshDir, 'sess-aaa'), { recursive: true })
    mkdirSync(join(dshDir, 'sess-bbb'), { recursive: true })

    const list = await adapter.list({ cwd })
    expect(list.length).toBe(2)
    const byId = Object.fromEntries(list.map((m) => [m.sessionId, m]))
    expect(byId['sess-aaa'].title).toBe('aaa first')
    expect(byId['sess-aaa'].model).toBe('') // 没 zai meta
    expect(byId['sess-bbb'].model).toBe('MiniMax-M2.7')
  })

  it('list 排序:updatedAt 倒序', async () => {
    const cwd = '/Users/x/y'
    ctx.storage.set('sess-old', {
      meta: { cwd, createdAt: 1000, id: 'sess-old' },
      events: [],
    })
    ctx.storage.set('sess-new', {
      meta: { cwd, createdAt: 2000, id: 'sess-new' },
      events: [],
    })
    mkdirSync(join(tmpDir, 'dsh-session-meta', '--Users-x-y--'), { recursive: true })
    writeFileSync(join(tmpDir, 'dsh-session-meta', '--Users-x-y--', 'sess-old.meta.json'), JSON.stringify({
      cwd, model: 'm1', sessionId: 'sess-old', createdAt: 1000, updatedAt: 1000,
    }))
    writeFileSync(join(tmpDir, 'dsh-session-meta', '--Users-x-y--', 'sess-new.meta.json'), JSON.stringify({
      cwd, model: 'm2', sessionId: 'sess-new', createdAt: 2000, updatedAt: 2000,
    }))
    const dshDir = join(tmpDir, 'dsh-sessions', '--Users-x-y--')
    mkdirSync(join(dshDir, 'sess-old'), { recursive: true })
    mkdirSync(join(dshDir, 'sess-new'), { recursive: true })

    const list = await adapter.list({ cwd })
    expect(list[0].sessionId).toBe('sess-new')
    expect(list[1].sessionId).toBe('sess-old')
  })

  // ─── sub-agent 过滤(默认隐藏 spawn 出来的子 session)────────────────

  it('list 默认排除上游 dsh spawn 出来的 sub-agent session(header.parentSession 非空)', async () => {
    // 上游 dsh SubagentRuntime.start('spawn', ...) 给子 session header 写
    // parentSession;zai compat 不写这字段,仅从 dsh header 读取。默认
    // (excludeSubagent 未传 / true) 应当从 sidebar / 列表 API 里隐藏子 session,
    // 避免用户主 session 列表里看到一堆 spawn 任务。
    const cwd = '/Users/x/y'
    ctx.storage.set('sess-main', {
      meta: { cwd, createdAt: 1000, id: 'sess-main' }, // 无 parentSession = 主 session
      events: [],
    })
    ctx.storage.set('sess-child-a', {
      meta: { cwd, createdAt: 1100, id: 'sess-child-a', parentSession: 'sess-main' },
      events: [{ type: 'user/message', seq: 0, time: 1, data: { content: 'child task a' } }],
    })
    ctx.storage.set('sess-child-b', {
      meta: { cwd, createdAt: 1200, id: 'sess-child-b', parentSession: 'sess-main' },
      events: [],
    })
    const dshDir = join(tmpDir, 'dsh-sessions', '--Users-x-y--')
    mkdirSync(join(dshDir, 'sess-main'), { recursive: true })
    mkdirSync(join(dshDir, 'sess-child-a'), { recursive: true })
    mkdirSync(join(dshDir, 'sess-child-b'), { recursive: true })

    // 默认:不传 excludeSubagent → 应排除 sub-agent
    const listDefault = await adapter.list({ cwd })
    expect(listDefault.map((m) => m.sessionId)).toEqual(['sess-main'])

    // 显式 excludeSubagent:true → 同样排除
    const listExcluded = await adapter.list({ cwd, excludeSubagent: true })
    expect(listExcluded.map((m) => m.sessionId)).toEqual(['sess-main'])
  })

  it('list excludeSubagent:false 保留 sub-agent session(并透传 parentSession 字段)', async () => {
    // 上游 dsh 有 listLiveDshSessions / debug 视图需要看到所有 session;
    // 显式传 excludeSubagent:false 时应该全部返回,meta.parentSession 透传。
    const cwd = '/Users/x/y'
    ctx.storage.set('sess-main', {
      meta: { cwd, createdAt: 1000, id: 'sess-main' },
      events: [],
    })
    ctx.storage.set('sess-child-a', {
      meta: { cwd, createdAt: 1100, id: 'sess-child-a', parentSession: 'sess-main' },
      events: [{ type: 'user/message', seq: 0, time: 1, data: { content: 'child a' } }],
    })
    const dshDir = join(tmpDir, 'dsh-sessions', '--Users-x-y--')
    mkdirSync(join(dshDir, 'sess-main'), { recursive: true })
    mkdirSync(join(dshDir, 'sess-child-a'), { recursive: true })

    const list = await adapter.list({ cwd, excludeSubagent: false })
    expect(list.length).toBe(2)
    const byId = Object.fromEntries(list.map((m) => [m.sessionId, m]))
    expect(byId['sess-main'].parentSession).toBeUndefined()
    expect(byId['sess-child-a'].parentSession).toBe('sess-main')
  })

  it('read 透传上游 dsh header 的 parentSession 字段', async () => {
    // 单独 read 一个 sub-agent session 时,即便 caller 走 read() 而不是 list(),
    // meta 也应当携带 parentSession — 让前端能区分(例如 SubagentsTab
    // / SubagentDetailDrawer 等可能用 read() 直接拿 meta)。
    const cwd = '/Users/x/y'
    const sid = 'sess-child-read'
    ctx.storage.set(sid, {
      meta: { cwd, createdAt: 1100, id: sid, parentSession: 'sess-parent-xyz' },
      events: [
        { type: 'user/message', seq: 0, time: 1, data: { content: 'child content' } },
      ],
    })
    mkdirSync(join(tmpDir, 'dsh-session-meta', '--Users-x-y--'), { recursive: true })
    writeFileSync(join(tmpDir, 'dsh-session-meta', '--Users-x-y--', `${sid}.meta.json`), JSON.stringify({
      cwd, model: 'MiniMax-M3', sessionId: sid, createdAt: 1100,
    }))

    const read = await adapter.read(sid, { cwd })
    expect(read.meta.parentSession).toBe('sess-parent-xyz')
  })

  // ─── patch ─────────────────────────────────────────────────────────

  it('patch 更新 zai meta + 追加 session/title 到 live dsh agent session', async () => {
    const cwd = '/Users/x/y'
    const sid = 'sess-patch'
    await adapter.create({ cwd, model: 'MiniMax-M3' }, { cwd })

    // 模拟 live agent session — append 应该被调用
    let appendedType: string | null = null
    let appendedData: unknown = null
    ctx.sessions.set(sid, {
      session: {
        append(type: string, data: unknown) {
          appendedType = type
          appendedData = data
        },
      },
    })

    const updated = await adapter.patch(sid, { title: 'New Title', model: 'MiniMax-M2.7' }, { cwd })
    expect(updated?.title).toBe('New Title')
    expect(updated?.model).toBe('MiniMax-M2.7')
    expect(updated?.updatedAt).toBeGreaterThan(0)

    // dsh append 调用
    expect(appendedType).toBe('session/title')
    expect((appendedData as { title: string }).title).toBe('New Title')

    // zai meta 落盘
    const meta = await adapter.read(sid, { cwd })
    expect(meta.meta.title).toBe('New Title')
    expect(meta.meta.model).toBe('MiniMax-M2.7')
  })

  it('patch 在 agent 不在线时仍写 zai meta(略过 session/title append)', async () => {
    const cwd = '/Users/x/y'
    const sid = 'sess-noagent'
    await adapter.create({ cwd, model: 'MiniMax-M3' }, { cwd })

    // 不放 sessions,session/title append 应静默跳过
    const updated = await adapter.patch(sid, { title: 'X' }, { cwd })
    expect(updated?.title).toBe('X')
    // 落盘 meta
    expect((await adapter.read(sid, { cwd })).meta.title).toBe('X')
  })

  // ─── remove ────────────────────────────────────────────────────────

  it('remove 删除 zai meta + dsh session 目录', async () => {
    const cwd = '/Users/x/y'
    const sid = 'sess-rm'
    await adapter.create({ cwd, model: 'MiniMax-M3' }, { cwd })
    const dshDir = join(tmpDir, 'dsh-sessions', '--Users-x-y--', sid)
    mkdirSync(dshDir, { recursive: true })
    writeFileSync(join(dshDir, 'session.log'), 'placeholder')

    expect(existsSync(dshDir)).toBe(true)

    await adapter.remove(sid, { cwd })

    expect(existsSync(dshDir)).toBe(false)
    const metaDir = join(tmpDir, 'dsh-session-meta', '--Users-x-y--')
    expect(readdirSync(metaDir).find((n) => n === `${sid}.meta.json`)).toBeUndefined()
  })

  // ─── path encoding ────────────────────────────────────────────────

  it('encodeDshSessionSegment / decodeDshSessionSegment 与 dsh-side 一致', () => {
    const { encodeDshSessionSegment, decodeDshSessionSegment } = transcriptAdapterInternal
    // safe chars pass through
    expect(encodeDshSessionSegment('sess-1234567-abc')).toBe('sess-1234567-abc')
    expect(decodeDshSessionSegment('sess-1234567-abc')).toBe('sess-1234567-abc')
    // special . / ..
    expect(encodeDshSessionSegment('.')).toBe('~002E')
    expect(encodeDshSessionSegment('..')).toBe('~002E~002E')
    expect(decodeDshSessionSegment('~002E')).toBe('.')
    expect(decodeDshSessionSegment('~002E~002E')).toBe('..')
    // tilde + non-ASCII
    expect(encodeDshSessionSegment('~')).toBe('~007E')
    expect(decodeDshSessionSegment('~007E')).toBe('~')
  })

  // ─── ENOENT 容错 ───────────────────────────────────────────────────

  it('read 在 dsh session.log 不存在时仍返回 zai meta 兜底', async () => {
    const cwd = '/Users/x/y'
    const sid = 'sess-enoent'
    // 直接写 zai meta 文件(不走 create(),因为 create 会生成新 sid)
    mkdirSync(join(tmpDir, 'dsh-session-meta', '--Users-x-y--'), { recursive: true })
    writeFileSync(join(tmpDir, 'dsh-session-meta', '--Users-x-y--', `${sid}.meta.json`), JSON.stringify({
      cwd, model: 'MiniMax-M3', sessionId: sid, createdAt: 1000,
    }))
    // 不放 ctx.storage → loadStored 返回 undefined
    const read = await adapter.read(sid, { cwd })
    expect(read.messages).toEqual([])
    expect(read.meta.model).toBe('MiniMax-M3')
    expect(read.meta.createdAt).toBe(1000)
  })

  it('list 在 dsh-sessions 目录不存在时返回 zai meta 残留', async () => {
    const cwd = '/Users/x/y'
    const sid = 'sess-zai-only'
    // 直接写 zai meta 文件,绕过 create() 的随机 sid
    mkdirSync(join(tmpDir, 'dsh-session-meta', '--Users-x-y--'), { recursive: true })
    writeFileSync(join(tmpDir, 'dsh-session-meta', '--Users-x-y--', `${sid}.meta.json`), JSON.stringify({
      cwd, model: 'MiniMax-M3', sessionId: sid, createdAt: 1000, updatedAt: 1000,
    }))
    // 不建 dsh-sessions/<projectKey>/*
    const list = await adapter.list({ cwd })
    expect(list.length).toBe(1)
    expect(list[0].sessionId).toBe(sid)
  })
})