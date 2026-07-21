import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import http from 'node:http'

// Capture controller registered by /agent/prompt
let capturedController: AbortController | null = null
let lastRunOpts: any = null
let activeSessionId: string | null = null

vi.mock('../../src/server/services/agentRuntime.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/server/services/agentRuntime.js')>(
    '../../src/server/services/agentRuntime.js',
  )
  return {
    ...actual,
    initAgentRuntime: () => {},
    getRuntime: () => ({
      run: (opts: any) => {
        lastRunOpts = opts
        // Return an async generator that just yields one event then awaits
        // (so the route handler's `for await` is active when abort fires).
        return (async function* () {
          yield { type: 'message_start' }
          // Hold the loop open without yielding message_stop until aborted.
          await new Promise<void>((resolve) => {
            const check = () => {
              if (opts.abortSignal?.aborted) resolve()
              else setTimeout(check, 5)
            }
            check()
          })
        })()
      },
      abort: async () => {},
      listSessions: async () => [],
      readSession: async () => ({ version: 1, transcriptId: 'sess-1', meta: {} as any, messages: [] }),
      patchSession: async () => {},
      removeSession: async () => {},
    }),
    getTranscriptStore: () => ({
      list: async () => [],
      read: async () => ({ version: 1, transcriptId: 'sess-1', meta: { cwd: '/tmp', model: 'unknown', createdAt: 0, updatedAt: 0 }, messages: [] }),
      patch: async () => {},
      remove: async () => {},
      append: async () => {},
    }),
    getAskRegistry: () => ({ abortAll: () => {} }),
    setCurrentSessionId: (id: string) => { activeSessionId = id },
    getCurrentSessionId: () => activeSessionId,
    // 关键: 这个 mock 必须调用 actual.registerSessionController(...) 让真实
    // sessionControllers map 被填充. 否则 abort route 永远找不到 in-flight
    // controller. Pre-flight review 标记为 non-negotiable.
    registerSessionController: (sid: string, c: AbortController) => {
      capturedController = c
      actual.registerSessionController(sid, c)
    },
    releaseSessionController: () => {},
    abortSessionController: actual.abortSessionController,
    abortAgentSession: async () => {},
  }
})

vi.mock('@zn-ai/zai-agent-core', () => ({
  EXTERNAL_PERMISSION_MODES: ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk'],
}))

import agentRouter from '../../src/server/routes/agent.js'

function startApp() {
  const app = express()
  app.use(express.json())
  app.locals.instanceContext = { cwd: '/tmp', cwdName: 'abort-test' }
  app.use('/api', agentRouter)
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    const server = http.createServer(app).listen(0, () => {
      const addr = server.address() as any
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => server.close() })
    })
  })
}

beforeEach(() => {
  capturedController = null
  lastRunOpts = null
  activeSessionId = null
})

describe('POST /api/agent/abort', () => {
  it('aborts the in-flight controller registered by /agent/prompt', async () => {
    const { url, close } = await startApp()
    try {
      // Fire /agent/prompt (fire-and-forget; don't await body completion)
      const promptRes = await fetch(`${url}/api/agent/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Session-Id': 'sess-1' },
        body: JSON.stringify({ prompt: 'hi' }),
      })
      const { sessionId } = await promptRes.json()
      // Wait briefly for route to register controller
      for (let i = 0; i < 20 && !capturedController; i++) {
        await new Promise((r) => setTimeout(r, 10))
      }
      expect(capturedController).not.toBeNull()
      expect(capturedController!.signal.aborted).toBe(false)

      // Fire /agent/abort
      const abortRes = await fetch(`${url}/api/agent/abort`, {
        method: 'POST',
        headers: { 'X-Session-Id': sessionId },
      })
      expect(abortRes.status).toBe(200)
      expect(capturedController!.signal.aborted).toBe(true)
    } finally {
      close()
    }
  })
})