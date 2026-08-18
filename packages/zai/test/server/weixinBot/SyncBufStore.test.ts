import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { WEIXIN_SYNC_DIR } from '../../../src/server/services/paths.js'

process.env.ZAI_DATA_DIR = mkdtempSync(join(tmpdir(), 'zai-weixin-sync-'))

describe('SyncBufStore', () => {
  let SyncBufStore: typeof import('@/server/services/weixinBot/stores/SyncBufStore.js').SyncBufStore
  beforeEach(async () => {
    await rm(WEIXIN_SYNC_DIR, { recursive: true, force: true })
    const mod = await import('../../../src/server/services/weixinBot/stores/SyncBufStore.js')
    SyncBufStore = mod.SyncBufStore
  })

  it('load returns empty string for unknown account', async () => {
    const s = new SyncBufStore()
    expect(await s.load('acct1')).toBe('')
  })

  it('save + load round-trip', async () => {
    const s = new SyncBufStore()
    await s.save('acct1', 'buf_payload_xyz')
    expect(await s.load('acct1')).toBe('buf_payload_xyz')
  })

  it('persists across instances', async () => {
    const s1 = new SyncBufStore()
    await s1.save('acct1', 'cur_42')
    const s2 = new SyncBufStore()
    expect(await s2.load('acct1')).toBe('cur_42')
  })

  it('overwrites on subsequent save', async () => {
    const s = new SyncBufStore()
    await s.save('acct1', 'old')
    await s.save('acct1', 'new')
    expect(await s.load('acct1')).toBe('new')
  })
})
