/**
 * 本地 JSONL 日志 + logEvent 模拟。
 *
 * - 写入路径:{ZAI_DATA_DIR|~/.zai}/logs/compact.jsonl
 * - 每次调用追加一行 JSON(无外部依赖,无锁)
 * - readCompactLog 用于本地调试 / 集成测试
 *
 * 后续接入 Statsig / OpenTelemetry 时,只需替换 logEvent 实现,
 * 调用方零改动。
 */

import { appendFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import type { CompactTrigger } from './types.js'

export interface CompactLogEntry {
  ts: number
  sessionId: string
  trigger: CompactTrigger
  model: string
  preCompactTokens?: number
  postCompactTokens?: number
  savedTokens?: number
  circuitBreakerState: 'closed' | 'half-open' | 'open'
  consecutiveFailures: number
  durationMs: number
  error: string | null
}

function dataDir(): string {
  return process.env.ZAI_DATA_DIR ?? join(homedir(), '.zai')
}

function logPath(): string {
  return join(dataDir(), 'logs', 'compact.jsonl')
}

export function logEvent(eventName: string, metadata: CompactLogEntry): void {
  // eventName 当前未使用(Statsig 时会上报),保留签名兼容
  void eventName
  const path = logPath()
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true })
  }
  appendFileSync(path, JSON.stringify(metadata) + '\n', 'utf-8')
}

export function readCompactLog(sessionId?: string): CompactLogEntry[] {
  const path = logPath()
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean)
  const entries: CompactLogEntry[] = []
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as CompactLogEntry
      if (!sessionId || entry.sessionId === sessionId) {
        entries.push(entry)
      }
    } catch {
      // skip corrupt line
    }
  }
  return entries
}
