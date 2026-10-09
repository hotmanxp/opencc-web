// zai patch (2026-10-08, P2): vendor 摘要路径的契约测试。
//
// /compact 的默认实现已从「自建 queryModelWithStreaming」切到 vendor
// `compactViaVendor`(compactBridge.ts)。既有测试
// (builtin.compact.test.ts / builtin.compact.disk.test.ts)mock 的是
// queryModelWithStreaming,锁的是**自建**路径,已显式设 ZAI_COMPACT_VENDOR=0
// 退回。本文件覆盖**默认路径**:mock compactViaVendor,验证
//   - 默认走 vendor(ZAI_COMPACT_VENDOR 未设时)
//   - vendor 摘要真的落到 transcript 的 summary 行
//   - vendor 报错时按开关决定「直接报错」还是「降级自建」
//   - 中文约束确实经 customInstructions 传入
//
// vendor 压缩链路的真实行为(hooks / PTL / microcompact)无法在这里驱动 ——
// compactBridge 传递性 import 的 attachments.ts 里有 vite-node 解析不了的
// require(),端到端由真机验证覆盖(规划文档 §7)。

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

const vendorMock = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  result: {
    summary: 'VENDOR SUMMARY',
    preCompactTokenCount: 1000,
    postCompactTokenCount: 100,
    messagesToKeep: [],
    userDisplayMessage: undefined,
  } as Record<string, unknown> | Error,
}))

const storeMock = vi.hoisted(() => ({
  messages: [] as unknown[],
  replaced: null as unknown[] | null,
}))

vi.mock('../../../src/server/services/agentRuntime.js', () => ({
  getTranscriptStore: () => ({
    read: async () => ({ messages: storeMock.messages, meta: {} }),
    replace: async (_sid: string, msgs: unknown[]) => {
      storeMock.replaced = msgs
    },
  }),
  getCurrentSessionId: () => 'sess-vendor-test',
}))

vi.mock('@zn-ai/zn-agent-core', async () => {
  const actual =
    await vi.importActual<typeof import('@zn-ai/zn-agent-core')>(
      '@zn-ai/zn-agent-core',
    )
  return {
    ...actual,
    compactViaVendor: async (args: Record<string, unknown>) => {
      vendorMock.calls.push(args)
      if (vendorMock.result instanceof Error) throw vendorMock.result
      return vendorMock.result
    },
  }
})

function seedMessages(): void {
  const ts = Date.now()
  storeMock.messages = [
    { type: 'user', uuid: 'u1', parentUuid: null, runtime: { turnIndex: 0 }, timestamp: ts, message: { role: 'user', content: '问题一' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', runtime: { turnIndex: 0 }, timestamp: ts + 1, message: { role: 'assistant', content: [{ type: 'text', text: '回答一' }] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a1', runtime: { turnIndex: 1 }, timestamp: ts + 2, message: { role: 'user', content: '问题二' } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u2', runtime: { turnIndex: 1 }, timestamp: ts + 3, message: { role: 'assistant', content: [{ type: 'text', text: '回答二' }] } },
  ]
}

const VENDOR_ENV = 'ZAI_COMPACT_VENDOR'
const FALLBACK_ENV = 'ZAI_COMPACT_FALLBACK'
let prior: Record<string, string | undefined> = {}

beforeEach(() => {
  vi.resetModules()
  prior = {
    [VENDOR_ENV]: process.env[VENDOR_ENV],
    [FALLBACK_ENV]: process.env[FALLBACK_ENV],
  }
  // 默认路径：vendor 开着，fallback 关
  delete process.env[VENDOR_ENV]
  delete process.env[FALLBACK_ENV]

  vendorMock.calls = []
  vendorMock.result = {
    summary: 'VENDOR SUMMARY',
    preCompactTokenCount: 1000,
    postCompactTokenCount: 100,
    messagesToKeep: [],
    userDisplayMessage: undefined,
  }
  storeMock.replaced = null
  seedMessages()
})

afterEach(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

async function runCompact() {
  const { compactCommand } = await import(
    '../../../src/server/services/commands/builtin/compact.js'
  )
  return compactCommand.call('', { cwd: '/tmp/vendor-compact-test' })
}

describe('compactCommand — vendor 摘要路径(默认)', () => {
  it('默认走 compactViaVendor,不再自己发 LLM 请求', async () => {
    const r = await runCompact()
    expect(r.kind).toBe('compacted')
    expect(vendorMock.calls).toHaveLength(1)
  })

  it('vendor 摘要真的写进 transcript 的 summary 行', async () => {
    await runCompact()
    const written = storeMock.replaced as Array<{ type: string; message?: { content?: unknown } }>
    expect(written[1]!.message?.content).toEqual([
      { type: 'text', text: 'VENDOR SUMMARY' },
    ])
  })

  it('中文约束经 customInstructions 传入,保住中文摘要', async () => {
    await runCompact()
    const instructions = vendorMock.calls[0]!.customInstructions as string
    expect(instructions).toContain('中文')
  })

  it('ZAI_COMPACT_VENDOR=0 退回自建路径(不调 compactViaVendor)', async () => {
    process.env[VENDOR_ENV] = '0'
    // 自建路径需要 mock 的 queryModelWithStreaming,这里只断言"没走 vendor"
    const r = await runCompact()
    expect(vendorMock.calls).toHaveLength(0)
    // 自建路径在无 mock 的情况下会因拿不到流而报错 —— 只要不是 compacted 即可
    expect(r.kind).not.toBe('compacted')
  })

  it('vendor 抛错时默认直接报错(不静默降级)', async () => {
    vendorMock.result = new Error('Not enough messages to compact')
    const r = await runCompact()
    expect(r.kind).toBe('error')
    if (r.kind === 'error') {
      // vendor 错误常量被翻译成中文文案
      expect(r.message).toContain('太短')
    }
  })

  it('ZAI_COMPACT_FALLBACK=1 时 vendor 失败可降级到自建', async () => {
    process.env[FALLBACK_ENV] = '1'
    vendorMock.result = new Error('some vendor failure')
    const r = await runCompact()
    // 降级后走自建,拿不到 mock 流 → 报生成摘要失败,而不是 vendor 的原始错误
    expect(r.kind).toBe('error')
    if (r.kind === 'error') {
      expect(r.message).not.toContain('some vendor failure')
    }
  })
})
