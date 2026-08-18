import { describe, it, expect, beforeEach } from 'vitest'
import { rm } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WEIXIN_CONTEXT_DIR } from '../../../src/server/services/paths.js'

// 由于 ContextTokenStore 内部硬编码 WEIXIN_CONTEXT_DIR，这里 binding
// ZAI_DATA_DIR 之前先把它指向临时目录。
process.env.ZAI_DATA_DIR = mkdtempSync(join(tmpdir(), 'zai-weixin-ctx-'))

describe('ContextTokenStore', () => {
  let ContextTokenStore: typeof import('@/server/services/weixinBot/stores/ContextTokenStore.js').ContextTokenStore
  beforeEach(async () => {
    await rm(WEIXIN_CONTEXT_DIR, { recursive: true, force: true })
    const mod = await import('../../../src/server/services/weixinBot/stores/ContextTokenStore.js')
    ContextTokenStore = mod.ContextTokenStore
  })

  it('set + get round-trip', async () => {
    const s = new ContextTokenStore()
    await s.set('acct1', 'peer1', 'token-A')
    expect(await s.get('acct1', 'peer1')).toBe('token-A')
  })

  it('persists across instances (read from disk)', async () => {
    const s1 = new ContextTokenStore()
    await s1.set('acct1', 'peer1', 'token-A')
    await s1.set('acct1', 'peer2', 'token-B')
    // 新实例 — 触发 load
    const s2 = new ContextTokenStore()
    expect(await s2.get('acct1', 'peer1')).toBe('token-A')
    expect(await s2.get('acct1', 'peer2')).toBe('token-B')
  })

  it('returns null for unknown peer', async () => {
    const s = new ContextTokenStore()
    expect(await s.get('acct1', 'peer_unknown')).toBeNull()
  })

  it('overwrites existing token', async () => {
    const s = new ContextTokenStore()
    await s.set('acct1', 'peer1', 'token-old')
    await s.set('acct1', 'peer1', 'token-new')
    expect(await s.get('acct1', 'peer1')).toBe('token-new')
  })

  it('accountId safe-encoded for filesystem', async () => {
    const s = new ContextTokenStore()
    await s.set('weird/acct:id', 'peer1', 'token-X')
    expect(await s.get('weird/acct:id', 'peer1')).toBe('token-X')
  })
})
