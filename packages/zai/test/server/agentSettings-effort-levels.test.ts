// zai patch (2026-09-28): GET /api/agent/settings attaches per-model effort
// metadata (`capabilities.effortLevels` / `capabilities.defaultEffortLevel`)
// resolved from the core's integration catalog.
//
// Why this is tested at the route level rather than on the UI: the browser
// must never import '@zn-ai/zn-agent-core' to render the model picker (it
// drags the whole vendor bundle, plus an optional native dep, into the web
// build). The levels therefore have to arrive as plain data on ModelEntry —
// which makes this route the single seam between the catalog and the UI.
// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Express } from 'express'
import type { ModelEntry } from '../../src/shared/settings.js'

let dataDir: string
let app: Express

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zai-effort-levels-'))
  process.env.ZAI_DATA_DIR = dataDir
  process.env.HOME = dataDir
  vi.resetModules()
  const { __resetCacheForTests } = await import(
    '../../src/server/services/zaiSettingsCache.js'
  )
  __resetCacheForTests()
  const { default: agentSettingsRouter } = await import(
    '../../src/server/routes/agentSettings.js'
  )
  app = express()
  app.use(express.json())
  app.locals.instanceContext = { cwd: '/tmp', cwdName: 'test' }
  app.use('/api', agentSettingsRouter)
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function modelsOf(res: request.Response): ModelEntry[] {
  return (res.body as { models: ModelEntry[] }).models
}

describe('GET /api/agent/settings — per-model effort levels', () => {
  it('MiniMax-M3.1-Flash-Preview 拿到五档, 默认 max', async () => {
    const models = modelsOf(await request(app).get('/api/agent/settings'))
    const entry = models.find((m) => m.model === 'MiniMax-M3.1-Flash-Preview')

    expect(entry).toBeDefined()
    expect(entry!.capabilities?.supportsReasoning).toBe(true)
    // 写死四档时这里会是 off/low/medium/high —— 少了 xhigh 和 max。
    expect(entry!.capabilities?.effortLevels).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(entry!.capabilities?.defaultEffortLevel).toBe('max')
  })

  it('档位随模型变化, 不是全局列表', async () => {
    const models = modelsOf(await request(app).get('/api/agent/settings'))

    const glm = models.find((m) => m.model === 'glm-5.2')
    expect(glm?.capabilities?.effortLevels).toEqual(['low', 'high', 'max'])

    const qwen = models.find((m) => m.model === 'qwen3.6-plus')
    expect(qwen?.capabilities?.effortLevels).toEqual(['low', 'medium', 'high'])
  })

  it('只给声明支持推理的模型挂档位', async () => {
    // 反向断言: 内置目录里所有模型都 supportsReasoning, 所以这个隔离环境
    // 里造不出「不支持推理」的样本。要守的契约是单向的 —— 挂了档位的模型
    // 必然声明了 supportsReasoning。反过来不成立(用户自建 profile 常漏标),
    // 那是 UI 侧 currentEntry 的合并逻辑负责兜的。
    const models = modelsOf(await request(app).get('/api/agent/settings'))
    const withLevels = models.filter((m) => m.capabilities?.effortLevels)
    expect(withLevels.length).toBeGreaterThan(0)
    for (const m of withLevels) {
      expect(m.capabilities?.supportsReasoning).toBe(true)
    }
  })
})
