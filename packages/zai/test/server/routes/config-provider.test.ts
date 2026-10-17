import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import configRouter from '../../../src/server/routes/config.js'

// 回归测试 — PUT /api/config/zai/provider / /api/config/opencc/provider
// 必须接受 zai 的 apiKeyEnv / extraParams 字段(shared/types.ts:ProviderProfile),
// 同时不能因为 profile 里夹带历史遗留未知字段(authToken 等)就 400。
//
// 之前的 schema 是 .strict() + 字段不全,导致前端 Config.tsx 提交合法 profile
// 时被拒;用户/工具手工塞进 ~/.zai.json 的额外键也被一并拒。

const ORIGINAL_HOME = process.env.HOME
let tempHome: string

beforeAll(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'zai-config-provider-test-'))
  process.env.HOME = tempHome
})

afterAll(() => {
  process.env.HOME = ORIGINAL_HOME
  rmSync(tempHome, { recursive: true, force: true })
})

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api', configRouter)
  return app
}

describe('PUT /api/config/zai/provider schema', () => {
  it('accepts apiKeyEnv + extraParams (zai-specific fields)', async () => {
    const app = buildApp()
    const res = await request(app)
      .put('/api/config/zai/provider')
      .send({
        profiles: [
          {
            id: 'p1',
            name: 'ZhiNiao',
            provider: 'openai',
            baseUrl: 'https://example.com/v1',
            model: 'm1',
            apiFormat: 'chat_completions',
            apiKeyEnv: 'ZHINIAO_API_KEY',
            extraParams: { temperature: 0.2, reasoning_effort: 'low' },
            capabilities: { m1: { supportsVision: false } },
          },
        ],
      })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('strips unknown legacy keys instead of rejecting them', async () => {
    // ~/.zai.json 历史可能残留 authToken (来自 Anthropic SDK 字段误用或迁移脚本);
    // 不应当作 400 — schema 默认 strip 未知键,落盘 profile 自动清理。
    const app = buildApp()
    const res = await request(app)
      .put('/api/config/zai/provider')
      .send({
        profiles: [
          { name: 'legacy', provider: 'openai', baseUrl: 'https://x', model: 'm' },
          { name: 'legacy2', provider: 'openai', baseUrl: 'https://x', model: 'm', apiKeyEnv: 'K' },
          { name: 'legacy3', provider: 'openai', baseUrl: 'https://x', model: 'm' },
          // profiles[3] 携带未声明字段 authToken — 这正是错误信息中的现场。
          { name: 'legacy4', provider: 'openai', baseUrl: 'https://x', model: 'm', authToken: 'should-be-stripped' },
        ],
      })
    expect(res.status).toBe(200)

    // 读回 — authToken 已被 strip,合法字段(apiKeyEnv)保留。
    const get = await request(app).get('/api/config/zai/provider')
    expect(get.status).toBe(200)
    expect(get.body.profiles).toHaveLength(4)
    expect(get.body.profiles[1].apiKeyEnv).toBe('K')
    expect((get.body.profiles[3] as Record<string, unknown>).authToken).toBeUndefined()
  })

  it('rejects a profile missing the required name/provider', async () => {
    const app = buildApp()
    const res = await request(app)
      .put('/api/config/zai/provider')
      .send({ profiles: [{ baseUrl: 'https://x', model: 'm' }] })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('invalid body')
  })

  // ── tc-003:inline apiKey 被静默剥掉,一次保存即丢凭证 ──────────────
  // modelCaller.ts 的解析顺序是 inline apiKey → env[apiKeyEnv] → provider
  // 全局 env,即运行时**认** inline apiKey;而 ProviderProfileSchema 没声明
  // 它,z.object 默认 strip 把它悄悄丢掉 —— 落盘后凭证消失,调用退化成拿
  // provider 全局 env 打到错误端点,或直接 401。
  it('persists inline apiKey (运行时承重字段,不得被 strip)', async () => {
    const app = buildApp()
    const res = await request(app)
      .put('/api/config/zai/provider')
      .send({
        profiles: [
          {
            name: 'inline-key',
            provider: 'openai',
            baseUrl: 'https://x',
            model: 'm',
            apiKey: 'sk-inline-secret',
          },
        ],
      })
    expect(res.status).toBe(200)

    const get = await request(app).get('/api/config/zai/provider')
    expect(get.status).toBe(200)
    expect(get.body.profiles[0].apiKey, 'inline apiKey 必须落盘').toBe('sk-inline-secret')
  })

  it('persists inline apiKey on the opencc/provider route too (shared schema)', async () => {
    const app = buildApp()
    const res = await request(app)
      .put('/api/config/opencc/provider')
      .send({
        profiles: [
          { name: 'p', provider: 'openai', baseUrl: 'https://x', model: 'm', apiKey: 'sk-2' },
        ],
      })
    expect(res.status).toBe(200)

    const get = await request(app).get('/api/config/opencc/provider')
    expect(get.status).toBe(200)
    expect(get.body.profiles[0].apiKey).toBe('sk-2')
  })

  it('apiKey 与 apiKeyEnv 共存时两者都保留(解析顺序由运行时决定)', async () => {
    const app = buildApp()
    await request(app)
      .put('/api/config/zai/provider')
      .send({
        profiles: [
          { name: 'both', provider: 'openai', baseUrl: 'https://x', model: 'm', apiKey: 'sk-i', apiKeyEnv: 'E' },
        ],
      })
    const get = await request(app).get('/api/config/zai/provider')
    expect(get.body.profiles[0].apiKey).toBe('sk-i')
    expect(get.body.profiles[0].apiKeyEnv).toBe('E')
  })

  it('仍只 strip 真正的未知键 —— 加 apiKey 不得把 schema 变成 passthrough', async () => {
    // config.ts 的设计意图是「故意 strip,保持落盘 profile 干净」。补 apiKey
    // 是「加运行时字段时同步 schema」,不是「关掉 strip」—— 改成 passthrough
    // 会把 authToken 之类历史脏键一并放行,与设计意图相反。
    const app = buildApp()
    await request(app)
      .put('/api/config/zai/provider')
      .send({
        profiles: [
          {
            name: 'mixed',
            provider: 'openai',
            baseUrl: 'https://x',
            model: 'm',
            apiKey: 'sk-keep',
            authToken: 'should-be-stripped',
          },
        ],
      })
    const get = await request(app).get('/api/config/zai/provider')
    expect(get.body.profiles[0].apiKey).toBe('sk-keep')
    expect((get.body.profiles[0] as Record<string, unknown>).authToken).toBeUndefined()
  })
})

describe('PUT /api/config/opencc/provider schema', () => {
  it('also accepts the same zai-specific fields (shared schema)', async () => {
    const app = buildApp()
    const res = await request(app)
      .put('/api/config/opencc/provider')
      .send({
        profiles: [
          {
            name: 'p',
            provider: 'openai',
            baseUrl: 'https://x',
            model: 'm',
            apiKeyEnv: 'OPENAI_API_KEY',
            extraParams: { top_p: 0.9 },
          },
        ],
      })
    expect(res.status).toBe(200)
  })
})