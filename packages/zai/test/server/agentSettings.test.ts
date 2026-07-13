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
    expect(res.body).toEqual(expect.objectContaining({ baseURL: null, models: [] }))
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

  it('returns models[] from settings.json when present', async () => {
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
    expect(res.body.models).toEqual([
      { alias: 'M3', model: 'MiniMax-M3', label: 'M3 · 默认最强' },
      { alias: 'haiku', model: 'MiniMax-M2.7-highspeed', label: 'M2.7 · 快速轻量' },
    ])
  })

  it('returns models: [] when settings.json omits models', async () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'X' } }),
    )
    const res = await request(app).get('/api/agent/settings')
    expect(res.body.models).toEqual([])
  })
})