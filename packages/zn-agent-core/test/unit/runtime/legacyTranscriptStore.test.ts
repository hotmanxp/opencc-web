/**
 * 回归测试 — picker 选模型必须跨进程重启落盘。
 *
 * 历史(2026-08-15):新会话 sess-1786794727673-mrhzptx9,用户在 picker
 * 选了 deepseek-v4-flash,status bar 显示正确,但实际 HTTP 请求里 model
 * 仍是 MiniMax-M3。根因:legacyTranscriptStore.patchSession 只更新
 * 进程内 Map<string, Meta> REGISTRY,从未 fs.writeFile;read() 在
 * REGISTRY miss 时返回 meta.model='',resolveModel Layer-1 失效,
 * 退回 env.ANTHROPIC_DEFAULT_SONNET_MODEL=MiniMax-M3。
 *
 * 修复:patchSession 在 model/providerId 落盘时 appendEntry 一条
 * {type:'session-meta', model, providerId, ts};read() 在 REGISTRY miss
 * 分支扫 entries 合并最新一条 session-meta → meta。
 *
 * 本测试只覆盖核心契约,与 zn-agent-core 的 transcript 持久化集成测试
 * (openccRuntime-transcript-persist.test.ts)各自独立。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TranscriptStore } from '../../../src/compat/runtime/legacyTranscriptStore.js'

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'legacy-transcript-store-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

/**
 * Mirror legacyTranscriptStore.sanitizePath (internal, not exported) for
 * raw-disk tests that bypass the store's public API. The store's
 * `append()` is a documented no-op (vendor QueryEngine 写盘),所以这里改
 * 用 fs 直接写 JSONL 到预期的 sanitize 路径,模拟"OpenccRuntime 启动
 * 之外的另一段代码"实际落盘 JSONL 的场景。
 */
function sanitizePath(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

function directWriteJsonl(
  dataDir: string,
  cwd: string,
  sessionId: string,
  entries: unknown[],
): void {
  const dir = join(dataDir, 'projects', sanitizePath(cwd))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const fp = join(dir, `${sessionId}.jsonl`)
  const body = entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '')
  writeFileSync(fp, body, { mode: 0o600 })
}

describe('TranscriptStore.patch — model/providerId persistence', () => {
  it('writes a session-meta JSONL line when patching model', async () => {
    const cwd = '/Users/test/proj'
    const sessionId = 'sess-test-model-1'

    // 模拟 OpenccRuntime 提前落盘的对话(bypassing create())。
    directWriteJsonl(dataDir, cwd, sessionId, [
      { type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u-1', timestamp: 1 },
    ])

    const store = new TranscriptStore(dataDir)
    await store.patch(sessionId, { model: 'deepseek-v4-flash' }, { cwd })

    const { messages } = await store.read(sessionId, { cwd })
    const sessionMetas = messages.filter((m: any) => m?.type === 'session-meta')
    expect(sessionMetas).toHaveLength(1)
    expect(sessionMetas[0].model).toBe('deepseek-v4-flash')
    // providerId 没传 → 不应写入(避免 explicit-null bug)
    expect(sessionMetas[0].providerId).toBeUndefined()
    expect(sessionMetas[0].uuid).toMatch(/^[0-9a-f-]{36}$/i)
    expect(typeof sessionMetas[0].timestamp).toBe('number')
  })

  it('writes a session-meta line carrying providerId when patched', async () => {
    // 走 patchSession 的"REGISTRY miss + 文件已存在 → rebuild"路径,
    // 该路径也必须落盘 session-meta(覆盖 REBUILD 分支的 my new 代码)。
    const cwd = '/Users/test/proj'
    const sessionId = 'sess-test-provider-1'

    directWriteJsonl(dataDir, cwd, sessionId, [
      { type: 'user', message: { role: 'user', content: 'x' }, uuid: 'u', timestamp: 1 },
    ])
    const store = new TranscriptStore(dataDir)
    await store.patch(
      sessionId,
      { model: 'deepseek-v4-flash', providerId: 'builtin-openplatform' },
      { cwd },
    )
    const { messages } = await store.read(sessionId, { cwd })
    const sessionMeta = messages.find((m: any) => m?.type === 'session-meta')
    expect(sessionMeta).toBeDefined()
    expect(sessionMeta.model).toBe('deepseek-v4-flash')
    expect(sessionMeta.providerId).toBe('builtin-openplatform')
  })

  it('does not skip the disk write when REGISTRY has the session already', async () => {
    // 走过 create() 的 session: REGISTRY 已注册;patch 应同时落盘。
    const store = new TranscriptStore(dataDir)
    const cwd = '/Users/test/proj'
    const sessionId = await store.create(
      { cwd, model: 'unknown', permissionMode: 'bypassPermissions' },
      { cwd },
    )

    await store.patch(sessionId, { model: 'deepseek-v4-flash' }, { cwd })

    const { messages } = await store.read(sessionId, { cwd })
    const sessionMetas = messages.filter((m: any) => m?.type === 'session-meta')
    expect(sessionMetas.length).toBeGreaterThanOrEqual(1)
    expect(sessionMetas.at(-1).model).toBe('deepseek-v4-flash')
  })

  it('appends a new session-meta line on each patch (latest wins on read)', async () => {
    const cwd = '/Users/test/proj'
    const sessionId = 'sess-test-multi'

    // 预落一段对话,让 patchSession 的 REBUILD 分支命中(file exists)。
    directWriteJsonl(dataDir, cwd, sessionId, [
      { type: 'user', message: { role: 'user', content: 'x' }, uuid: 'u', timestamp: 1 },
    ])

    const store = new TranscriptStore(dataDir)
    await store.patch(sessionId, { model: 'deepseek-v4-flash' }, { cwd })
    await new Promise((r) => setTimeout(r, 5)) // 确保 timestamp 递增
    await store.patch(sessionId, { providerId: 'builtin-openplatform' }, { cwd })
    await new Promise((r) => setTimeout(r, 5))
    await store.patch(sessionId, { model: 'MiniMax-M3' }, { cwd })

    const { messages } = await store.read(sessionId, { cwd })
    const sessionMetas = messages.filter((m: any) => m?.type === 'session-meta')
    expect(sessionMetas).toHaveLength(3)
    expect(sessionMetas.at(-1).model).toBe('MiniMax-M3')
  })

  it('does not write session-meta when patch does not touch model/providerId', async () => {
    const cwd = '/Users/test/proj'
    const sessionId = 'sess-test-untouched'
    directWriteJsonl(dataDir, cwd, sessionId, [
      { type: 'user', message: { role: 'user', content: 'x' }, uuid: 'u', timestamp: 1 },
    ])
    const store = new TranscriptStore(dataDir)
    await store.patch(sessionId, { permissionMode: 'plan' }, { cwd })

    const { messages } = await store.read(sessionId, { cwd })
    expect(messages.filter((m: any) => m?.type === 'session-meta')).toHaveLength(0)
  })

  it('throws when patching an unregistered session without cwd (legacy contract)', async () => {
    // patch() 在找不到 REGISTRY 且无 cwd 时无法 rebuild,会抛错 —
    // 这是 routes/agent.ts 早先引入的契约(opencc-runtime 的 session 都
    // 带 cwd)。这里锁定行为,避免后续误改把 no-cwd 路径默默清空数据。
    const store = new TranscriptStore(dataDir)
    await expect(
      store.patch('sess-no-cwd-unregistered', { model: 'deepseek-v4-flash' }),
    ).rejects.toThrow(/TranscriptStore.patch: session not found/)
  })
})

describe('TranscriptStore.read — model/providerId rebuild from disk', () => {
  it('returns persisted model when REGISTRY is empty (post-restart scenario)', async () => {
    // 模拟"server 重启后,REGISTRY 空,但 JSONL 还在"。store.append()
    // 是 no-op(注释明确:vendor QueryEngine 写盘),所以这里直接 fs 写
    // JSONL 落盘。read() 路径: REGISTRY miss → readEntries 读盘 → 找到
    // session-meta → findLatestSessionMeta 返回 model/providerId。
    const cwd = '/Users/test/rebuild'
    const sessionId = 'sess-restart-rebuild'

    directWriteJsonl(dataDir, cwd, sessionId, [
      { type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u1', timestamp: 1 },
      { type: 'assistant', message: { role: 'assistant', content: [], model: 'MiniMax-M3' }, uuid: 'a1', timestamp: 2 },
      {
        type: 'session-meta',
        model: 'deepseek-v4-flash',
        providerId: 'builtin-openplatform',
        uuid: 'm1',
        timestamp: 3,
      },
    ])

    const reader = new TranscriptStore(dataDir)
    const { messages, meta } = await reader.read(sessionId, { cwd })

    expect(meta.model).toBe('deepseek-v4-flash')
    expect(meta.providerId).toBe('builtin-openplatform')
    expect(meta.sessionId).toBe(sessionId)
    expect(messages.some((m: any) => m?.type === 'session-meta')).toBe(true)
  })

  it('picks the latest session-meta entry when multiple exist', async () => {
    // 直接 fs 写盘 → REGISTRY miss 必中 → fallback 必走。
    const cwd = '/Users/test/latest'
    const sessionId = 'sess-latest-wins'

    directWriteJsonl(dataDir, cwd, sessionId, [
      { type: 'session-meta', model: 'm1', uuid: 'm1', timestamp: 1 },
      { type: 'session-meta', model: 'm2', providerId: 'p2', uuid: 'm2', timestamp: 2 },
      { type: 'session-meta', model: 'm3', uuid: 'm3', timestamp: 3 },
    ])

    const reader = new TranscriptStore(dataDir)
    const { messages, meta } = await reader.read(sessionId, { cwd })

    expect(meta.model).toBe('m3')
    // zai patch (2026-08-15): findLatestSessionMeta now walks past the
    // tail entry to pick up the LATEST providerId on its own axis —
    // before this fix, the read returned `{providerId: 'p2'}` only when
    // the last entry happened to carry model, and dropped model when
    // the last entry was {providerId}-only (see live case
    // sess-1786796310223-jiccyott). Here the latest model is m3, the
    // latest providerId is p2 — both axes independent.
    expect(meta.providerId).toBe('p2')

    const metas = messages.filter((m: any) => m?.type === 'session-meta')
    expect(metas).toHaveLength(3)
    // verify ordering: timestamps 递增
    const ts = metas.map((m: any) => m.timestamp)
    expect(ts[1]).toBeGreaterThan(ts[0])
    expect(ts[2]).toBeGreaterThan(ts[1])
  })

  it('preserves model when the tail session-meta only carries providerId (picker paired write)', async () => {
    // Live regression: sess-1786796310223-jiccyott's JSONL ended with
    //   …, {model: deepseek-v4-flash}, {providerId: provider_178679…}
    // patchSession writes the model entry first, then the providerId
    // entry (see agent.ts:1556 / 1564 — two separate store.patch calls
    // per PATCH). Before this fix, findLatestSessionMeta returned at
    // the {providerId} entry from the tail and dropped model; read()
    // then handed resolveModel an empty sessionModel, which fell
    // through to ANTHROPIC_DEFAULT_SONNET_MODEL / MiniMax-M3. The
    // picker said deepseek, the LLM was MiniMax-M3.
    const cwd = '/Users/test/pair'
    const sessionId = 'sess-paired-pick'

    directWriteJsonl(dataDir, cwd, sessionId, [
      { type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u1', timestamp: 1 },
      { type: 'session-meta', model: 'deepseek-v4-flash', uuid: 'm1', timestamp: 2 },
      { type: 'session-meta', providerId: 'provider_1786794063253', uuid: 'p1', timestamp: 3 },
    ])

    const reader = new TranscriptStore(dataDir)
    const { meta } = await reader.read(sessionId, { cwd })
    expect(meta.model).toBe('deepseek-v4-flash')
    expect(meta.providerId).toBe('provider_1786794063253')
  })

  it('returns empty model when no session-meta entry exists yet', async () => {
    // 只写对话,没写 session-meta。
    const cwd = '/Users/test/empty'
    const sessionId = 'sess-no-meta'
    directWriteJsonl(dataDir, cwd, sessionId, [
      { type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u', timestamp: 1 },
    ])
    const reader = new TranscriptStore(dataDir)
    const { meta } = await reader.read(sessionId, { cwd })
    expect(meta.model).toBe('')
    expect(meta.providerId).toBeUndefined()
  })

  it('tolerates malformed session-meta lines without crashing', async () => {
    const cwd = '/Users/test/robust'
    const sessionId = 'sess-robust'
    // 故意写 model:'foo' 的有效 session-meta,再写 model:42(非字符串)
    // 的坏行,再写 model:'bar' 的有效 session-meta。
    directWriteJsonl(dataDir, cwd, sessionId, [
      { type: 'session-meta', model: 'foo', uuid: 'g', timestamp: 1 },
      { type: 'session-meta', model: 42, uuid: 'b', timestamp: 2 }, // 非字符串坏行
      { type: 'session-meta', model: 'bar', uuid: 'g2', timestamp: 3 },
    ])
    const reader = new TranscriptStore(dataDir)
    const { meta } = await reader.read(sessionId, { cwd })
    expect(meta.model).toBe('bar')
  })
})

describe('TranscriptStore.list — model/providerId rebuild from disk', () => {
  it('returns persisted model when REGISTRY is empty (sidebar after restart)', async () => {
    // Sidebar uses /api/agent/sessions → store.list(). Before this fix
    // list() only looked at REGISTRY, so a fresh process (or a hot
    // reload that wiped REGISTRY) showed every restored session with
    // model='unknown'. useConversationInfo then fell through to
    // runtime.defaultModel = MiniMax-M3, and the picker rendered the
    // wrong "current model" — the user clicked deepseek again only to
    // re-write the same session-meta entries that already existed on
    // disk. Now list() reads the latest session-meta off the JSONL
    // exactly like read() does.
    const cwd = '/Users/test/list-rebuild'
    const sessionId = 'sess-list-restart'

    directWriteJsonl(dataDir, cwd, sessionId, [
      { type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u1', timestamp: 1 },
      {
        type: 'session-meta',
        model: 'deepseek-v4-flash',
        providerId: 'provider_1786794063253',
        uuid: 'm1',
        timestamp: 2,
      },
    ])

    const reader = new TranscriptStore(dataDir)
    const sessions = await reader.list({ cwd })
    const target = sessions.find((s) => s.sessionId === sessionId)
    expect(target).toBeDefined()
    expect(target?.model).toBe('deepseek-v4-flash')
    expect(target?.providerId).toBe('provider_1786794063253')
  })

  it('list() handles paired {model}/{providerId} tail entries (picker paired write)', async () => {
    // Mirrors the live sess-1786796310223-jiccyott case where the JSONL
    // tail is {model} then {providerId} (two session-meta lines from
    // the same PATCH). list() must NOT return model='unknown' just
    // because the very last session-meta lacks `model`.
    const cwd = '/Users/test/list-pair'
    const sessionId = 'sess-list-pair'

    directWriteJsonl(dataDir, cwd, sessionId, [
      { type: 'session-meta', model: 'deepseek-v4-flash', uuid: 'm1', timestamp: 1 },
      { type: 'session-meta', providerId: 'provider_1786794063253', uuid: 'p1', timestamp: 2 },
    ])

    const reader = new TranscriptStore(dataDir)
    const sessions = await reader.list({ cwd })
    const target = sessions.find((s) => s.sessionId === sessionId)
    expect(target?.model).toBe('deepseek-v4-flash')
    expect(target?.providerId).toBe('provider_1786794063253')
  })

  it('list() returns model="unknown" only when no session-meta exists at all', async () => {
    // True "user never picked a model" case — no session-meta on disk.
    // Distinguishes this from the REGISTRY-miss-but-disk-has-meta case
    // above so we don't accidentally hide un-picked sessions.
    const cwd = '/Users/test/list-empty'
    const sessionId = 'sess-list-empty'

    directWriteJsonl(dataDir, cwd, sessionId, [
      { type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u', timestamp: 1 },
    ])

    const reader = new TranscriptStore(dataDir)
    const sessions = await reader.list({ cwd })
    const target = sessions.find((s) => s.sessionId === sessionId)
    expect(target?.model).toBe('unknown')
    expect(target?.providerId).toBeUndefined()
  })

  it('REGISTRY model wins over disk session-meta (in-memory state is authoritative mid-session)', async () => {
    // REGISTRY is the live source of truth while the session is in
    // memory; disk is only the cold-start fallback. If REGISTRY says
    // model=X but disk has model=Y (e.g. user just patched and the
    // disk write hasn't settled), list() must surface X so the picker
    // doesn't briefly flicker to Y.
    const cwd = '/Users/test/list-registry-wins'
    const sessionId = await new TranscriptStore(dataDir).create(
      { cwd, model: 'live-model', permissionMode: 'bypassPermissions' },
      { cwd },
    )
    directWriteJsonl(dataDir, cwd, sessionId, [
      { type: 'session-meta', model: 'stale-on-disk', uuid: 'm', timestamp: 1 },
    ])

    const store = new TranscriptStore(dataDir)
    const sessions = await store.list({ cwd })
    const target = sessions.find((s) => s.sessionId === sessionId)
    expect(target?.model).toBe('live-model')
  })
})
