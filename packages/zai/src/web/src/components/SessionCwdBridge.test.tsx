// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'

// 必须 mock useSessionCwd (network) + useAgentStore (session id) — 桥接组件
// 只通过这两个 hook 接收 session cwd, 我们在这里注入受控值, 然后断言
// useAppStore.instanceContext.cwdName 被正确地以"对象 patch"方式写入。

const mockUseSessionCwd = vi.fn<() => string | undefined>()
const mockSessionId = vi.fn<() => string | null>()

vi.mock('../hooks/useSessionCwd.js', () => ({
  useSessionCwd: () => mockUseSessionCwd(),
}))
vi.mock('../store/useAgentStore.js', () => ({
  useAgentStore: (selector: (s: { sessionId: string | null }) => unknown) =>
    selector({ sessionId: mockSessionId() }),
}))

// 真实 import useAppStore, 不 mock — 测试的是 SessionCwdBridge ↔ store 的
// 真实契约. beforeEach 重置 store.
import { useAppStore } from '../store/useAppStore.js'
import { SessionCwdBridge } from './SessionCwdBridge.jsx'

beforeEach(() => {
  mockUseSessionCwd.mockReset()
  mockSessionId.mockReset()
  mockSessionId.mockReturnValue(null)
  useAppStore.setState({
    instanceContext: null,
    jobs: {},
    toasts: [],
    connected: false,
  })
})

describe('SessionCwdBridge', () => {
  it('uses polled session cwd basename when available', async () => {
    useAppStore.getState().setInstanceContext({
      cwd: '/Users/me/proj',
      cwdName: 'proj',
      branch: 'main',
    })
    mockSessionId.mockReturnValue('sess-1')
    mockUseSessionCwd.mockReturnValue('/Users/me/proj/sub/deep')

    render(<SessionCwdBridge />)
    await waitFor(() => {
      expect(useAppStore.getState().instanceContext?.cwdName).toBe('deep')
    })
    // 其他字段必须保留 (这是 bug 的关键: 旧实现把 instanceContext 整个赋成 fn)
    expect(useAppStore.getState().instanceContext?.cwd).toBe('/Users/me/proj')
    expect(useAppStore.getState().instanceContext?.branch).toBe('main')
  })

  it('falls back to existing cwdName when polled cwd undefined', async () => {
    useAppStore.getState().setInstanceContext({
      cwd: '/Users/me/proj',
      cwdName: 'proj',
      branch: 'main',
    })
    mockSessionId.mockReturnValue('sess-2')
    mockUseSessionCwd.mockReturnValue(undefined)  // 404 / polling not started

    render(<SessionCwdBridge />)
    await waitFor(() => {
      expect(useAppStore.getState().instanceContext?.cwdName).toBe('proj')
    })
    expect(useAppStore.getState().instanceContext?.cwd).toBe('/Users/me/proj')
  })

  it('does NOT create a half-baked instanceContext when store is null', async () => {
    // Layout 还没 fetch /api/system 时, instanceContext 是 null. bridge
    // 不应该把 null 替换成 cwdName: '' 的半成品对象 — 留 null 给 Layout 落
    // 地完整数据, 否则 cwd/branch 都是 undefined, 下游还要再覆盖一次.
    expect(useAppStore.getState().instanceContext).toBeNull()
    mockSessionId.mockReturnValue(null)
    mockUseSessionCwd.mockReturnValue(undefined)

    render(<SessionCwdBridge />)
    // 立即检查 — useEffect 同步执行
    await waitFor(() => {
      expect(useAppStore.getState().instanceContext).toBeNull()
    })
  })

  it('does not write function as instanceContext (regression for function-as-value bug)', async () => {
    useAppStore.getState().setInstanceContext({
      cwd: '/Users/me/proj',
      cwdName: 'proj',
      branch: 'main',
    })
    mockSessionId.mockReturnValue('sess-3')
    mockUseSessionCwd.mockReturnValue('/Users/me/proj/sub')

    render(<SessionCwdBridge />)
    await waitFor(() => {
      const ic = useAppStore.getState().instanceContext
      // 关键: instanceContext 必须保持是 plain object, 不能变成函数
      // (旧实现的 setInstanceContext(prev => ...) 把 fn 赋到了 instanceContext)
      expect(typeof ic).toBe('object')
      expect(ic).not.toBeNull()
      expect(ic?.cwdName).toBe('sub')
    })
  })

  it('handles "/" session cwd by falling back to input (matches ConfigStatusBar test)', async () => {
    useAppStore.getState().setInstanceContext({
      cwd: '/',
      cwdName: 'root',
      branch: 'main',
    })
    mockSessionId.mockReturnValue('sess-4')
    mockUseSessionCwd.mockReturnValue('/')

    render(<SessionCwdBridge />)
    await waitFor(() => {
      // "/" → filter(Boolean) → [] → pop → undefined → fallback to "/"
      expect(useAppStore.getState().instanceContext?.cwdName).toBe('/')
    })
  })

  it('does not re-trigger subscribers when name is unchanged', async () => {
    useAppStore.getState().setInstanceContext({
      cwd: '/Users/me/proj',
      cwdName: 'proj',
      branch: 'main',
    })
    mockSessionId.mockReturnValue('sess-5')
    // sessionCwd basename = 'proj', which equals current cwdName — no-op
    mockUseSessionCwd.mockReturnValue('/Users/me/proj')

    const subscriber = vi.fn()
    const unsub = useAppStore.subscribe(subscriber)

    render(<SessionCwdBridge />)
    // Allow microtasks / effects to settle
    await new Promise(r => setTimeout(r, 50))
    unsub()

    // Subscriber should NOT be called with cwdName-related changes.
    // Filter: setState only emits when the returned object differs.
    const cwdNameChanges = subscriber.mock.calls.filter(([s]) => {
      // Subscriber gets full state; we only care about instanceContext updates
      return s?.instanceContext !== undefined
    })
    expect(cwdNameChanges.length).toBe(0)
  })
})