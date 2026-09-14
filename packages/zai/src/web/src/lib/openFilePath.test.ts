// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FILE_PREVIEW_OPEN_EVENT,
  currentSessionCwd,
  openFilePathPreview,
  callFsCommand,
  type FilePreviewOpenDetail,
} from './openFilePath.js'
import { useAgentStore } from '../store/useAgentStore.js'
import { useAppStore } from '../store/useAppStore.js'
import type { FsResolveResult as ServerFsResolveResult } from '../../shared/fs.js'

function withInstanceContext(
  ctx: {
    cwd?: string
    sessions?: { sessionId: string; cwd?: string }[]
    cwdBySession?: Record<string, string>
  },
  run: () => void,
): void {
  const prevInstance = useAppStore.getState().instanceContext
  useAppStore.setState({ instanceContext: { cwd: ctx.cwd ?? '', cwdName: 'repo', branch: null } })
  const prevSessions = useAgentStore.getState().sessions
  const prevCwdBySession = useAgentStore.getState().cwdBySession
  const prevSessionId = useAgentStore.getState().sessionId
  useAgentStore.setState({
    sessions: (ctx.sessions ?? []) as never,
    cwdBySession: ctx.cwdBySession ?? {},
    sessionId: ctx.sessions?.[0]?.sessionId ?? prevSessionId,
  })
  try {
    run()
  } finally {
    useAppStore.setState({ instanceContext: prevInstance })
    useAgentStore.setState({
      sessions: prevSessions,
      cwdBySession: prevCwdBySession,
      sessionId: prevSessionId,
    })
  }
}

function mockResolve(result: ServerFsResolveResult): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

describe('currentSessionCwd', () => {
  it('优先取会话列表里当前 sid 的 cwd', () => {
    withInstanceContext(
      {
        cwd: '/repo',
        sessions: [{ sessionId: 's1', cwd: '/repo/packages/zai' }],
        cwdBySession: { s1: '/tmp' },
      },
      () => {
        expect(currentSessionCwd()).toBe('/repo/packages/zai')
      },
    )
  })

  it('会话列表没值时回落到 cwdBySession', () => {
    withInstanceContext(
      {
        cwd: '/repo',
        cwdBySession: { s1: '/tmp' },
        sessions: [{ sessionId: 's1' }],
      },
      () => {
        expect(currentSessionCwd()).toBe('/tmp')
      },
    )
  })

  it('都没有时回落到 instanceContext.cwd', () => {
    withInstanceContext({ cwd: '/repo' }, () => {
      expect(currentSessionCwd()).toBe('/repo')
    })
  })
})

describe('openFilePathPreview', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    useAgentStore.setState({ filePreviewPath: null })
  })

  it('exact → 派 FILE_PREVIEW_OPEN_EVENT,认领后不写 store', async () => {
    mockResolve({ ok: 'exact', abs: '/repo/src/a.ts' })
    let seen: string | undefined
    const onClaim = (e: Event) => {
      const d = (e as CustomEvent<FilePreviewOpenDetail>).detail
      seen = d.path
      d.handled = true
    }
    window.addEventListener(FILE_PREVIEW_OPEN_EVENT, onClaim)
    try {
      const r = await openFilePathPreview('src/a.ts')
      expect(r.ok).toBe('exact')
    } finally {
      window.removeEventListener(FILE_PREVIEW_OPEN_EVENT, onClaim)
    }
    expect(seen).toBe('/repo/src/a.ts')
    expect(useAgentStore.getState().filePreviewPath).toBeNull()
  })

  it('exact → 无认领时回落 store', async () => {
    mockResolve({ ok: 'exact', abs: '/repo/src/a.ts' })
    await openFilePathPreview('src/a.ts')
    expect(useAgentStore.getState().filePreviewPath).toBe('/repo/src/a.ts')
  })

  it('multiple → 不写 store,把候选返回给 UI', async () => {
    mockResolve({
      ok: 'multiple',
      candidates: [
        { abs: '/repo/p/a/src/x.ts', rel: 'p/a/src/x.ts' },
        { abs: '/repo/p/b/src/x.ts', rel: 'p/b/src/x.ts' },
      ],
    })
    const r = await openFilePathPreview('src/x.ts')
    expect(r.ok).toBe('multiple')
    expect(useAgentStore.getState().filePreviewPath).toBeNull()
  })

  it('ENOENT → 把错误文案返回给 UI', async () => {
    mockResolve({ ok: false, code: 'ENOENT', error: '文件不存在' })
    const r = await openFilePathPreview('nope.ts')
    expect(r.ok).toBe(false)
    expect((r as { ok: false; error: string }).error).toBe('文件不存在')
  })

  it('resolve 调用带上 sessionCwd(优先会话 initCwd),且走 /api 前缀', async () => {
    const spy = mockResolve({ ok: 'exact', abs: '/x/y.ts' })
    withInstanceContext(
      { cwd: '/instance', sessions: [{ sessionId: 's1', cwd: '/session' }] },
      async () => {
        await openFilePathPreview('y.ts')
      },
    )
    const call = spy.mock.calls[0]!
    // 回归:早期写成 /fs/resolve(无 /api 前缀),vite 不代理、请求到不了
    // 服务端,相对路径解析整体失效。必须断言完整 URL。
    expect(call[0]).toBe('/api/fs/resolve')
    const body = JSON.parse(call[1]!.body as string)
    expect(body.sessionCwd).toBe('/session')
  })

  it('网络失败 → 折成 ok:false 的 EIO,不抛异常', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))
    const r = await openFilePathPreview('src/a.ts')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('EIO')
      expect(r.error).toContain('Failed to fetch')
    }
    expect(useAgentStore.getState().filePreviewPath).toBeNull()
  })

  it('HTTP 500 → 折成 ok:false 的 EIO,不抛异常', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('server error', { status: 500 }),
    )
    const r = await openFilePathPreview('src/a.ts')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('HTTP 500')
    expect(useAgentStore.getState().filePreviewPath).toBeNull()
  })
})

describe('callFsCommand', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('先 resolve 再以绝对路径调用 /fs/{cmd}', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: 'exact', abs: '/repo/src/a.ts' }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const r = await callFsCommand('reveal', 'src/a.ts')
    expect(r).toEqual({ ok: true, abs: '/repo/src/a.ts' })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const revealCall = fetchSpy.mock.calls[1]!
    expect(JSON.parse(revealCall[1]!.body as string)).toEqual({ path: '/repo/src/a.ts' })
    expect(revealCall[0]).toBe('/api/fs/reveal')
  })

  it('多匹配时不静默选第一个,直接报错', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: 'multiple',
          candidates: [{ abs: '/a', rel: 'a' }, { abs: '/b', rel: 'b' }],
        }),
        { status: 200 },
      ),
    )
    const r = await callFsCommand('reveal', 'a')
    expect(r).toEqual({ ok: false, error: '存在多个匹配,请先点击预览选择' })
  })
})
