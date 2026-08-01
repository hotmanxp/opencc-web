import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { appendRestartLog, restartLogPath } from '../../src/cli/restartLog.js'

let dataDir: string
let savedDataDir: string | undefined

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'zai-restartlog-'))
  savedDataDir = process.env.ZAI_DATA_DIR
})
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  if (savedDataDir === undefined) {
    delete process.env.ZAI_DATA_DIR
  } else {
    process.env.ZAI_DATA_DIR = savedDataDir
  }
})

async function readLines(file: string): Promise<unknown[]> {
  const raw = await readFile(file, 'utf-8')
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as unknown)
}

describe('appendRestartLog', () => {
  it('writes one line that parses back to the original event shape', async () => {
    await appendRestartLog(
      { type: 'restart_requested', childPid: 4242, reason: 'user_action' },
      dataDir,
    )
    const lines = await readLines(restartLogPath(dataDir))
    expect(lines).toHaveLength(1)
    const entry = lines[0] as Record<string, unknown>
    expect(entry.type).toBe('restart_requested')
    expect(entry.childPid).toBe(4242)
    expect(entry.reason).toBe('user_action')
    expect(typeof entry.at).toBe('string')
    // at must be a valid ISO timestamp
    expect(() => new Date(entry.at as string).toISOString()).not.toThrow()
  })

  it('appends multiple lines, each parsing as an independent JSON object', async () => {
    await appendRestartLog(
      { type: 'restart_requested', childPid: 1, reason: 'user_action' },
      dataDir,
    )
    await appendRestartLog(
      { type: 'ready_timeout', childPid: 1 },
      dataDir,
    )
    await appendRestartLog(
      { type: 'restart_executed', childPid: 2, durationMs: 1500, reason: 'auto_recovery' },
      dataDir,
    )
    await appendRestartLog(
      { type: 'failed', childPid: 2, durationMs: 2000, reason: 'ready_timeout' },
      dataDir,
    )
    const lines = await readLines(restartLogPath(dataDir))
    expect(lines).toHaveLength(4)
    expect((lines[0] as Record<string, unknown>).type).toBe('restart_requested')
    expect((lines[1] as Record<string, unknown>).type).toBe('ready_timeout')
    expect((lines[2] as Record<string, unknown>).type).toBe('restart_executed')
    expect((lines[2] as Record<string, unknown>).durationMs).toBe(1500)
    expect((lines[3] as Record<string, unknown>).type).toBe('failed')
    expect((lines[3] as Record<string, unknown>).durationMs).toBe(2000)
    // every line has at
    for (const l of lines) {
      expect(typeof (l as Record<string, unknown>).at).toBe('string')
    }
  })

  it('uses ZAI_DATA_DIR override when no explicit dataDir is passed', async () => {
    process.env.ZAI_DATA_DIR = dataDir
    await appendRestartLog({ type: 'restart_requested', childPid: 7, reason: 'update' })
    const lines = await readLines(restartLogPath(dataDir))
    expect(lines).toHaveLength(1)
    const entry = lines[0] as Record<string, unknown>
    expect(entry.childPid).toBe(7)
    expect(entry.reason).toBe('update')
  })
})