// 真实磁盘集成测试: 与 builtin.compact.test.ts 的 mock harness 不同,
// 这里使用真实 TranscriptStore 实例(写入 tmpdir 真实 JSONL 文件),
// 验证 compactCommand 修复后真的把整文件重写为 [boundary, summary,
// ...last 2 user/assistant],磁盘行数从 N 降到 4。
//
// 这是单测之外的"准真实验收" — 浏览器层验收因 zai dev SSE 长连接
// 阻塞 ego-browser 无法做;dev 实例在调 queryModelWithStreaming 真实
// LLM 时也会 crash。最现实的"端到端 + 磁盘可见"验证就是本测试。

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { TranscriptStore } from '@zn-ai/zn-agent-core'

const queryMock = vi.hoisted(() => ({
  events: [
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'REAL DISK SUMMARY' },
      },
    },
    { type: 'message_stop' },
  ] as unknown[],
}))

let tmpDir: string
let realStore: TranscriptStore
let jsonlPath: string

beforeEach(async () => {
  vi.resetModules()
  queryMock.events = [
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'REAL DISK SUMMARY' },
      },
    },
    { type: 'message_stop' },
  ]
  tmpDir = await mkdtemp(join(tmpdir(), 'zai-compact-disk-'))
  realStore = new TranscriptStore(tmpDir)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

vi.mock('../../../src/server/services/agentRuntime.js', () => ({
  getTranscriptStore: () => realStore,
  getCurrentSessionId: () => null,
  getRuntime: () => ({ config: {} }),
  abortAgentSession: () => Promise.resolve(),
}))

vi.mock('@zn-ai/zn-agent-core', async () => {
  const actual = await vi.importActual<typeof import('@zn-ai/zn-agent-core')>(
    '@zn-ai/zn-agent-core',
  )
  return {
    ...actual,
    queryModelWithStreaming: () => ({
      [Symbol.asyncIterator]() {
        let i = 0
        return {
          next: () => {
            if (i >= queryMock.events.length) {
              return Promise.resolve({ value: undefined, done: true as const })
            }
            return Promise.resolve({
              value: queryMock.events[i++],
              done: false as const,
            })
          },
        }
      },
    }),
  }
})

function transcriptPath(sid: string, cwd: string): string {
  // 与 legacyTranscriptStore.sanitizePath 保持一致
  const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  return join(tmpDir, 'projects', sanitized, `${sid}.jsonl`)
}

function seedTranscript(sid: string, cwd: string): void {
  // 直接写 5 条 JSONL 行 — 绕过 TranscriptStore.append (no-op),
  // 模拟已存在的 user/assistant 对话。
  const ts = Date.now()
  const entries = [
    { type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false, message: { role: 'user', content: 'hi' }, timestamp: new Date(ts).toISOString(), userType: 'external', cwd, sessionId: sid, version: '2', runtime: { turnIndex: 0 } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'first reply' }] }, timestamp: new Date(ts + 1).toISOString(), userType: 'external', cwd, sessionId: sid, version: '2', runtime: { turnIndex: 0 } },
    { type: 'user', uuid: 'u2', parentUuid: 'a1', isSidechain: false, message: { role: 'user', content: 'second user' }, timestamp: new Date(ts + 2).toISOString(), userType: 'external', cwd, sessionId: sid, version: '2', runtime: { turnIndex: 1 } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u2', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'second reply' }] }, timestamp: new Date(ts + 3).toISOString(), userType: 'external', cwd, sessionId: sid, version: '2', runtime: { turnIndex: 1 } },
    { type: 'user', uuid: 'u3', parentUuid: 'a2', isSidechain: false, message: { role: 'user', content: 'third user (most recent)' }, timestamp: new Date(ts + 4).toISOString(), userType: 'external', cwd, sessionId: sid, version: '2', runtime: { turnIndex: 2 } },
  ]
  // 同步写盘(种子数据,不走 compact 路径)
  const { writeFileSync, mkdirSync } = require('node:fs') as typeof import('node:fs')
  const p = transcriptPath(sid, cwd)
  mkdirSync(join(p, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 })
}

describe('compactCommand — real disk integration', () => {
  it('整文件重写 JSONL: 5 行 → 4 行 (boundary + summary + last 2 user/assistant)', async () => {
    const sid = 'disk-sess-1'
    const cwd = '/Users/ethan/code/opencc-web/packages/zai'
    jsonlPath = transcriptPath(sid, cwd)
    seedTranscript(sid, cwd)

    // before: 5 行原始
    const before = await readFile(jsonlPath, 'utf8')
    expect(before.split('\n').filter(Boolean)).toHaveLength(5)

    const { compactCommand } = await import(
      '../../../src/server/services/commands/builtin/compact.js'
    )
    const result = await compactCommand.call('', {
      cwd,
      dataDir: tmpDir,
      sessionId: sid,
    })

    expect(result.kind).toBe('compacted')
    if (result.kind !== 'compacted') return
    expect(result.summary).toBe('REAL DISK SUMMARY')
    // 5 原始 - 保留 2 条 (a2 + u3) = 3 移除
    expect(result.removedMessages).toBe(3)

    // after: 磁盘 JSONL 行数真的从 5 降到 4
    const after = await readFile(jsonlPath, 'utf8')
    const lines = after.split('\n').filter(Boolean)
    expect(lines).toHaveLength(4)

    // 顺序: [boundary, summary, a2, u3]
    const parsed = lines.map((l) => JSON.parse(l) as { type: string; uuid?: string; message?: { content?: unknown } })
    expect(parsed.map((m) => m.type)).toEqual([
      'compact_boundary',
      'assistant', // summary
      'assistant', // a2 — 倒数第二条 user/assistant
      'user',      // u3 — 最后一条 user/assistant
    ])
    expect(parsed[0]!.uuid).toBeTruthy() // boundary 有 uuid
    // boundary.parentUuid 必须指向压缩后真正最后一条 = keptRecent 最后一条 = u3
    expect(parsed[0]!.parentUuid).toBe(parsed[3]!.uuid)
    // summary 文本真的来自 queryModel mock
    expect(JSON.stringify(parsed[1]!.message?.content)).toContain('REAL DISK SUMMARY')
    // 保留段必须含原始 user/assistant 文本(不是空字符串)
    expect(JSON.stringify(parsed[3]!.message?.content)).toContain('third user (most recent)')
  })

  it('连续两次 /compact: 第二次在已压缩 transcript 上,只剩 boundary/summary', async () => {
    const sid = 'disk-sess-2'
    const cwd = '/Users/ethan/code/opencc-web/packages/zai'
    jsonlPath = transcriptPath(sid, cwd)
    seedTranscript(sid, cwd)

    const { compactCommand } = await import(
      '../../../src/server/services/commands/builtin/compact.js'
    )

    // 第一次压缩: 5 → 4
    const r1 = await compactCommand.call('', { cwd, dataDir: tmpDir, sessionId: sid })
    expect(r1.kind).toBe('compacted')
    if (r1.kind !== 'compacted') return

    const after1 = await readFile(jsonlPath, 'utf8')
    expect(after1.split('\n').filter(Boolean)).toHaveLength(4)

    // 第二次压缩: 4 → 4 (boundary + summary + 2 保留段全部留下,移除 0 条)
    const r2 = await compactCommand.call('', { cwd, dataDir: tmpDir, sessionId: sid })
    expect(r2.kind).toBe('compacted')
    if (r2.kind !== 'compacted') return
    expect(r2.removedMessages).toBe(2) // 4 原始 - 保留 2 = 2 移除 (boundary 和 summary 不算 user/assistant,被替换)

    const after2 = await readFile(jsonlPath, 'utf8')
    const lines2 = after2.split('\n').filter(Boolean)
    expect(lines2).toHaveLength(4)
    const parsed2 = lines2.map((l) => JSON.parse(l) as { type: string })
    expect(parsed2[0]!.type).toBe('compact_boundary')
    expect(parsed2[1]!.type).toBe('assistant')
  })
})