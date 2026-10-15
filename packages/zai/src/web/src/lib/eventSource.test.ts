import { describe, expect, test, vi } from 'vitest'
// 值导入(不是 type): 白名单覆盖断言要从 union 本身派生出全部 type 清单。
import { ServerEvent } from '../../../shared/events.js'
import type { StreamState } from './eventSource.js'

const notifMock = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('antd', () => ({ notification: notifMock }))

// Mirror the real EventSource semantics: the server writes each SSE frame with
// a named `event:` field (e.g. `event: runtime.delta`), and only `addEventListener`
// for that exact name fires — `onmessage` is reserved for the unnamed default.
// The previous mock only exposed `onmessage`, which is why production bugged:
// server-side named events slipped past the front end entirely.
class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  onmessage: ((e: { data: string }) => void) | null = null
  onopen: ((e: Event) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  close = vi.fn()
  private listeners: Record<string, Array<(e: { data: string }) => void>> = {}
  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }
  addEventListener(name: string, handler: (e: { data: string }) => void) {
    ;(this.listeners[name] ??= []).push(handler)
  }
  /** 白名单覆盖断言用:实际注册过的 listener 名。 */
  registeredNames(): string[] {
    return Object.keys(this.listeners)
  }
  emitOpen() {
    this.onopen?.(new Event('open'))
  }
  // Simulate the server-side writeSse producing `event: <name>\ndata: <json>`.
  dispatchNamed(name: string, payload: ServerEvent) {
    const data = JSON.stringify(payload)
    for (const handler of this.listeners[name] ?? []) handler({ data })
  }
}

vi.stubGlobal('EventSource', MockEventSource)

// Dynamic import to ensure mock is applied
const { subscribeServerEvents } = await import('./eventSource.js')

describe('subscribeServerEvents', () => {
  test('connects to /api/event (无 sid)', () => {
    MockEventSource.instances = []
    subscribeServerEvents(null, () => {})
    expect(MockEventSource.instances[0].url).toBe('/api/event')
  })

  test('带 sid 时 URL 含 ?sid=xxx (encodeURIComponent)', () => {
    MockEventSource.instances = []
    subscribeServerEvents('sess-A/with space', () => {})
    expect(MockEventSource.instances[0].url).toBe(
      '/api/event?sid=sess-A%2Fwith%20space',
    )
  })

  test('无 sid + topics 时 URL 带 topics 白名单 (无会话页面收全局事件)', () => {
    // 2026-09-30: /instances 在没有活跃会话时也要收 instance.changed,
    // 走的是 /api/event?topics=... 而不是全量流(全量会串 prompt.ask)。
    MockEventSource.instances = []
    subscribeServerEvents(null, () => {}, undefined, ['system', 'instance'])
    expect(MockEventSource.instances[0].url).toBe(
      '/api/event?topics=system%2Cinstance',
    )
  })

  test('有 sid 时忽略 topics 参数 (sid 切片已够,叠加白名单会误杀会话事件)', () => {
    MockEventSource.instances = []
    subscribeServerEvents('s1', () => {}, undefined, ['instance'])
    expect(MockEventSource.instances[0].url).toBe('/api/event?sid=s1')
  })

  test('无 sid 且 topics 为空数组时退回全量流 (旧行为不变)', () => {
    MockEventSource.instances = []
    subscribeServerEvents(null, () => {}, undefined, [])
    expect(MockEventSource.instances[0].url).toBe('/api/event')
  })

  test('compact_boundary 被 addEventListener 注册并派发到 onEvent', () => {
    // 回归 (2026-10-12): compact_boundary 曾漏登记进 NAMED_EVENT_TYPES,
    // EventSource 不为它注册 listener、帧直接消失 —— 表现是"toast 会弹但
    // 对话流里的分隔线永远不出现", 刷新后才靠历史回放补上。之前 4 个单测
    // 全绿也照样漏, 因为没有一个断言**白名单登记本身**。这条补上。
    MockEventSource.instances = []
    const onEvent = vi.fn()
    subscribeServerEvents('s1', onEvent)
    const es = MockEventSource.instances[0]
    es.dispatchNamed('compact_boundary', {
      type: 'compact_boundary',
      eventId: 'e-bnd', ts: 1, seq: 1, sessionId: 's1',
      trigger: 'auto', preTokens: 180000, messagesSummarized: 42,
    })
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'compact_boundary', preTokens: 180000 }),
    )
  })

  test('白名单覆盖 ServerEvent union 的每个 type (派生自 union 本身)', () => {
    // 根治 compact_boundary 漏登记的那条测试 (2026-10-12)。
    //
    // 之前这里没有任何断言覆盖**白名单登记本身**: 4 个单测全绿, 因为它们
    // 都只验证"已登记的事件能派发"。union 加了新成员而白名单漏登记 → 帧被
    // EventSource 静默丢弃 → 单测无感。eventSource.ts 的注释已经为此写过
    // 4 次警告(:73 / :84 / :90 / :103), 同一类坑踩了 4 次。
    //
    // 这条测试从 union 派生期望清单 —— union 加成员而白名单漏登记时立刻变红,
    // 不再依赖"谁记得手写一条断言"。反向也查: 白名单里多出的、union 已删的
    // 旧 type 是永不触发的死登记。
    //
    // 注意 packages/zai/tsconfig.json 的 include 只覆盖 src/server|cli|shared,
    // **排除了 src/web** —— 所以 eventSource.ts 里的类型断言不会被 tsc 检查,
    // 不能只靠它。这条运行时测试才是真正生效的那道闸。
    MockEventSource.instances = []
    subscribeServerEvents(null, () => {})
    const registered = new Set(MockEventSource.instances[0].registeredNames())

    // zod 4 里 ZodObject._def.shape 是**函数**(不是对象), 需调用取形状;
    // discriminator 是 z.literal, 其值在 _def.value。optionsMap 已是
    // Map<literal, schema>, 但它对 spread 合并的 union 语义不稳, 故走 options。
    const unionTypes = (
      ServerEvent as unknown as {
        _def: {
          options: Array<{
            _def: { shape: () => { type: { _def: { value?: string; values?: string[] } } } }
          }>
        }
      }
    )._def.options.map((o) => {
      const t = o._def.shape().type
      return t?._def?.value ?? t?._def?.values?.[0]
    })

    expect(unionTypes.length).toBeGreaterThan(0)

    // 刻意不登记的类型(2026-10-12 逐一查过, 不是漏登记):
    //   weixin.inbound — **设计上就不该经 SSE 到 Web UI**。它用关联键当
    //     sessionId(`weixin:<acct>:<chatType>:<chatId>`, 见
    //     WeixinBotManager.ts:720 的注释), 而服务端 SSE 按当前 tab 的
    //     zai sessionId 切片过滤, Web 面板永远匹配不上。面板改为打开时
    //     轮询 /api/weixin/diagnostics 的 recentInbound 环形缓冲
    //     (WeixinBotPanel.tsx:201 有同样说明)。所以这里**不该**登记 ——
    //     登记了也只是让每条微信消息白跑一次 parse。
    //
    // 这条断言的价值: 除上面这一条外, union 里任何 type 没被登记都会红。
    // 2026-10-12 正是靠它抓出 compact_boundary(system.restarting /
    // stopping / restart.canceled 已于同日修复)。
    const KNOWN_UNREGISTERED = new Set(['weixin.inbound'])
    const missing = unionTypes.filter(
      (t): t is string => !!t && !registered.has(t) && !KNOWN_UNREGISTERED.has(t),
    )
    // 反向:白名单里不能有 union 已删的旧 type(死登记)。
    const stale = [...registered].filter((t) => !unionTypes.includes(t))
    expect({ missing, stale }).toEqual({ missing: [], stale: [] })
  })

  test('dispatches named SSE events (runtime.delta) to onEvent', () => {
    // Regression: server writes `event: runtime.delta`, only addEventListener
    // ('runtime.delta', ...) fires. onmessage must NOT receive these.
    MockEventSource.instances = []
    const onEvent = vi.fn()
    subscribeServerEvents('s1', onEvent)
    const es = MockEventSource.instances[0]
    es.dispatchNamed('runtime.delta', {
      type: 'runtime.delta',
      eventId: 'e1', ts: 1, seq: 1, sessionId: 's1', turnIndex: 0, delta: 'hi',
    })
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'runtime.delta', delta: 'hi' }),
    )
  })

  test('dispatches runtime.started and runtime.done named events', () => {
    MockEventSource.instances = []
    const onEvent = vi.fn()
    subscribeServerEvents('s1', onEvent)
    const es = MockEventSource.instances[0]
    es.dispatchNamed('runtime.started', {
      type: 'runtime.started',
      eventId: 'e1', ts: 1, seq: 2, sessionId: 's1', turnIndex: 0,
    })
    es.dispatchNamed('runtime.done', {
      type: 'runtime.done',
      eventId: 'e2', ts: 2, seq: 3, sessionId: 's1', turnIndex: 0,
    })
    const types = onEvent.mock.calls.map((c) => (c[0] as { type: string }).type)
    expect(types).toContain('runtime.started')
    expect(types).toContain('runtime.done')
  })

  test('dispatches instance.changed named events', () => {
    MockEventSource.instances = []
    const onEvent = vi.fn()
    subscribeServerEvents('s1', onEvent)
    const es = MockEventSource.instances[0]

    es.dispatchNamed('instance.changed', {
      type: 'instance.changed',
      eventId: 'e-instance',
      ts: 1,
      seq: 4,
      instanceId: 'inst_1',
      state: 'running',
      port: 9202,
      pid: 42,
      lastHeartbeatAt: '2026-08-04T00:00:00.000Z',
    })

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'instance.changed', instanceId: 'inst_1' }),
    )
  })

  test('parses failure logs but does not throw', () => {
    MockEventSource.instances = []
    const onEvent = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    subscribeServerEvents('s1', onEvent)
    const es = MockEventSource.instances[0]
    es.dispatchNamed('runtime.delta', 'not json' as unknown as ServerEvent)
    expect(onEvent).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  test('handle.close calls es.close', () => {
    MockEventSource.instances = []
    const handle = subscribeServerEvents(null, () => {})
    const es = MockEventSource.instances[0]
    handle.close()
    expect(es.close).toHaveBeenCalled()
  })

  test('onerror 触发 notifySseError(/event) 并报 reconnecting', () => {
    notifMock.error.mockReset()
    notifMock.error.mockImplementation(() => undefined)
    MockEventSource.instances = []
    const states: StreamState[] = []
    subscribeServerEvents('s1', () => {}, (s) => states.push(s))
    const es = MockEventSource.instances[0]
    es.onerror?.(new Event('error'))
    expect(notifMock.error).toHaveBeenCalledTimes(1)
    expect(notifMock.error.mock.calls[0][0].description).toContain('/event')
    expect(states.at(-1)).toBe('reconnecting')
  })

  // ========== 连接状态机 (onState 回调) ==========

  test('reports connecting on subscribe then connected on first open', () => {
    MockEventSource.instances = []
    const states: StreamState[] = []
    subscribeServerEvents('s1', () => {}, (s) => states.push(s))
    // 首次连接: 尚未 onopen, 先报 connecting
    expect(states[0]).toBe('connecting')
    const es = MockEventSource.instances[0]
    es.emitOpen()
    expect(states.at(-1)).toBe('connected')
  })

  test('reports reconnecting on first error then connected on reopen', () => {
    MockEventSource.instances = []
    const states: StreamState[] = []
    subscribeServerEvents('s1', () => {}, (s) => states.push(s))
    const es = MockEventSource.instances[0]
    es.emitOpen()
    es.onerror?.(new Event('error'))
    expect(states.at(-1)).toBe('reconnecting')
    es.emitOpen()
    expect(states.at(-1)).toBe('connected')
  })

  test('reports reconnecting up to 3 failures then error on the 4th', () => {
    MockEventSource.instances = []
    const states: StreamState[] = []
    subscribeServerEvents('s1', () => {}, (s) => states.push(s))
    const es = MockEventSource.instances[0]
    es.emitOpen()
    es.onerror?.(new Event('error'))
    es.onerror?.(new Event('error'))
    es.onerror?.(new Event('error'))
    // 连续失败 <= 3 次仍是 reconnecting (EventSource 自动重连中)
    expect(states.at(-1)).toBe('reconnecting')
    // 第 4 次失败 → error (UI 显示错误 + 手动重连)
    es.onerror?.(new Event('error'))
    expect(states.at(-1)).toBe('error')
  })
})