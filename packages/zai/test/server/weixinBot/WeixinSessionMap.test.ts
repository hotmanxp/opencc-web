/**
 * WeixinSessionMap 测试 —— D1 映射表(合规 sessionId + 双向反查 + 持久化)。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

  it('cwd 只在首次绑定写入,后续 resolve 不覆盖(两个目录都还在)', async () => {
    const projA = mkdtempSync(join(tmpdir(), 'zai-wx-proja-'))
    const projB = mkdtempSync(join(tmpdir(), 'zai-wx-projb-'))
    const first = make()
    const b = await first.resolveOrCreate(input, projA)
    const second = make()
    const again = await second.resolveOrCreate(input, projB)
    expect(again.sessionId).toBe(b.sessionId)
    expect(again.cwd).toBe(projA)
  })

  it('绑定目录被删后 resolve 用当前 cwd 自愈(不再永久冻结死路径)', async () => {
    const dead = mkdtempSync(join(tmpdir(), 'zai-wx-dead-'))
    const alive = mkdtempSync(join(tmpdir(), 'zai-wx-alive-'))
    const b = await map.resolveOrCreate(input, dead)
    expect(b.cwd).toBe(dead)

    rmSync(dead, { recursive: true, force: true })
    const healed = await map.resolveOrCreate(input, alive)
    expect(healed.sessionId).toBe(b.sessionId) // 同一会话,不换 id
    expect(healed.cwd).toBe(alive)

    // 自愈结果已落盘 —— 新实例(模拟重启)拿到的是新目录
    const second = make()
    const restored = await second.lookupBySessionId(b.sessionId)
    expect(restored!.cwd).toBe(alive)
  })

  it('空串 cwd(历史数据)同样被补齐为当前 cwd', async () => {
    const alive = mkdtempSync(join(tmpdir(), 'zai-wx-alive-'))
    const b = await map.resolveOrCreate(input, '/stale')
    ;(b as unknown as { cwd: string }).cwd = ''
    const healed = await map.resolveOrCreate(input, alive)
    expect(healed.cwd).toBe(alive)
  })

  it('目录变成同名文件(非目录)时也自愈', async () => {
    const alive = mkdtempSync(join(tmpdir(), 'zai-wx-alive-'))
    const asFile = join(mkdtempSync(join(tmpdir(), 'zai-wx-file-')), 'not-a-dir')
    writeFileSync(asFile, 'x')
    await map.resolveOrCreate(input, asFile)
    const healed = await map.resolveOrCreate(input, alive)
    expect(healed.cwd).toBe(alive)
  })

  it('轮转不继承死 cwd(/new 也能救回卡死的 Bash)', async () => {
    const dead = mkdtempSync(join(tmpdir(), 'zai-wx-dead-'))
    const alive = mkdtempSync(join(tmpdir(), 'zai-wx-alive-'))
    const old = await map.resolveOrCreate(input, dead)
    rmSync(dead, { recursive: true, force: true })

    const rotated = await map.rotate(old.conversationKey, 'command:/new', alive)
    expect(rotated!.fresh.cwd).toBe(alive)
    // 目录仍有效时则沿用旧 cwd(冻结语义不变)
    const keep = await map.rotate(old.conversationKey, 'command:/new', mkdtempSync(join(tmpdir(), 'zai-wx-other-')))
    expect(keep!.fresh.cwd).toBe(alive)
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

  // ─── 会话轮转(TTL / 手动) ──────────────────────────────────────

  it('TTL 轮转:超过 ttlMs 后 resolveOrCreate 迁入新 session 并留轮转事件', async () => {
    map.setRotationPolicy({ ttlMs: 1000 })
    const old = await map.resolveOrCreate(input, '/proj')
    // 把 createdAt 拨回 2 小时前,模拟"存活超 TTL"
    ;(old as unknown as { createdAt: number }).createdAt = Date.now() - 2 * 3600_000
    const fresh = await map.resolveOrCreate(input, '/proj')
    expect(fresh.sessionId).not.toBe(old.sessionId)
    expect(fresh.conversationKey).toBe(old.conversationKey)
    expect(fresh.cwd).toBe('/proj')
    // 轮转事件只消费一次
    const evt = map.takeRotation(old.conversationKey)
    expect(evt?.fromSessionId).toBe(old.sessionId)
    expect(evt?.toSessionId).toBe(fresh.sessionId)
    expect(evt?.reason).toBe('ttl')
    expect(map.takeRotation(old.conversationKey)).toBeNull()
    // 旧 sessionId 仍可出站反查(在途事件镜像不断链)
    expect(map.lookupBySessionIdSync(old.sessionId)?.sessionId).toBe(old.sessionId)
    // 新消息继续走新 session,不再轮转
    const again = await map.resolveOrCreate(input, '/proj')
    expect(again.sessionId).toBe(fresh.sessionId)
  })

  it('未设策略 / ttl=0 时永不轮转', async () => {
    const a = await map.resolveOrCreate(input, '/proj')
    ;(a as unknown as { createdAt: number }).createdAt = Date.now() - 100 * 3600_000
    map.setRotationPolicy({ ttlMs: 0 })
    const b = await map.resolveOrCreate(input, '/proj')
    expect(b.sessionId).toBe(a.sessionId)
    expect(map.takeRotation(a.conversationKey)).toBeNull()
  })

  it('rotate():手动轮转,未绑定时返回 null', async () => {
    expect(await map.rotate('nope:dm:x', 'test')).toBeNull()
    const old = await map.resolveOrCreate(input, '/proj')
    const rotated = await map.rotate(old.conversationKey, 'command:/new')
    expect(rotated?.fresh.sessionId).not.toBe(old.sessionId)
    const evt = map.takeRotation(old.conversationKey)
    expect(evt?.reason).toBe('command:/new')
  })
})
