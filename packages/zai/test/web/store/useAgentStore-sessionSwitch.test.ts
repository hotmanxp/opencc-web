/**
 * 回归测试 — 切会话必须清 pendingAsk(cc-003)+ 慢响应不得把会话拽回来(cc-004)。
 *
 * cc-003:`setCurrentSession` 清了 8 个键(textSegmentRev / segmentedToolUseIds
 * / sendSeq / lastRuntimeTurnIndex / lastSeqBySession / messages / compacting …),
 * **独缺 pendingAsk**。于是 A 的 AskUserQuestion 阻塞卡片会渲染进 B,并且
 * `AgentInputBox.tsx:282-283` 的 `sendBlocked = pendingAsk?.status === 'pending'`
 * 把 B 的输入框**锁死** —— 用户在 B 里既发不出消息,也没法解释为什么。
 * `createNewSession` 与 `clearMessages` 同样漏了这一个键。
 *
 * cc-004:`loadTranscript` 在 `await fetch(...)` 之后无条件
 * `set({ messages, sessionId, ... })`,用的是**函数参数** sessionId。用户在
 * 慢响应回来之前切走了会话,这个 set 会把界面拽回旧会话 —— 而
 * `setCurrentSession` 已经把 URL 写成新 sid 了,URL 与界面就此分叉。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentStore } from '../../../src/web/src/store/useAgentStore.js'

beforeAll(() => {
  // ⚠️ vitest environment = 'node' → 没有 localStorage。`loadTranscript`
  // 第一行就是 `localStorage.getItem('zai-token')`,ReferenceError 会被它
  // 自己的 `catch { /* ignore */ }` 整个吞掉 —— 连后面的 `set` 都不执行。
  // 不补这个 stub,本文件所有 loadTranscript 用例都是**假 GREEN**:
  // 「慢响应没把会话拽回来」和「响应根本没回来」在断言上长得一模一样。
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => '',
    setItem: () => undefined,
    removeItem: () => undefined,
  }
})

type AskState = NonNullable<ReturnType<typeof useAgentStore.getState>['pendingAsk']>

/**
 * 磁盘 transcript 里一条 assistant 文本消息的**完整**形态。
 * 必须与 useAgentStore-loadTranscript.test.ts 的 fixture 逐字段对齐 ——
 * loadTranscriptMessages 对缺 parentUuid / cwd / userType / sessionId /
 * version / isSidechain 的条目会抛,而 loadTranscript 的 try/catch 会把这个
 * 异常**整个吞掉**(连它后面的 set 一起),结果是「messages 没写进去」看起来
 * 像「stale 守卫生效了」。fixture 不对时这条测试会给出假 GREEN。
 */
function assistantMessage(text: string, sid: string) {
  return {
    uuid: 'u1',
    parentUuid: null,
    type: 'assistant',
    timestamp: 1,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    cwd: '/tmp',
    userType: 'zai',
    sessionId: sid,
    version: '2',
    isSidechain: false,
  }
}

function pendingAskFor(toolUseId: string): AskState {
  return {
    toolUseId,
    status: 'pending',
    questions: [{ question: '继续吗?', header: '确认' }],
    answers: {},
  } as unknown as AskState
}

describe('cc-003: 切会话 / 新建会话 / 清屏都必须清 pendingAsk', () => {
  beforeEach(() => {
    useAgentStore.setState({ sessionId: 'sess-A', pendingAsk: null, messages: [], status: 'idle' })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    useAgentStore.setState({ sessionId: null, pendingAsk: null, messages: [], status: 'idle' })
  })

  it('setCurrentSession 切到 B 后 pendingAsk 必须为 null', () => {
    // A 正挂着一个阻塞提问
    useAgentStore.setState({ pendingAsk: pendingAskFor('toolu_A1') })
    expect(useAgentStore.getState().pendingAsk?.status).toBe('pending')

    useAgentStore.getState().setCurrentSession('sess-B')

    // 判据:A 的卡片不得跟着渲染进 B,B 的输入框不得被锁死
    expect(useAgentStore.getState().pendingAsk).toBeNull()
    expect(useAgentStore.getState().sessionId).toBe('sess-B')
  })

  it('clearMessages 顺手清 pendingAsk(且它已经把 status 置 idle 解除 isBusy 门禁)', () => {
    useAgentStore.setState({
      sessionId: 'sess-A',
      pendingAsk: pendingAskFor('toolu_A1'),
      status: 'streaming',
    })
    useAgentStore.getState().clearMessages()

    // clearMessages 本就把 status 置 'idle' —— isBusy 门禁随之解除,用户不必
    // 按 Esc 就能切走。若 pendingAsk 留着,那就是「已解锁的会话里挂着一张
    // 没人能答的卡片」。
    expect(useAgentStore.getState().status).toBe('idle')
    expect(useAgentStore.getState().pendingAsk).toBeNull()
  })

  it('createNewSession 清 pendingAsk', async () => {
    useAgentStore.setState({ sessionId: 'sess-A', pendingAsk: pendingAskFor('toolu_A1') })

    const origFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, sessionId: 'sess-NEW' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch
    try {
      await useAgentStore.getState().createNewSession()
    } finally {
      globalThis.fetch = origFetch
    }

    expect(useAgentStore.getState().pendingAsk).toBeNull()
  })
})

describe('cc-004: 慢 loadTranscript 不得把用户刚切走的会话拽回来', () => {
  beforeEach(() => {
    useAgentStore.setState({ sessionId: null, pendingAsk: null, messages: [], status: 'idle' })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    useAgentStore.setState({ sessionId: null, pendingAsk: null, messages: [], status: 'idle' })
  })

  it('A 的慢响应回来时用户已切到 B → 不得覆盖 sessionId', async () => {
    let releaseA!: (v: unknown) => void
    const gateA = new Promise((r) => { releaseA = r })

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('sess-A')) {
        await gateA
        return new Response(
          JSON.stringify({ transcript: { messages: [assistantMessage('A 的回复', 'sess-A')] } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({ transcript: { messages: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    // 1) 冷启动首屏:A 的 loadTranscript 发出,响应被挂住
    useAgentStore.setState({ sessionId: 'sess-A' })
    const pending = useAgentStore.getState().loadTranscript('sess-A')

    // 2) 用户不等它,直接切到 B
    useAgentStore.getState().setCurrentSession('sess-B')
    expect(useAgentStore.getState().sessionId).toBe('sess-B')

    // 3) A 的慢响应终于回来 —— 不得把 sessionId 拽回 A
    releaseA(undefined)
    await pending

    expect(useAgentStore.getState().sessionId).toBe('sess-B')
  })

  it('冷启动首屏必须照常加载(sessionId 已由 loadSessions 预先 set,守卫不得误杀)', async () => {
    // loadSessions 的形状:先 set({sessionId}),再 await loadTranscript。
    // 守卫若写成 `cur !== sessionId` 会误杀这条正常首屏路径。
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ transcript: { messages: [assistantMessage('冷启动回复', 'sess-COLD')] } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ) as unknown as typeof fetch

    useAgentStore.setState({ sessionId: 'sess-COLD' })
    await useAgentStore.getState().loadTranscript('sess-COLD')

    expect(useAgentStore.getState().sessionId).toBe('sess-COLD')
    expect(useAgentStore.getState().messages.length).toBeGreaterThan(0)
  })

  // 注:守卫**刻意**保留 `cur !== null` 放行,即 sessionId 为 null 时一个
  // 迟到的 loadTranscript 响应仍会建立会话。这是修复计划里写明的语义 ——
  // 收紧成 `cur !== sessionId` 会误杀冷启动首屏(见 loadSessions 的
  // set({sessionId}) → loadTranscript 顺序)。这里不为它写断言,以免把
  // 「当前行为」固化成「应有行为」。
})
