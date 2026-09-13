/**
 * WeixinPendingStore 测试 —— P2 落盘 + 幂等。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WeixinPendingStore,
  type PendingInbound,
} from '../../../src/server/services/weixinBot/WeixinPendingStore.js'

const entry = (messageId: string, receivedAt: number): PendingInbound => ({
  messageId,
  accountId: 'acct',
  chatType: 'dm',
  chatId: 'user_a',
  senderId: 'user_a',
  text: `hi-${messageId}`,
  mediaPaths: [],
  mediaTypes: [],
  contextToken: null,
  receivedAt,
})

describe('WeixinPendingStore', () => {
  let store: WeixinPendingStore
  const created: WeixinPendingStore[] = []
  const make = () => {
    const s = new WeixinPendingStore()
    created.push(s)
    return s
  }
  beforeEach(() => {
    process.env.ZAI_DATA_DIR = mkdtempSync(join(tmpdir(), 'zai-wx-pending-'))
    store = make()
  })
  afterEach(async () => {
    await Promise.all(created.splice(0).map((s) => s.flush()))
  })

  it('save → list 按 receivedAt 升序', async () => {
    await store.save(entry('m2', 200))
    await store.save(entry('m1', 100))
    const list = await store.list()
    expect(list.map((x) => x.messageId)).toEqual(['m1', 'm2'])
  })

  it('count 忽略 processed.json', async () => {
    await store.save(entry('m1', 1))
    await store.markProcessed('m9')
    // 让 writeChain 落地
    await new Promise((r) => setTimeout(r, 30))
    expect(await store.count()).toBe(1)
  })

  it('remove 后不再出现在 list', async () => {
    await store.save(entry('m1', 1))
    await store.remove('m1')
    expect(await store.list()).toHaveLength(0)
  })

  it('isProcessed 体现幂等键;新实例从磁盘恢复', async () => {
    expect(await store.isProcessed('m1')).toBe(false)
    await store.markProcessed('m1')
    expect(await store.isProcessed('m1')).toBe(true)
    await new Promise((r) => setTimeout(r, 30))
    const fresh = make()
    expect(await fresh.isProcessed('m1')).toBe(true)
  })

  it('同 messageId 覆盖写不产生重复项', async () => {
    await store.save(entry('m1', 1))
    await store.save(entry('m1', 2))
    const list = await store.list()
    expect(list).toHaveLength(1)
    expect(list[0].receivedAt).toBe(2)
  })
})
