import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockPlugins = {
  listInstalled: vi.fn(),
  listAvailable: vi.fn(),
  setEnabled: vi.fn(),
  install: vi.fn(),
  uninstall: vi.fn(),
  update: vi.fn(),
  reload: vi.fn(),
  listMarketplaces: vi.fn(),
  addMarketplace: vi.fn(),
}
const mockGetRuntime = vi.fn()

vi.mock('../../../src/server/services/agentRuntime.js', () => ({
  getRuntime: () => mockGetRuntime(),
}))

afterEach(() => {
  vi.clearAllMocks()
})

async function bootstrap(runtime: unknown) {
  mockGetRuntime.mockReturnValue(runtime)
  vi.resetModules()
  const { default: router } = await import('../../../src/server/routes/plugins.js')
  const app = express()
  app.use(express.json())
  app.use('/api/plugins', router)
  return { app }
}

describe('routes/plugins', () => {
  it('GET / returns installed list when runtime ready', async () => {
    mockPlugins.listInstalled.mockResolvedValue({ plugins: [{ id: 'a@m', name: 'a' }], errors: [] })
    const { app } = await bootstrap({ plugins: mockPlugins })
    const r = await request(app).get('/api/plugins/')
    expect(r.status).toBe(200)
    expect(r.body.plugins[0].id).toBe('a@m')
  })

  it('GET / returns 503 when runtime is null', async () => {
    const { app } = await bootstrap(null)
    const r = await request(app).get('/api/plugins/')
    expect(r.status).toBe(503)
  })

  it('GET / returns 503 when getRuntime throws', async () => {
    mockGetRuntime.mockImplementation(() => { throw new Error('not initialized') })
    const { app } = await bootstrap(null)
    const r = await request(app).get('/api/plugins/')
    expect(r.status).toBe(503)
    expect(r.body.error).toBe('agent runtime not ready')
  })

  it('POST /enable forwards id and returns success', async () => {
    mockPlugins.setEnabled.mockResolvedValue({ success: true, message: 'ok', state: { plugins: [], errors: [] } })
    const { app } = await bootstrap({ plugins: mockPlugins })
    const r = await request(app).post('/api/plugins/enable').send({ id: 'a@m' })
    expect(r.status).toBe(200)
    expect(mockPlugins.setEnabled).toHaveBeenCalledWith('a@m', true)
    expect(r.body.success).toBe(true)
  })

  it('POST /disable forwards enabled=false', async () => {
    mockPlugins.setEnabled.mockResolvedValue({ success: true, message: 'ok' })
    const { app } = await bootstrap({ plugins: mockPlugins })
    await request(app).post('/api/plugins/disable').send({ id: 'a@m' })
    expect(mockPlugins.setEnabled).toHaveBeenCalledWith('a@m', false)
  })

  it('POST / with empty body returns 400', async () => {
    const { app } = await bootstrap({ plugins: mockPlugins })
    const r = await request(app).post('/api/plugins/enable').send({})
    expect(r.status).toBe(400)
  })

  it('POST /enable success=false still returns 200', async () => {
    mockPlugins.setEnabled.mockResolvedValue({ success: false, message: 'not found' })
    const { app } = await bootstrap({ plugins: mockPlugins })
    const r = await request(app).post('/api/plugins/enable').send({ id: 'x@m' })
    expect(r.status).toBe(200)
    expect(r.body.success).toBe(false)
  })

  it('POST /reload returns action result', async () => {
    mockPlugins.reload.mockResolvedValue({ success: true, message: 'Reloaded', reload: { plugins: 1, commands: 0, agents: 0, hooks: 0, mcpServers: 0, errors: 0 } })
    const { app } = await bootstrap({ plugins: mockPlugins })
    const r = await request(app).post('/api/plugins/reload')
    expect(r.status).toBe(200)
    expect(r.body.reload.plugins).toBe(1)
  })

  it('GET /available returns marketplace list', async () => {
    mockPlugins.listAvailable.mockResolvedValue([{ id: 'p@m', name: 'p' }])
    const { app } = await bootstrap({ plugins: mockPlugins })
    const r = await request(app).get('/api/plugins/available')
    expect(r.status).toBe(200)
    expect(r.body.plugins[0].name).toBe('p')
  })

  it('GET /marketplaces returns configured sources', async () => {
    mockPlugins.listMarketplaces.mockResolvedValue([
      { name: 'zn-plugins-market', source: 'org/repo', sourceType: 'github', pluginCount: 11, installedCount: 3 },
    ])
    const { app } = await bootstrap({ plugins: mockPlugins })
    const r = await request(app).get('/api/plugins/marketplaces')
    expect(r.status).toBe(200)
    expect(r.body.marketplaces[0].name).toBe('zn-plugins-market')
    expect(r.body.marketplaces[0].pluginCount).toBe(11)
  })

  it('GET /marketplaces returns 503 when runtime is null', async () => {
    const { app } = await bootstrap(null)
    const r = await request(app).get('/api/plugins/marketplaces')
    expect(r.status).toBe(503)
  })

  it('POST /marketplaces/add forwards source and returns fresh lists', async () => {
    mockPlugins.addMarketplace.mockResolvedValue({
      success: true,
      name: 'zn-plugins-market',
      message: '已添加市场: zn-plugins-market',
      marketplaces: [{ name: 'zn-plugins-market' }],
      available: [{ id: 'p@zn-plugins-market', name: 'p' }],
    })
    const { app } = await bootstrap({ plugins: mockPlugins })
    const r = await request(app).post('/api/plugins/marketplaces/add').send({ source: 'org/repo' })
    expect(r.status).toBe(200)
    expect(mockPlugins.addMarketplace).toHaveBeenCalledWith('org/repo')
    expect(r.body.success).toBe(true)
    expect(r.body.available[0].id).toBe('p@zn-plugins-market')
  })

  it('POST /marketplaces/add without source returns 400', async () => {
    const { app } = await bootstrap({ plugins: mockPlugins })
    const r = await request(app).post('/api/plugins/marketplaces/add').send({})
    expect(r.status).toBe(400)
    expect(mockPlugins.addMarketplace).not.toHaveBeenCalled()
  })

  // Parse / policy / clone failures are domain errors, not transport errors —
  // the UI needs the message verbatim, so they must not become 4xx.
  it('POST /marketplaces/add surfaces failure as 200 + success:false', async () => {
    mockPlugins.addMarketplace.mockResolvedValue({ success: false, message: '无法识别的市场地址格式。' })
    const { app } = await bootstrap({ plugins: mockPlugins })
    const r = await request(app).post('/api/plugins/marketplaces/add').send({ source: '???' })
    expect(r.status).toBe(200)
    expect(r.body.success).toBe(false)
    expect(r.body.message).toContain('无法识别')
  })
})