/**
 * sessionModel 测试 —— 渠道模型配置 → 会话 transcript.meta 的种子化。
 *
 * 守护三条行为:
 *   1. 未配置 model → 完全不碰 store(微信会话跟随全局默认);
 *   2. 会话已有明确 model → 不覆盖 —— 用户在 9199 专用实例 Web UI 上用模型
 *      按钮手选的结果必须赢过面板配置,否则面板一动就把人家选好的冲掉;
 *   3. 任何异常都吞掉 —— 模型打不上不能让用户的消息投递失败(那比用错
 *      模型严重得多),退化成全局默认即可。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

let settings: { weixinBot?: Record<string, unknown> } = {}
const diskPath = '/nonexistent/zai-settings-for-sessionModel-test.json'

// seeding 直接读磁盘(绕开不可靠的 fs.watch 缓存),所以桩掉 readFileSync +
// zaiSettingsPath,而不是缓存 API。
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    readFileSync: (p: string, ...rest: unknown[]) => {
      if (p === diskPath) return JSON.stringify({ weixinBot: settings.weixinBot })
      return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)
    },
  }
})

vi.mock('../../../src/server/services/zaiSettingsStore.js', () => ({
  zaiSettingsPath: () => diskPath,
}))

const {
  seedSessionModel,
  setWeixinTranscriptStoreProvider,
  __resetWeixinTranscriptStoreProviderForTests,
} = await import('../../../src/server/services/weixinBot/sessionModel.js')

/** transcript store 桩:`currentModel` 模拟会话已落盘的 meta.model。 */
function stubStore(currentModel?: string) {
  const patch = vi.fn().mockResolvedValue(undefined)
  const store = {
    read: vi.fn().mockResolvedValue(
      currentModel === undefined ? { meta: {} } : { meta: { model: currentModel } },
    ),
    patch,
  }
  setWeixinTranscriptStoreProvider(() => store)
  return store
}

beforeEach(() => {
  settings = {}
  __resetWeixinTranscriptStoreProviderForTests()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('seedSessionModel', () => {
  it('未配置 model → 完全不碰 store(跟随全局默认)', async () => {
    const store = stubStore()
    await seedSessionModel('sess-1', '/tmp/p')
    expect(store.read).not.toHaveBeenCalled()
    expect(store.patch).not.toHaveBeenCalled()
  })

  it('model 为空串 / 纯空白 → 同样视为未配置', async () => {
    for (const blank of ['', '   ']) {
      const store = stubStore()
      settings = { weixinBot: { model: blank } }
      await seedSessionModel('sess-1', '/tmp/p')
      expect(store.patch).not.toHaveBeenCalled()
    }
  })

  it('已配置 → patch 写入 model / providerId / effort', async () => {
    const store = stubStore()
    settings = {
      weixinBot: { model: 'MiniMax-M3', providerId: 'zhiniao', effort: 'high' },
    }
    await seedSessionModel('sess-1', '/tmp/p')
    expect(store.patch).toHaveBeenCalledWith(
      'sess-1',
      { model: 'MiniMax-M3', providerId: 'zhiniao', effort: 'high' },
      { cwd: '/tmp/p' },
    )
  })

  it('providerId / effort 缺失或空串 → 不写进 patch(不覆盖模型自身默认)', async () => {
    const store = stubStore()
    settings = { weixinBot: { model: 'MiniMax-M3' } }
    await seedSessionModel('sess-1', '/tmp/p')
    expect(store.patch).toHaveBeenCalledWith(
      'sess-1',
      { model: 'MiniMax-M3' },
      { cwd: '/tmp/p' },
    )
  })

  it('会话已有 model → 不覆盖(用户手选的结果优先)', async () => {
    const store = stubStore('glm-4.6')
    settings = { weixinBot: { model: 'MiniMax-M3' } }
    await seedSessionModel('sess-1', '/tmp/p')
    expect(store.read).toHaveBeenCalledWith('sess-1', { cwd: '/tmp/p' })
    expect(store.patch).not.toHaveBeenCalled()
  })

  it("meta.model === 'unknown' → 视为未选,正常种子化", async () => {
    const store = stubStore('unknown')
    settings = { weixinBot: { model: 'MiniMax-M3' } }
    await seedSessionModel('sess-1', '/tmp/p')
    expect(store.patch).toHaveBeenCalled()
  })

  it('未注册 store provider → 静默跳过(测试 / 早期启动路径)', async () => {
    __resetWeixinTranscriptStoreProviderForTests()
    settings = { weixinBot: { model: 'MiniMax-M3' } }
    await expect(seedSessionModel('sess-1', '/tmp/p')).resolves.toBeUndefined()
  })

  it('patch 抛错 → 吞掉,不冒泡(退化成全局默认而不是丢消息)', async () => {
    const store = stubStore()
    store.patch.mockRejectedValue(new Error('EACCES'))
    settings = { weixinBot: { model: 'MiniMax-M3' } }
    await expect(seedSessionModel('sess-1', '/tmp/p')).resolves.toBeUndefined()
  })

  it('read 抛错 → 同样吞掉', async () => {
    const store = stubStore()
    store.read.mockRejectedValue(new Error('store not initialized'))
    settings = { weixinBot: { model: 'MiniMax-M3' } }
    await expect(seedSessionModel('sess-1', '/tmp/p')).resolves.toBeUndefined()
  })
})
