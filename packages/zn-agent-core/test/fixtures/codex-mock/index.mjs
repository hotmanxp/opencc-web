#!/usr/bin/env node
/**
 * Mock Codex app-server fixture for the keyless loopback tests in
 * `test/unit/subagents/codex/run.test.ts`.
 *
 * Protocol shape: line-delimited JSON-RPC over stdio (the same surface
 * the real `codex app-server --stdio` exposes). This binary answers
 * `initialize` / `thread/start` / `turn/start` and emits one
 * `agentMessage` with phase: 'final_answer' + a `turn/completed` with
 * status: 'success' before exiting 0.
 *
 * Toggles via env so a single binary can drive multiple test cases
 * (the run.test.ts file picks the scenario based on a flag):
 *
 *   - `MOCK_NONCE`            — the answer text (default: 'mock-answer').
 *                               Required when a test wants byte-equal
 *                               comparison against the provider's result.
 *   - `MOCK_EMIT_COMMENTARY`  — when '1', emit a commentary notification
 *                               between thread/start and the final_answer
 *                               to exercise the "commentary never replaces
 *                               the answer" branch of result.ts.
 *   - `MOCK_FAIL_TURN`        — when '1', emit `turn/completed` with
 *                               status: 'error' instead of success.
 *   - `MOCK_REQUEST_APPROVAL` — when '1', server side emits an
 *                               `execApprovalRequest` notification after
 *                               turn/start; the unattended policy must
 *                               answer with cancel without hanging.
 *   - `MOCK_DELAY_MS`         — wait this many ms between turn/start
 *                               ack and final answer. Used by the
 *                               cancellation test.
 */

import process from 'node:process'

const NONCE = process.env.MOCK_NONCE ?? 'mock-answer'
const EMIT_COMMENTARY = process.env.MOCK_EMIT_COMMENTARY === '1'
const FAIL_TURN = process.env.MOCK_FAIL_TURN === '1'
const REQUEST_APPROVAL = process.env.MOCK_REQUEST_APPROVAL === '1'
const DELAY_MS = Number(process.env.MOCK_DELAY_MS ?? '0')

let nextId = 1
let buf = ''

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function sendNotification(method, params) {
  send({ method, params })
}

process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8')
  let nl
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      continue
    }
    handle(frame)
  }
})

function handle(frame) {
  if (typeof frame.id !== 'number') return // notifications: ignore
  const { id, method, params } = frame
  if (method === 'initialize') {
    send({
      id,
      result: { protocolVersion: params?.protocolVersion ?? '0.147.0' },
    })
    return
  }
  if (method === 'thread/start') {
    send({ id, result: { threadId: 'mock-thread-1' } })
    return
  }
  if (method === 'turn/start') {
    send({ id, result: { turnId: 'mock-turn-1' } })
    // Drive the rest of the turn asynchronously so the request promise
    // resolves first (mirrors a real Codex 0.147.0 server).
    setTimeout(() => driveTurn(params?.threadId ?? 'mock-thread-1', 'mock-turn-1'), DELAY_MS)
    return
  }
  if (method === 'turn/interrupt') {
    send({ id, result: {} })
    return
  }
  // Unknown — return an error frame so the client knows we ignored it.
  send({ id, error: { code: -32601, message: `mock: unknown method '${method}'` } })
}

async function driveTurn(threadId, turnId) {
  if (REQUEST_APPROVAL) {
    sendNotification('execApprovalRequest', {
      threadId,
      turnId,
      offeredDecisions: ['approve', 'cancel', 'decline'],
      cmd: 'rm -rf /forbidden',
    })
  }
  if (EMIT_COMMENTARY) {
    sendNotification('commentary', { threadId, turnId, text: 'planning tools...' })
  }
  // The Codex 0.147.0 wire protocol uses `agentMessage` (camelCase) for
  // the streaming message type and `turn/completed` (slash-form) for the
  // terminal notification. The provider keys off `type === 'agentMessage'`
  // for an event (matching deepseek-harness's `item.type !== 'agentMessage'`
  // guard) and off `method === 'turn/completed'` for the terminal fact.
  sendNotification('agentMessage', { threadId, turnId, text: NONCE, phase: 'final_answer' })
  sendNotification('turn/completed', {
    threadId,
    turnId,
    status: FAIL_TURN ? 'error' : 'success',
    ...(FAIL_TURN ? { errorMessage: 'mock: forced failure', codexErrorInfo: 'mockError' } : {}),
  })
}

// Hang on stderr so a misbehaving client doesn't accidentally log noise.
process.stderr.on('data', () => {})
// SIGTERM is the only signal we honor; SIGKILL/SIGSTOP cannot be caught
// from inside Node, and registering a listener for them throws EINVAL.
process.on('SIGTERM', () => process.exit(143))
