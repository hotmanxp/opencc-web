import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Buffer } from 'node:buffer'
import request from 'supertest'
import express from 'express'
import agentRouter from '../../src/server/routes/agent.js'

// Mock agentRuntime service — transcript store is needed for PATCH /sessions/:id
let patchCalls: Array<{ id: string; patch: { model?: string; title?: string } }> = []
vi.mock('../../src/server/services/agentRuntime.js', () => ({
  initAgentRuntime: vi.fn(),
  getOrCreateAgentSession: vi.fn().mockResolvedValue('test-session-id'),
  getAskRegistry: vi.fn().mockReturnValue({ abortAll: vi.fn() }),
  getApproveRegistry: vi.fn().mockReturnValue({ abortAll: vi.fn() }),
  getPermissionRegistry: vi.fn().mockReturnValue({ abortAll: vi.fn() }),
  abortAgentSession: vi.fn().mockResolvedValue(undefined),
  // Task 3: routes/agent.ts 的 /agent/prompt 现在调 registerSessionController,
  // /agent/abort 调 abortSessionController + releaseSessionController (finally).
  // 这些测试不关心 abort flow, 用 vi.fn() 占位即可.
  registerSessionController: vi.fn(),
  releaseSessionController: vi.fn(),
  abortSessionController: vi.fn().mockReturnValue(false),
  getRuntime: vi.fn().mockReturnValue({
    run: vi.fn().mockImplementation(async function* () {
      yield {
        eventId: 'e1',
        sessionId: 'test-session-id',
        ts: Date.now(),
        turnIndex: 0,
        type: 'assistant.text',
        text: 'Hello!',
      }
      yield {
        eventId: 'e2',
        sessionId: 'test-session-id',
        ts: Date.now(),
        turnIndex: 0,
        type: 'runtime.done',
      }
    }),
    abort: vi.fn().mockResolvedValue(undefined),
  }),
  getCurrentSessionId: () => 'test-session-id',
  setCurrentSessionId: () => {},
  getTranscriptStore: () => ({
    list: async () => [],
    read: async () => ({
      version: 1,
      transcriptId: 'test-session-id',
      meta: { cwd: '/tmp', model: 'unknown', createdAt: 0, updatedAt: 0 },
      messages: [],
    }),
    patch: async (id: string, patch: { model?: string; title?: string }) => {
      patchCalls.push({ id, patch })
    },
    remove: async () => {},
    append: async () => {},
  }),
}))

// Mock @zn-ai/zn-agent-core
vi.mock('@zn-ai/zn-agent-core/opencc-src/permissions', () => ({
  // permissionMode.ts:6 启动时用 EXTERNAL_PERMISSION_MODES 构造 VALID_MODES set,
  // mock 必须提供. 真实值见 zai-agent-core 导出 (5 个 user-facing mode).
  EXTERNAL_PERMISSION_MODES: ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk'],
}))

const app = express()
app.use(express.json())
// agent.ts:293 期待 req.app.locals.instanceContext. server/index.ts 启动时设, 测试手动设.
app.locals.instanceContext = { cwd: '/tmp', cwdName: 'routes-agent-test' }
app.use('/api', agentRouter)

describe('POST /api/agent/prompt', () => {
  // /api/agent/prompt 是 fire-and-forget: 立即 res.json({ sessionId }), 真正的 SSE
  // 流在后台异步推送. supertest 等不到 SSE 流结束, 但能拿到立即返回的 JSON envelope.

  it('rejects empty prompt', async () => {
    const res = await request(app)
      .post('/api/agent/prompt')
      .send({ prompt: '' })
    expect(res.status).toBe(400)
  })

  it('rejects missing prompt', async () => {
    const res = await request(app)
      .post('/api/agent/prompt')
      .send({})
    expect(res.status).toBe(400)
  })

  // Task 5 Fix round 1: permissionMode validation + generic fallback detail field

  it('accepts permissionMode "plan" and returns sessionId', async () => {
    const res = await request(app)
      .post('/api/agent/prompt')
      .send({ prompt: 'hello', permissionMode: 'plan' })
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('sessionId')
  })

  it('rejects unknown permissionMode with error + detail listing valid modes', async () => {
    const res = await request(app)
      .post('/api/agent/prompt')
      .send({ prompt: 'hello', permissionMode: 'unknown_mode' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid permissionMode')
    expect(res.body.detail).toContain('default')
    expect(res.body.detail).toContain('acceptEdits')
    expect(res.body.detail).toContain('plan')
    expect(res.body.detail).toContain('bypassPermissions')
    expect(res.body.detail).toContain('dontAsk')
  })

  it('rejects empty contentBlocks array with refine error message', async () => {
    // prompt: '' AND contentBlocks: [] → fails the refine "prompt or contentBlocks required"
    const res = await request(app)
      .post('/api/agent/prompt')
      .send({ prompt: '', contentBlocks: [] })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('prompt or contentBlocks required')
  })

  it('permissionMode branch fires before contentBlocks branch on combined failure', async () => {
    // ordering: permissionMode check runs first, so we get permissionMode error not contentBlocks error
    const res = await request(app)
      .post('/api/agent/prompt')
      .send({ prompt: 'hello', permissionMode: 'unknown_mode', contentBlocks: [] })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid permissionMode')
  })
})

// 真实 image content blocks 走 Anthropic 协议: schema 收紧 + server-side
// magic bytes 预检. 上游 api.minimaxi.com/anthropic 在 image 数据 magic 与
// 声明 media_type 不一致时返回 400 "invalid image content: decode image
// config: image: unknown format (2013)" — 我们在 zai 边缘先校验, 避免请求
// 上到 proxy 才被打回. 这些 case 在 production 之前就要被 400 拦下.
describe('POST /api/agent/prompt with image contentBlocks', () => {
  // PNG 头 8 字节: 89 50 4E 47 0D 0A 1A 0A
  const PNG_DATA = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('IHDR extra payload bytes'),
  ]).toString('base64')
  // JPEG SOI 3 字节
  const JPEG_DATA = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff]),
    Buffer.from('e0 JFIF payload'),
  ]).toString('base64')
  // GIF8 头 4 字节, 同时覆盖 GIF87a (0x3761) 和 GIF89a (0x3961)
  const GIF_DATA = Buffer.concat([
    Buffer.from('GIF87a'),
    Buffer.from(' rest of gif data'),
  ]).toString('base64')
  // WEBP: RIFF (offset 0) + 4 字节大小 + WEBP (offset 8)
  const WEBP_DATA = Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x1a, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP'),
    Buffer.from('VP8 payload'),
  ]).toString('base64')
  // 纯文本, 不是有效 image — magic 必不匹配
  const TEXT_DATA = Buffer.from('hello world this is plain text', 'utf-8').toString('base64')

  it('accepts a valid PNG image block', async () => {
    const res = await request(app)
      .post('/api/agent/prompt')
      .send({
        prompt: '看看这张图',
        contentBlocks: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_DATA } },
        ],
      })
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('sessionId')
  })

  it('accepts a valid JPEG image block', async () => {
    const res = await request(app)
      .post('/api/agent/prompt')
      .send({
        contentBlocks: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG_DATA } },
        ],
      })
    expect(res.status).toBe(200)
  })

  it('accepts a valid GIF image block', async () => {
    const res = await request(app)
      .post('/api/agent/prompt')
      .send({
        contentBlocks: [
          { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: GIF_DATA } },
        ],
      })
    expect(res.status).toBe(200)
  })

  it('accepts a valid WEBP image block', async () => {
    const res = await request(app)
      .post('/api/agent/prompt')
      .send({
        contentBlocks: [
          { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: WEBP_DATA } },
        ],
      })
    expect(res.status).toBe(200)
  })

  it('rejects image block with empty data field', async () => {
    const res = await request(app)
      .post('/api/agent/prompt')
      .send({
        contentBlocks: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
        ],
      })
    expect(res.status).toBe(400)
  })

  it('rejects image block with magic bytes not matching media_type (PNG data declared as image/jpeg)', async () => {
    // PNG_DATA 真实是 PNG 字节, 但声明 media_type=image/jpeg → magic 预检失败
    const res = await request(app)
      .post('/api/agent/prompt')
      .send({
        contentBlocks: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: PNG_DATA } },
        ],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('image_format_mismatch')
    expect(res.body.detail).toContain('image/jpeg')
  })

  it('rejects image block with plain text data declared as image/png', async () => {
    // TEXT_DATA 是 base64("hello world ..."), 不以 PNG 头开头
    const res = await request(app)
      .post('/api/agent/prompt')
      .send({
        contentBlocks: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TEXT_DATA } },
        ],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('image_format_mismatch')
  })

  it('rejects image block with unknown media_type (image/svg+xml)', async () => {
    const res = await request(app)
      .post('/api/agent/prompt')
      .send({
        contentBlocks: [
          { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: PNG_DATA } },
        ],
      })
    expect(res.status).toBe(400)
  })

  it('rejects image block with source.type=url (only base64 supported)', async () => {
    const res = await request(app)
      .post('/api/agent/prompt')
      .send({
        contentBlocks: [
          { type: 'image', source: { type: 'url', media_type: 'image/png', data: 'https://example.com/img.png' } },
        ],
      })
    expect(res.status).toBe(400)
  })

  it('rejects block with unknown type literal (e.g. type=video)', async () => {
    const res = await request(app)
      .post('/api/agent/prompt')
      .send({
        contentBlocks: [
          { type: 'video', source: { type: 'base64', media_type: 'video/mp4', data: 'xxxx' } },
        ],
      })
    expect(res.status).toBe(400)
  })

  it('rejects text block missing text field', async () => {
    const res = await request(app)
      .post('/api/agent/prompt')
      .send({
        contentBlocks: [{ type: 'text' }],
      })
    expect(res.status).toBe(400)
  })

  it('accepts text-only contentBlocks', async () => {
    const res = await request(app)
      .post('/api/agent/prompt')
      .send({
        contentBlocks: [{ type: 'text', text: 'hi' }],
      })
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('sessionId')
  })

  it('accepts mixed image+text contentBlocks', async () => {
    const res = await request(app)
      .post('/api/agent/prompt')
      .send({
        contentBlocks: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_DATA } },
          { type: 'text', text: '描述一下' },
        ],
      })
    expect(res.status).toBe(200)
  })
})

describe('POST /api/agent/abort', () => {
  it('aborts current session', async () => {
    const res = await request(app)
      .post('/api/agent/abort')
    expect(res.status).toBe(200)
    // Task 3: abort route 现在多返回 `aborted` 字段 (boolean).
    // abortSessionController 是 vi.fn().mockReturnValue(false) → 测试场景
    // 里没有 in-flight controller, aborted=false 是预期.
    expect(res.body).toEqual({ ok: true, sessionId: 'test-session-id', aborted: false })
  })
})

describe('PATCH /api/agent/sessions/:id', () => {
  beforeEach(() => {
    patchCalls = []
  })

  it('writes model to transcript meta', async () => {
    const res = await request(app)
      .patch('/api/agent/sessions/sess-1')
      .send({ model: 'MiniMax-M3' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(patchCalls).toEqual([{ id: 'sess-1', patch: { model: 'MiniMax-M3' } }])
  })

  it('rejects invalid body (missing or non-string model)', async () => {
    const res = await request(app)
      .patch('/api/agent/sessions/sess-1')
      .send({ model: 123 })
    expect(res.status).toBe(400)
  })

  it('does not write when model is "unknown" placeholder', async () => {
    const res = await request(app)
      .patch('/api/agent/sessions/sess-1')
      .send({ model: 'unknown' })
    expect(res.status).toBe(200)
    expect(patchCalls.length).toBe(0)
  })

  it('accepts empty body (no-op patch)', async () => {
    const res = await request(app)
      .patch('/api/agent/sessions/sess-1')
      .send({})
    expect(res.status).toBe(200)
    expect(patchCalls.length).toBe(0)
  })
})
