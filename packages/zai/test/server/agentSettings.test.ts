import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { readFileSync } from 'node:fs'

// Mock node:fs so we control what readFileSync returns
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    readFileSync: vi.fn(),
  }
})

// Mock modelCaller so the route doesn't try to construct an Anthropic client.
// We don't import modelCaller in agentSettings.ts directly — it only uses
// readZaiSettings which lives in modelCaller.ts. So mocking modelCaller's
// side effects (the Anthropic constructor) isn't needed; we only need to
// stub readFileSync (above) and node:os for homedir (default is fine).

// Import after mocks
import agentSettingsRouter from '../../src/server/routes/agentSettings.js'

const app = express()
app.use(express.json())
// agent.ts:293 期待 req.app.locals.instanceContext, 同包其它 router 测试也设了.
app.locals.instanceContext = { cwd: '/tmp', cwdName: 'agent-settings-test' }
app.use('/api', agentSettingsRouter)

describe('GET /api/agent/settings', () => {
  beforeEach(() => {
    vi.mocked(readFileSync).mockReset()
  })

  it('returns defaultModel from env.ANTHROPIC_DEFAULT_SONNET_MODEL when set', async () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        env: {
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M3',
          ANTHROPIC_BASE_URL: 'https://api.example.com',
        },
      }),
    )
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(expect.objectContaining({
      defaultModel: 'MiniMax-M3',
      baseURL: 'https://api.example.com',
    }))
  })

  it('falls back to env.ANTHROPIC_SMALL_FAST_MODEL when SONNET is missing', async () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        env: {
          ANTHROPIC_SMALL_FAST_MODEL: 'MiniMax-fast',
        },
      }),
    )
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    expect(res.body.defaultModel).toBe('MiniMax-fast')
    expect(res.body.baseURL).toBeNull()
  })

  it('falls back to top-level settings.model when no env override', async () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ model: 'claude-opus-4-6' }))
    const res = await request(app).get('/api/agent/settings')
    expect(res.body.defaultModel).toBe('claude-opus-4-6')
    expect(res.body.baseURL).toBeNull()
  })

  it('returns builtin fallback defaultModel when settings.json is empty', async () => {
    vi.mocked(readFileSync).mockReturnValue('{}')
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    // buildAvailableModels() 永远 merge user entries + saved profiles + BUILTIN_PROVIDERS.
    // 所以 models 永远非空, 不会为 []. baseURL 在没 env 覆盖时是 null.
    expect(res.body.baseURL).toBeNull()
    expect(Array.isArray(res.body.models)).toBe(true)
    expect(res.body.models.length).toBeGreaterThan(0)
    // resolveModel's BUILTIN_FALLBACK_MODEL when no env / settings.model override.
    expect(res.body.defaultModel).toBe('MiniMax-M3')
  })

  it('returns 500 when readFileSync throws', async () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error('ENOENT: no such file')
    })
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(500)
    expect(res.body.error).toContain('ENOENT')
  })

  it('returns user-configured models[] prefixed before builtin entries', async () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M3' },
        models: [
          { alias: 'M3', model: 'MiniMax-M3', label: 'M3 · 默认最强' },
          { alias: 'haiku', model: 'MiniMax-M2.7-highspeed', label: 'M2.7 · 快速轻量' },
        ],
      }),
    )
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    // 用户的两个 entry 排在最前, 后面追加 builtins (alias 不会冲突所以都进得来).
    expect(res.body.models.slice(0, 2)).toEqual([
      { alias: 'M3', model: 'MiniMax-M3', label: 'M3 · 默认最强' },
      { alias: 'haiku', model: 'MiniMax-M2.7-highspeed', label: 'M2.7 · 快速轻量' },
    ])
    expect(res.body.models.length).toBeGreaterThan(2)
  })

  it('falls back to BUILTIN_PROVIDERS when settings.json omits models', async () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'X' } }),
    )
    const res = await request(app).get('/api/agent/settings')
    // builtins 永远会注入; 不会真的空数组.
    expect(Array.isArray(res.body.models)).toBe(true)
    expect(res.body.models.length).toBeGreaterThan(0)
    // openplatform gateway 的 catalog 在 builtins 里.
    const hasNova = res.body.models.some((m: { baseUrl?: string }) =>
      m.baseUrl === 'https://zn-nova.paic.com.cn/novai',
    )
    expect(hasNova).toBe(true)
  })
})