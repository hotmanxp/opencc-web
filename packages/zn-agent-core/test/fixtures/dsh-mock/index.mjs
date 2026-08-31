#!/usr/bin/env node
/**
 * Mock dsh SDK-runtime fixture for the keyless loopback tests in
 * `test/unit/subagents/dsh/run.test.ts`.
 *
 * Speaks the DeepSeek Harness SDK JSON-RPC contract over stdio
 * (line-delimited), mirroring `@deepseek-ai/dsh --profile sdk`
 * (deepseek-harness `packages/sdk/server/src/server.ts` +
 * `packages/sdk/client/src/client.ts`):
 *
 *   initialize     → { serverInfo: { name, version } }
 *   session/prompt → { messageId } (then notifications for that session)
 *   shutdown       → {} then exit 0
 *
 * The prompt is positional-irrelevant; the spawn argv MUST contain
 * `--profile` (the provider always passes it) — otherwise exits 9.
 *
 * Toggles via env:
 *   - `MOCK_NONCE`          — the answer text (default: 'dsh-answer').
 *   - `MOCK_TURN_KIND`      — turn/end data.reason kind: 'completed' |
 *                             'max-tokens' | 'aborted' | 'aborted-disposed' |
 *                             'blocked' | 'error' | 'interrupted' | 'none'
 *                             (default: 'completed').
 *   - `MOCK_EMIT`           — 'message' | 'chunks' | 'both' | 'nothing'
 *                             (default: 'message').
 *   - `MOCK_HOLD`           — '1': never go idle (cancel tests).
 *   - `MOCK_FAIL_PROMPT`    — '1': session/prompt answers a JSON-RPC error.
 *   - `MOCK_EXIT_EARLY`     — '1': after answering prompt, exit 3 silently
 *                             (transport-loss settle path).
 *   - `MOCK_INIT_HANG`      — '1': never answer initialize.
 *   - `MOCK_EMIT_SUBAGENT`  — '1': emit subagent.started/finished before idle.
 */

import process from 'node:process'
import readline from 'node:readline'

const argv = process.argv.slice(2)
if (!argv.includes('--profile')) {
  process.stderr.write('[dsh-mock] missing --profile in argv\n')
  process.exit(9)
}

const NONCE = process.env.MOCK_NONCE ?? 'dsh-answer'
const TURN_KIND = process.env.MOCK_TURN_KIND ?? 'completed'
const EMIT = process.env.MOCK_EMIT ?? 'message'
const HOLD = process.env.MOCK_HOLD === '1'
const FAIL_PROMPT = process.env.MOCK_FAIL_PROMPT === '1'
const EXIT_EARLY = process.env.MOCK_EXIT_EARLY === '1'
const INIT_HANG = process.env.MOCK_INIT_HANG === '1'
const EMIT_SUBAGENT = process.env.MOCK_EMIT_SUBAGENT === '1'

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

function send(frame) {
  process.stdout.write(JSON.stringify(frame) + '\n')
}
function notify(method, params) {
  send({ method, params })
}

rl.on('line', (line) => {
  let frame
  try {
    frame = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = frame
  if (method === 'initialize') {
    if (INIT_HANG) return
    send({
      id,
      result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } },
    })
    return
  }
  if (method === 'session/prompt') {
    if (FAIL_PROMPT) {
      send({ id, error: { code: -32000, message: 'mock: prompt rejected' } })
      return
    }
    send({ id, result: { messageId: 'msg-mock-1' } })
    driveSession(params.sessionId)
    return
  }
  if (method === 'shutdown') {
    send({ id, result: {} })
    process.exit(0)
  }
  // Unknown methods: JSON-RPC method-not-found keeps the wire honest.
  if (id !== undefined) {
    send({ id, error: { code: -32601, message: `mock: unknown method ${method}` } })
  }
})

function driveSession(sessionId) {
  if (EXIT_EARLY) {
    process.exit(3)
  }
  setImmediate(() => {
    if (EMIT === 'chunks' || EMIT === 'both') {
      for (const piece of ['hello ', NONCE]) {
        notify('session.event', {
          sessionId,
          event: { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: piece } } },
        })
      }
    }
    if (EMIT === 'message' || EMIT === 'both') {
      notify('session.event', {
        sessionId,
        event: {
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: NONCE }] } },
        },
      })
    }
    if (EMIT_SUBAGENT) {
      notify('subagent.started', { parentSessionId: sessionId, childSessionId: 'session-child-1' })
      notify('subagent.finished', {
        provider: 'spawn',
        agentId: 'session-child-1',
        parentSessionId: sessionId,
        childSessionId: 'session-child-1',
        status: 'completed',
        stopReason: 'completed',
      })
    }
    if (TURN_KIND !== 'none') {
      const reason =
        TURN_KIND === 'aborted-disposed'
          ? { kind: 'aborted', reason: { kind: 'disposed' } }
          : { kind: TURN_KIND }
      notify('session.event', { sessionId, event: { type: 'turn/end', data: { reason } } })
    }
    if (HOLD) return
    notify('session.status', { sessionId, status: 'idle' })
  })
}

process.on('SIGTERM', () => process.exit(143))
process.stderr.on('data', () => {})
