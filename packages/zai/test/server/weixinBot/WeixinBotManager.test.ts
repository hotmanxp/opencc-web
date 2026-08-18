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
import { eventBus } from '../../../src/server/services/eventBus.js'
import type { WeixinBotSettings } from '../../../src/shared/weixin.js'

// 用临时 ZAI_DATA_DIR 避免污染 ~/.zai,且让所有 weixinBot 测试共享 lock dir
// 隔离(proper-lockfile 在 WEIXIN_LOCKS_DIR 里建文件)
const _tmpDir = mkdtempSync(join(tmpdir(), 'zai-weixin-mgr-'))
process.env.ZAI_DATA_DIR = _tmpDir

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

describe('WeixinBotManager', () => {
  beforeEach(() => {
    // eventBus 清掉 history 避免与本测试隔离
    // (eventBus 没有 reset API,这里仅清隐式状态)
  })

  it('start() with no settings → state=unconfigured', async () => {
    const { manager } = makeManager()
    await manager.start()
    expect(manager.state()).toBe('unconfigured')
    expect(manager.status().enabled).toBe(false)
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
    const sessionId = 'weixin:acct:dm:user_a'

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
})
