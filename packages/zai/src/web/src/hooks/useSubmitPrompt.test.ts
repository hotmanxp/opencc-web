// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn(async () => ({ sessionId: 'sess-x' })) }))
vi.mock('../lib/api.js', () => ({
  api: { post: apiPost },
}))

import { useSubmitPrompt } from './useSubmitPrompt.js'
import { useAgentStore } from '../store/useAgentStore.js'

beforeEach(() => {
  apiPost.mockClear()
  apiPost.mockResolvedValue({ sessionId: 'sess-x' } as any)
  useAgentStore.setState({
    sessionId: 'sess-1',
    activeSessionId: 'sess-1',
    status: 'idle',
    messages: [],
    sendSeq: 0,
  })
})

afterEach(() => {
  useAgentStore.setState({
    sessionId: null,
    activeSessionId: null,
    status: 'idle',
    messages: [],
    sendSeq: 0,
  })
})

describe('useSubmitPrompt — pushUserMsg', () => {
  it('写入 user.text 到 store,sendSeq +1,状态切 streaming', () => {
    const { result } = renderHook(() => useSubmitPrompt())
    act(() => {
      result.current.pushUserMsg('hi')
    })
    const s = useAgentStore.getState()
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]).toMatchObject({ type: 'user.text', text: 'hi', isRenderedPrompt: false })
    expect(s.sendSeq).toBe(1)
    expect(s.status).toBe('streaming')
  })

  it('isRenderedPrompt=true 时透传', () => {
    const { result } = renderHook(() => useSubmitPrompt())
    act(() => {
      result.current.pushUserMsg('rendered', true)
    })
    expect(useAgentStore.getState().messages[0]).toMatchObject({ isRenderedPrompt: true })
  })
})

describe('useSubmitPrompt — submitPrompt', () => {
  it('先 pushUserMsg,再 POST /agent/prompt', async () => {
    const { result } = renderHook(() => useSubmitPrompt())
    await act(async () => {
      await result.current.submitPrompt('hello')
    })
    expect(apiPost).toHaveBeenCalledTimes(1)
    expect(apiPost).toHaveBeenCalledWith(
      '/agent/prompt',
      expect.objectContaining({ prompt: 'hello', sessionId: 'sess-1' }),
      expect.any(Object),
    )
    const s = useAgentStore.getState()
    expect(s.messages.some((m: any) => m.text === 'hello')).toBe(true)
  })

  it('skipPushUserMsg=true 时不写 user.text', async () => {
    const { result } = renderHook(() => useSubmitPrompt())
    await act(async () => {
      await result.current.submitPrompt('silent', { skipPushUserMsg: true })
    })
    const s = useAgentStore.getState()
    expect(s.messages.some((m: any) => m.text === 'silent')).toBe(false)
    expect(apiPost).toHaveBeenCalledTimes(1)
  })

  it('后端响应 queued:true(对话进行中排队)→ 不 push user.text, 等开始执行时由 watcher 写入', async () => {
    apiPost.mockResolvedValueOnce({
      sessionId: 'sess-x',
      queued: true,
      queueLength: 1,
      pending: [{ id: 'q1', text: 'hello' }],
    } as any)
    const { result } = renderHook(() => useSubmitPrompt())
    await act(async () => {
      await result.current.submitPrompt('hello')
    })
    const s = useAgentStore.getState()
    expect(s.messages.some((m: any) => m.text === 'hello')).toBe(false)
    expect(apiPost).toHaveBeenCalledTimes(1)
  })

  it('sessionId 为空时回退 activeSessionId', async () => {
    useAgentStore.setState({ sessionId: null, activeSessionId: 'sess-2' })
    const { result } = renderHook(() => useSubmitPrompt())
    await act(async () => {
      await result.current.submitPrompt('x')
    })
    expect(apiPost.mock.calls[0]![1]).toMatchObject({ sessionId: 'sess-2' })
  })

  it('返回的 sessionId 同步回 store', async () => {
    apiPost.mockResolvedValueOnce({ sessionId: 'sess-new' } as any)
    // zai race fix (2026-08-28): submitPrompt 不再"无 sid 也照 POST",
    // 必须以有效 sessionId 起步 → 测试设 'sess-start' 模拟有 sid 状态。
    useAgentStore.setState({ sessionId: 'sess-start', activeSessionId: 'sess-start' })
    const { result } = renderHook(() => useSubmitPrompt())
    await act(async () => {
      await result.current.submitPrompt('first')
    })
    const s = useAgentStore.getState()
    expect(s.sessionId).toBe('sess-new')
    expect(s.activeSessionId).toBe('sess-new')
  })

  it('第一行作为 title,通过 applySessionEvent 触发 session.renamed', async () => {
    apiPost.mockResolvedValueOnce({ sessionId: 'sess-new' } as any)
    useAgentStore.setState({ sessionId: 'sess-start', activeSessionId: 'sess-start' })
    const applySpy = vi.spyOn(useAgentStore.getState(), 'applySessionEvent')
    const { result } = renderHook(() => useSubmitPrompt())
    await act(async () => {
      await result.current.submitPrompt('My Title\nnext line')
    })
    expect(applySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session.renamed',
        sessionId: 'sess-new',
        title: 'My Title',
      }),
    )
    applySpy.mockRestore()
  })
})
