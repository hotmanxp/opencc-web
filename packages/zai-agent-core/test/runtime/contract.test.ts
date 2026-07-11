import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { DefaultAgentRuntime } from '../../src/runtime/contract.js'
import { makeMockModelCaller } from '../fixtures/MockModelCaller.js'

let tmpDir: string
let runtime: DefaultAgentRuntime

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zai-contract-test-'))
  runtime = new DefaultAgentRuntime({
    dataDir: tmpDir,
    modelCaller: makeMockModelCaller('text-only'),
  })
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('DefaultAgentRuntime', () => {
  test('run returns events ending with runtime.done', async () => {
    const events: any[] = []
    for await (const e of runtime.run({ prompt: 'hi', cwd: '/test' })) {
      events.push(e)
    }
    expect(events[events.length - 1].type).toBe('runtime.done')
  })

  test('listSessions after run', async () => {
    for await (const _ of runtime.run({ prompt: 'hi', cwd: '/test' })) { /* drain */ }
    const sessions = await runtime.listSessions()
    expect(sessions.length).toBeGreaterThanOrEqual(1)
  })

  test('readSession returns transcript', async () => {
    let sessionId = ''
    for await (const e of runtime.run({ prompt: 'hi', cwd: '/test' })) {
      if (!sessionId) sessionId = e.sessionId
    }
    const file = await runtime.readSession(sessionId)
    expect(file.transcriptId).toBe(sessionId)
  })
})
