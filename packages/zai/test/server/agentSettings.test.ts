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