/**
 * WeixinSessionMap 测试 —— D1 映射表(合规 sessionId + 双向反查 + 持久化)。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WeixinSessionMap,
  conversationKeyOf,
} from '../../../src/server/services/weixinBot/WeixinSessionMap.js'

const input = {
  accountId: 'acct',
  chatType: 'dm' as const,
  chatId: 'user_a',
  senderId: 'user_a',
}

describe('WeixinSessionMap', () => {
  let map: WeixinSessionMap
  const created: WeixinSessionMap[] = []
  const make = () => {
    const m = new WeixinSessionMap()
    created.push(m)
    return m
  }
  beforeEach(() => {
    // 每个用例独立数据目录 —— 映射表是持久化的,共享目录会跨用例串味。
    process.env.ZAI_DATA_DIR = mkdtempSync(join(tmpdir(), 'zai-wx-sessmap-'))
    map = make()
  })
  afterEach(async () => {
    // flush fire-and-forget 落盘,避免写到下一个用例的数据目录
    await Promise.all(created.splice(0).map((m) => m.flush()))
  })

  it('同 conversationKey 重复 resolve → 同 sessionId', async () => {
    const a = await map.resolveOrCreate(input, '/proj')
    const b = await map.resolveOrCreate(input, '/proj')
    expect(a.sessionId).toBe(b.sessionId)
    expect(a.conversationKey).toBe(conversationKeyOf(input))
  })

  it('生成的 sessionId 符合全仓库字符集契约 sess-<uuid>', async () => {
    const b = await map.resolveOrCreate(input, '/proj')
    expect(b.sessionId).toMatch(/^sess-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    // 不能带 ':' —— transcript 文件名直接拼 sessionId
    expect(b.sessionId).not.toContain(':')
  })

  it('sessionId → conversationKey 反查一致(出站 O(1) 路径)', async () => {
    const b = await map.resolveOrCreate(input, '/proj')
    await map.lookupBySessionId(b.sessionId) // 触发 load
    const viaSync = map.lookupBySessionIdSync(b.sessionId)
    expect(viaSync?.conversationKey).toBe(b.conversationKey)
  })

  it('持久化后可被新实例恢复(重启延续同一 session)', async () => {
    const first = make()
    const b = await first.resolveOrCreate(input, '/proj')

    const second = make()
    const restored = await second.lookupBySessionId(b.sessionId)
    expect(restored).not.toBeNull()
    expect(restored!.conversationKey).toBe(b.conversationKey)
    expect(restored!.cwd).toBe('/proj')
    // 再 resolve 应复用(不新建)
    const again = await second.resolveOrCreate(input, '/other')
    expect(again.sessionId).toBe(b.sessionId)
  })

  it('cwd 只在首次绑定写入,后续 resolve 不覆盖', async () => {
    const first = make()
    const b = await first.resolveOrCreate(input, '/proj-a')
    const second = make()
    const again = await second.resolveOrCreate(input, '/proj-b')
    expect(again.sessionId).toBe(b.sessionId)
    expect(again.cwd).toBe('/proj-a')
  })

  it('dm 与 group 生成不同会话', async () => {
    const dm = await map.resolveOrCreate(input, '/proj')
    const group = await map.resolveOrCreate({ ...input, chatType: 'group', chatId: 'room_1' }, '/proj')
    expect(group.sessionId).not.toBe(dm.sessionId)
  })

  it('list() 按 lastActiveAt 倒序', async () => {
    await map.resolveOrCreate({ ...input, chatId: 'u1' }, '/proj')
    await new Promise((r) => setTimeout(r, 5))
    await map.resolveOrCreate({ ...input, chatId: 'u2' }, '/proj')
    const list = await map.list()
    expect(list[0].chatId).toBe('u2')
  })
})
