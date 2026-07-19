import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('log-event', () => {
  let dataDir: string
  let originalEnv: string | undefined

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'zai-log-test-'))
    originalEnv = process.env.ZAI_DATA_DIR
    process.env.ZAI_DATA_DIR = dataDir
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ZAI_DATA_DIR
    else process.env.ZAI_DATA_DIR = originalEnv
    if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true })
  })

  test('logEvent 写入 JSONL 到 ~/.zai/logs/compact.jsonl', async () => {
    const { logEvent } = await import('../../../src/runtime/compact/log-event.js')
    logEvent('z auto_compact_succeeded', {
      ts: 1752921600000,
      sessionId: 'sess-1',
      trigger: 'auto',
      model: 'MiniMax-M3',
      preCompactTokens: 100000,
      postCompactTokens: 50000,
      savedTokens: 50000,
      circuitBreakerState: 'closed',
      consecutiveFailures: 0,
      durationMs: 1200,
      error: null,
    })
    const logPath = join(dataDir, 'logs', 'compact.jsonl')
    expect(existsSync(logPath)).toBe(true)
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n')
    expect(lines.length).toBe(1)
    const entry = JSON.parse(lines[0]!)
    expect(entry.sessionId).toBe('sess-1')
    expect(entry.trigger).toBe('auto')
    expect(entry.savedTokens).toBe(50000)
  })

  test('readCompactLog 按 sessionId 过滤', async () => {
    const { logEvent, readCompactLog } = await import('../../../src/runtime/compact/log-event.js')
    logEvent('z auto_compact_succeeded', { ts: 1, sessionId: 'sess-A', trigger: 'auto', model: 'm', circuitBreakerState: 'closed', consecutiveFailures: 0, durationMs: 0, error: null })
    logEvent('z auto_compact_failed',    { ts: 2, sessionId: 'sess-B', trigger: 'auto', model: 'm', circuitBreakerState: 'closed', consecutiveFailures: 1, durationMs: 100, error: 'TIMEOUT' })
    const aOnly = readCompactLog('sess-A')
    expect(aOnly.length).toBe(1)
    expect(aOnly[0]!.sessionId).toBe('sess-A')
  })

  test('readCompactLog 不传 sessionId 返回全部', async () => {
    const { logEvent, readCompactLog } = await import('../../../src/runtime/compact/log-event.js')
    logEvent('z auto_compact_succeeded', { ts: 1, sessionId: 'sess-A', trigger: 'auto', model: 'm', circuitBreakerState: 'closed', consecutiveFailures: 0, durationMs: 0, error: null })
    logEvent('z auto_compact_succeeded', { ts: 2, sessionId: 'sess-B', trigger: 'manual', model: 'm', circuitBreakerState: 'closed', consecutiveFailures: 0, durationMs: 0, error: null })
    const all = readCompactLog()
    expect(all.length).toBe(2)
  })
})
