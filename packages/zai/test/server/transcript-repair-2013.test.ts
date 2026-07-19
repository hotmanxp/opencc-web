import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DefaultAgentRuntime as CoreDefaultAgentRuntime } from '../../../zai-agent-core/src/runtime/contract.js'
import type { ModelCaller } from '../../../zai-agent-core/src/runtime/types.js'
import {
  appendAssistantMessageV2,
  appendToolResult,
  appendToolUse,
  appendUserMessageV2,
} from '../../../zai-agent-core/src/transcript/persistence.js'
import { TranscriptStore as CoreTranscriptStore } from '../../../zai-agent-core/src/transcript/store.js'
import agentRouter from '../../src/server/routes/agent.js'
import { eventBus } from '../../src/server/services/eventBus.js'
import type { ServerEvent } from '../../src/shared/events.js'

type CollectableEvent = ServerEvent

let dataDir: string

const slots = vi.hoisted(() => ({
  runtime: { current: null as CoreDefaultAgentRuntime | null },
  store: { current: null as CoreTranscriptStore | null },
}))

const caller: ModelCaller = async function* (request) {
  const assistantIndex = request.messages.findIndex(message => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return false
    return message.content.some(block => {
      if (typeof block !== 'object' || block === null) return false
      const value = block as { type?: string; id?: string }
      return value.type === 'tool_use' && value.id === 'call-server-2013'
    })
  })
  const result = request.messages[assistantIndex + 1]
  const valid = assistantIndex >= 0
    && result?.role === 'user'
    && Array.isArray(result.content)
    && result.content.some(block => {
      if (typeof block !== 'object' || block === null) return false
      const value = block as { type?: string; tool_use_id?: string }
      return value.type === 'tool_result' && value.tool_use_id === 'call-server-2013'
    })
  if (!valid) throw new Error('Anthropic 400 error 2013: tool call result does not follow tool call')

  yield { type: 'message_start', message: { id: 'm-server-2013' } }
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }
  yield { type: 'message_stop' }
}

vi.mock('../../src/server/services/agentRuntime.js', () => ({
  getRuntime: () => slots.runtime.current,
  getTranscriptStore: () => slots.store.current,
  getAskRegistry: () => ({ abortAll: () => {} }),
  getCurrentSessionId: () => null,
  setCurrentSessionId: () => {},
  abortAgentSession: async () => {},
  listSkills: async () => [],
}))

const startApp = (): Promise<{ url: string; close: () => Promise<void> }> =>
  new Promise(resolve => {
    const app = express()
    app.use(express.json())
    app.locals.instanceContext = { cwd: dataDir, cwdName: 'repair-server-test' }
    app.use('/api', agentRouter)
    const server = http.createServer(app).listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('server did not bind a TCP port')
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((done, reject) => {
          server.close(error => error ? reject(error) : done())
        }),
      })
    })
  })

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'zai-server-repair-2013-'))
  slots.store.current = new CoreTranscriptStore(dataDir)
  slots.runtime.current = new CoreDefaultAgentRuntime({ dataDir, modelCaller: caller, skillsDirs: [] })
})

afterEach(async () => {
  slots.runtime.current = null
  slots.store.current = null
  await rm(dataDir, { recursive: true, force: true })
})

describe('server transcript tool-pair repair', () => {
  it('resumes an out-of-order fixture through /api/agent/prompt without 400/2013', async () => {
    const app = await startApp()
    const events: CollectableEvent[] = []
    const off = eventBus.subscribe(event => events.push(event as CollectableEvent))
    try {
      const fixtureStore = slots.store.current!
      const createResponse = await fetch(`${app.url}/api/agent/sessions`, { method: 'POST' })
      expect(createResponse.status).toBe(200)
      const created = await createResponse.json() as { sessionId: string }
      const sessionId = created.sessionId
      const userUuid = await appendUserMessageV2(
        fixtureStore, sessionId, 'run it', 0, null, { cwd: dataDir, sessionId },
      )
      const assistantUuid = await appendAssistantMessageV2(
        fixtureStore,
        sessionId,
        [{ type: 'text', text: 'running' }],
        0,
        userUuid ?? null,
        { cwd: dataDir, sessionId },
      )
      const toolUuid = await appendToolUse(
        fixtureStore,
        sessionId,
        { id: 'call-server-2013', name: 'Bash', input: {} },
        0,
        assistantUuid ?? null,
        dataDir,
      )
      await appendUserMessageV2(
        fixtureStore, sessionId, 'next prompt', 1, assistantUuid ?? null, { cwd: dataDir, sessionId },
      )
      await appendToolResult(
        fixtureStore,
        sessionId,
        { tool_use_id: 'call-server-2013', content: 'done', is_error: false },
        0,
        toolUuid ?? null,
        dataDir,
      )

      const promptResponse = await fetch(`${app.url}/api/agent/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'resume', sessionId }),
      })
      expect(promptResponse.status).toBe(200)

      await vi.waitFor(() => {
        expect(events.some(event => event.type === 'runtime.done' && event.sessionId === sessionId)).toBe(true)
      }, { timeout: 10_000 })
      const errors = events.filter(event => event.type === 'runtime.error' && event.sessionId === sessionId)
      expect(errors.some((event: CollectableEvent) => {
        const message = (event as unknown as { error?: { message?: string } }).error?.message ?? ''
        return /(?:400|2013)/.test(message)
      })).toBe(false)
    } finally {
      off()
      await app.close()
    }
  })
})
