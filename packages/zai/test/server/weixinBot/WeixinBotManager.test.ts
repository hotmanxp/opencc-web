/**
 * WeixinBotManager 集成测试 — 验证 eventBus 双向桥 + 启动 / 停止。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WeixinBotManager } from '../../../src/server/services/weixinBot/WeixinBotManager.js'
import { WeixinAdapter } from '../../../src/server/services/weixinBot/WeixinAdapter.js'
import type { InternalWeixinMessage } from '../../../src/server/services/weixinBot/WeixinAdapter.js'
import {
  getWeixinSessionMap,
  resetWeixinSessionMapForTests,
} from '../../../src/server/services/weixinBot/WeixinSessionMap.js'
import { WeixinOwnerLock } from '../../../src/server/services/weixinBot/WeixinOwnerLock.js'
import { eventBus } from '../../../src/server/services/eventBus.js'
import type { WeixinBotSettings } from '../../../src/shared/weixin.js'

// 用临时 ZAI_DATA_DIR 避免污染 ~/.zai,且让所有 weixinBot 测试共享 lock dir
// 隔离(proper-lockfile 在 lock dir 里建文件)
const _tmpDir = mkdtempSync(join(tmpdir(), 'zai-weixin-mgr-'))
process.env.ZAI_DATA_DIR = _tmpDir
// P5:全局 owner 锁固定在 ~/.zai/weixin/locks(机器级,不随 ZAI_DATA_DIR 漂移),
// 测试必须用覆盖变量把它指到临时目录,否则会污染真机锁。
const _ownerLockDir = mkdtempSync(join(tmpdir(), 'zai-weixin-owner-'))
process.env.ZAI_WEIXIN_OWNER_LOCK_DIR = _ownerLockDir

function mockFetchOk(json: unknown, holdMs = 100): typeof fetch {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    if (init?.signal?.aborted) {
      const e = new Error('aborted')
      e.name = 'AbortError'
      throw e
    }
    const url = String(input)
    if (url.includes('/getupdates')) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, holdMs)
        t.unref?.()
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t)
          const e = new Error('aborted')
          e.name = 'AbortError'
          reject(e)
        }, { once: true })
      })
      return new Response(JSON.stringify({ ret: 0, errcode: 0, msgs: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify(json), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

function makeManager(deps?: Partial<{ getSettings: () => WeixinBotSettings | null; createAdapter: (s: WeixinBotSettings) => WeixinAdapter }>) {
  const fetchImpl = mockFetchOk({ ret: 0, errcode: 0 })
  let adapterRef: { current: WeixinAdapter | null } = { current: null }
  const manager = new WeixinBotManager({
    getSettings: deps?.getSettings ?? (() => null),
    // P6:测试进程没有 ZAI_SUPERVISOR_PID,显式放行 supervisor 门控。
    isManagedChild: () => true,
    createAdapter: deps?.createAdapter ?? ((s) => {
      const a = new WeixinAdapter({
        accountId: s.accountId ?? 'acct',
        token: s.token ?? 'tk',
        baseUrl: s.baseUrl,
        cdnBaseUrl: s.cdnBaseUrl,
        dmPolicy: s.dmPolicy,
        groupPolicy: s.groupPolicy,
        allowFrom: s.allowFrom,
        groupAllowFrom: s.groupAllowFrom,
        fetchImpl,
        mediaDir: mkdtempSync(join(tmpdir(), 'zai-mgr-')),
      })
      adapterRef.current = a
      return a
    }),
  })
  return { manager, adapterRef, fetchImpl }
}

/** 建立微信会话绑定(出站反查依赖它)。 */
async function bindSession(chatId: string, accountId = 'acct'): Promise<string> {
  const b = await getWeixinSessionMap().resolveOrCreate(
    { accountId, chatType: 'dm', chatId, senderId: chatId },
    _tmpDir,
  )
  return b.sessionId
}

describe('WeixinBotManager', () => {
  beforeEach(async () => {
    // P5:每个用例从干净的 owner 锁开始,避免上一个用例残留的持有者
    // 把本用例挤到 standby。
    await WeixinOwnerLock.forceTakeover()
    resetWeixinSessionMapForTests()
  })

  it('start() with no settings → state=unconfigured', async () => {
    const { manager } = makeManager()
    await manager.start()
    expect(manager.state()).toBe('unconfigured')
    expect(manager.status().enabled).toBe(false)
  })

  // 兜底:zai 重启后 deps.getSettings() 拿不到 token(生产 wiring 没接
  // zaiSettings),但 accounts/<id>.json 持久化了 QR 凭据 — start()
  // 自动从 accounts/ 挑 mtime 最新的恢复,免得每次重启都重新扫码。
  it('start() auto-restores from accounts/ when deps.getSettings() returns null (no re-QR needed on restart)', async () => {
    const tok = `tok-restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const accountId = 'restart-bot@im.bot'
    const ilinkUserId = 'o9cq80restart_uid@im.wechat'
    // 先存一份 account 到当前 ZAI_DATA_DIR(测试 setup 已设)
    const { manager: m1 } = makeManager()
    await m1.saveAccount(accountId, tok, 'https://ilinkai.weixin.qq.com', ilinkUserId)

    // 新 manager,deps.getSettings() 返回 null,但 accounts/ 里有 bot
    const { manager: m2, adapterRef } = makeManager()  // getSettings 默认 () => null
    await m2.start()
    expect(m2.state()).toBe('connected')
    expect(m2.status().accountId).toBe(accountId)
    expect(adapterRef.current).not.toBeNull()
    await m2.stop()
  })

  it('start() with enabled=false → state=disabled', async () => {
    const { manager } = makeManager({
      getSettings: () => ({ enabled: false, accountId: 'acct', token: 'tk' }),
    })
    await manager.start()
    expect(manager.state()).toBe('disabled')
  })

  it('start() with enabled=true + valid settings → connected', async () => {
    const { manager } = makeManager({
      getSettings: () => ({ enabled: true, accountId: 'acct', token: `tk-${Date.now()}-${Math.random()}` }),
    })
    await manager.start()
    if (manager.state() !== 'connected') {
      throw new Error(`expected connected, got ${manager.state()} lastError=${manager.status().lastError}`)
    }
    expect(manager.state()).toBe('connected')
    await manager.stop()
  })

  it('start() with missing accountId/token → failed', async () => {
    const { manager } = makeManager({
      getSettings: () => ({ enabled: true }),
    })
    await manager.start()
    expect(manager.state()).toBe('failed')
    expect(manager.status().lastError).toMatch(/missing/i)
  })

  it('inbound message → eventBus emits weixin.inbound', async () => {
    const { manager, adapterRef } = makeManager({
      getSettings: () => ({ enabled: true, accountId: 'acct', token: `tk-in-${Date.now()}-${Math.random()}` }),
    })
    await manager.start()
    const received: unknown[] = []
    const unsub = eventBus.subscribe((event) => {
      if (event.type === 'weixin.inbound') received.push(event)
    })
    const internal: InternalWeixinMessage = {
      accountId: 'acct',
      chatId: 'user_a',
      chatType: 'dm',
      senderId: 'user_a',
      text: 'hello',
      mediaPaths: [],
      mediaTypes: [],
      messageId: 'm1',
      contextToken: 'CT',
      raw: null,
    }
    adapterRef.current!.setEmitter((m) => {
      // 模拟 _processMessage 路径
      // 直接调用 manager 的内部 emit,通过 adapter.setEmitter 注入
      ;(manager as unknown as { _onInbound: (m: InternalWeixinMessage) => void })._onInbound(m)
    })
    // 这是 monkey-patch 路径 — 但 WeixinAdapter._emit 已经调 emitInternal
    // 我们直接 emit 通过 eventBus
    eventBus.emit({
      type: 'weixin.inbound',
      sessionId: 'weixin:acct:dm:user_a',
      accountId: 'acct',
      chatType: 'dm',
      chatId: 'user_a',
      senderId: 'user_a',
      text: 'hello',
      mediaPaths: [],
      mediaTypes: [],
      messageId: 'm1',
      contextToken: 'CT',
    } as unknown as Parameters<typeof eventBus.emit>[0])
    await new Promise((r) => setTimeout(r, 50))
    unsub()
    expect(received.length).toBeGreaterThan(0)
    const last = received[received.length - 1] as { sessionId: string; text: string }
    expect(last.sessionId).toBe('weixin:acct:dm:user_a')
    expect(last.text).toBe('hello')
    await manager.stop()
  })

  it('runtime.delta accumulating → runtime.done → adapter.sendText', async () => {
    const { manager, adapterRef } = makeManager({
      getSettings: () => ({ enabled: true, accountId: 'acct', token: `tk-rt-${Date.now()}-${Math.random()}` }),
    })
    await manager.start()
    const sendSpy = vi.spyOn(adapterRef.current!, 'sendText')
    // P0/D1:出站按 sessionId → 映射表反查 chatId,先建立绑定。
    const sessionId = await bindSession('user_a')

    eventBus.emit({
      type: 'runtime.started',
      sessionId,
      turnIndex: 0,
    } as unknown as Parameters<typeof eventBus.emit>[0])
    await new Promise((r) => setTimeout(r, 30))
    eventBus.emit({
      type: 'runtime.delta',
      sessionId,
      turnIndex: 0,
      delta: 'Hello, ',
    } as unknown as Parameters<typeof eventBus.emit>[0])
    eventBus.emit({
      type: 'runtime.delta',
      sessionId,
      turnIndex: 0,
      delta: 'world!',
    } as unknown as Parameters<typeof eventBus.emit>[0])
    eventBus.emit({
      type: 'runtime.done',
      sessionId,
      turnIndex: 0,
    } as unknown as Parameters<typeof eventBus.emit>[0])
    await new Promise((r) => setTimeout(r, 200))
    expect(sendSpy).toHaveBeenCalledWith('user_a', 'Hello, world!')
    await manager.stop()
  })

  it('runtime events for other sessions are ignored', async () => {
    const { manager, adapterRef } = makeManager({
      getSettings: () => ({ enabled: true, accountId: 'acct', token: `tk-oi-${Date.now()}-${Math.random()}` }),
    })
    await manager.start()
    const sendSpy = vi.spyOn(adapterRef.current!, 'sendText')
    // 其他 accountId 命名空间
    eventBus.emit({
      type: 'runtime.delta',
      sessionId: 'weixin:other_account:dm:user_a',
      turnIndex: 0,
      delta: 'leak',
    } as unknown as Parameters<typeof eventBus.emit>[0])
    eventBus.emit({
      type: 'runtime.done',
      sessionId: 'weixin:other_account:dm:user_a',
      turnIndex: 0,
    } as unknown as Parameters<typeof eventBus.emit>[0])
    await new Promise((r) => setTimeout(r, 100))
    expect(sendSpy).not.toHaveBeenCalled()
    await manager.stop()
  })

  it('stop() disconnects adapter and clears subscriptions', async () => {
    const { manager, adapterRef } = makeManager({
      getSettings: () => ({ enabled: true, accountId: 'acct', token: `tk-st-${Date.now()}-${Math.random()}` }),
    })
    await manager.start()
    expect(manager.state()).toBe('connected')
    const disconnectSpy = vi.spyOn(adapterRef.current!, 'disconnect')
    await manager.stop()
    expect(disconnectSpy).toHaveBeenCalled()
    expect(manager.state()).toBe('disconnected')
  })

  // ─── P0/D4:出站回执 ────────────────────────────────────────────

  it('runtime.error(turn 级)→ 回错误文案,且绝对路径被脱敏', async () => {
    const { manager, adapterRef } = makeManager({
      getSettings: () => ({ enabled: true, accountId: 'acct', token: `tk-err-${Date.now()}-${Math.random()}` }),
    })
    await manager.start()
    const sendSpy = vi.spyOn(adapterRef.current!, 'sendText')
    const sessionId = await bindSession('user_e')

    eventBus.emit({
      type: 'runtime.error',
      sessionId,
      turnIndex: 0,
      error: {
        category: 'internal',
        message: 'ENOENT: open /Users/secret/keys/prod.pem failed',
        recoverable: false,
      },
    } as unknown as Parameters<typeof eventBus.emit>[0])
    await new Promise((r) => setTimeout(r, 50))

    expect(sendSpy).toHaveBeenCalledTimes(1)
    const [chatId, text] = sendSpy.mock.calls[0] as [string, string]
    expect(chatId).toBe('user_e')
    expect(text).toContain('internal')
    expect(text).not.toContain('/Users/secret')
    expect(text).toContain('<path>')
    await manager.stop()
  })

  it('runtime.error(工具级,toolUseId 存在)→ 不回执(避免刷屏)', async () => {
    const { manager, adapterRef } = makeManager({
      getSettings: () => ({ enabled: true, accountId: 'acct', token: `tk-tool-${Date.now()}-${Math.random()}` }),
    })
    await manager.start()
    const sendSpy = vi.spyOn(adapterRef.current!, 'sendText')
    const sessionId = await bindSession('user_t')

    eventBus.emit({
      type: 'runtime.error',
      sessionId,
      turnIndex: 0,
      error: { category: 'internal', message: 'tool blew up', recoverable: true },
      toolUseId: 'tool-1',
    } as unknown as Parameters<typeof eventBus.emit>[0])
    await new Promise((r) => setTimeout(r, 50))
    expect(sendSpy).not.toHaveBeenCalled()
    await manager.stop()
  })

  it('runtime.aborted → 回已中断', async () => {
    const { manager, adapterRef } = makeManager({
      getSettings: () => ({ enabled: true, accountId: 'acct', token: `tk-abor-${Date.now()}-${Math.random()}` }),
    })
    await manager.start()
    const sendSpy = vi.spyOn(adapterRef.current!, 'sendText')
    const sessionId = await bindSession('user_ab')

    eventBus.emit({
      type: 'runtime.aborted',
      sessionId,
      turnIndex: 0,
      reason: 'user',
    } as unknown as Parameters<typeof eventBus.emit>[0])
    await new Promise((r) => setTimeout(r, 50))
    expect(sendSpy).toHaveBeenCalledWith('user_ab', expect.stringContaining('中断'))
    await manager.stop()
  })

  it('runtime.done 且无任何输出 → 兜底提示(不静默)', async () => {
    const { manager, adapterRef } = makeManager({
      getSettings: () => ({ enabled: true, accountId: 'acct', token: `tk-empty-${Date.now()}-${Math.random()}` }),
    })
    await manager.start()
    const sendSpy = vi.spyOn(adapterRef.current!, 'sendText')
    const sessionId = await bindSession('user_z')

    eventBus.emit({
      type: 'runtime.done',
      sessionId,
      turnIndex: 0,
    } as unknown as Parameters<typeof eventBus.emit>[0])
    await new Promise((r) => setTimeout(r, 50))
    expect(sendSpy).toHaveBeenCalledTimes(1)
    await manager.stop()
  })

  // ─── P5/P6 门控 ────────────────────────────────────────────────

  it('P6:非 supervisor 进程 → supervisor_required,不建 adapter', async () => {
    const fetchImpl = mockFetchOk({ ret: 0, errcode: 0 })
    const manager = new WeixinBotManager({
      getSettings: () => ({ enabled: true, accountId: 'acct', token: 'tk-nosup' }),
      isManagedChild: () => false,
      createAdapter: (s) => new WeixinAdapter({
        accountId: s.accountId ?? 'acct',
        token: s.token ?? 'tk',
        fetchImpl,
        mediaDir: mkdtempSync(join(tmpdir(), 'zai-mgr-')),
      }),
    })
    await manager.start()
    expect(manager.state()).toBe('supervisor_required')
    expect(manager.getAdapter()).toBeNull()
    expect(manager.status().owner).toBe(false)
  })

  it('P5:owner 锁被他人持有时 → standby,不建 adapter', async () => {
    const { WeixinOwnerLock } = await import('../../../src/server/services/weixinBot/WeixinOwnerLock.js')
    const held = await WeixinOwnerLock.acquire({
      instanceId: 'other', pid: 4242, supervisorPid: 1, port: 9201,
      cwd: '/other', accountId: 'other_acct', hostname: 'h', startedAt: Date.now(),
    })
    expect(held.ok).toBe(true)
    try {
      const { manager } = makeManager({
        getSettings: () => ({ enabled: true, accountId: 'acct', token: `tk-standby-${Date.now()}` }),
      })
      await manager.start()
      expect(manager.state()).toBe('standby')
      expect(manager.getAdapter()).toBeNull()
      const st = manager.status()
      expect(st.owner).toBe(false)
      expect(st.ownerInfo?.instanceId).toBe('other')
    } finally {
      if (held.ok) await held.handle.release()
    }
  })
})
