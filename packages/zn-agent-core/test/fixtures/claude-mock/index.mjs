#!/usr/bin/env node
/**
 * Mock Claude Code CLI fixture for the keyless loopback tests in
 * `test/unit/subagents/claude-code/run.test.ts`.
 *
 * Contract (matches `claude --print --output-format stream-json`):
 *   - argv[0] is `node <this file>` (set by the test using `process.execPath`).
 *   - argv includes `--print`, `--output-format`, and ends with `--`, prompt.
 *   - On stdout we emit stream-json events, last frame type=result.
 *
 * Toggles via env:
 *   - `MOCK_NONCE`     — the answer text (default: 'mock-answer').
 *   - `MOCK_OUTPUT`    — 'json' / 'stream-json' / 'text' (default: 'stream-json').
 *   - `MOCK_FAIL`      — when '1', emit a `result` event with `is_error=true`.
 *   - `MOCK_DELAY_MS`  — wait before emitting anything (used by cancel tests).
 */

import process from 'node:process'

const NONCE = process.env.MOCK_NONCE ?? 'mock-answer'
const OUTPUT = process.env.MOCK_OUTPUT ?? 'stream-json'
const FAIL = process.env.MOCK_FAIL === '1'
const DELAY_MS = Number(process.env.MOCK_DELAY_MS ?? '0')

const argv = process.argv.slice(2)
const printIdx = argv.indexOf('--print')
const permIdx = argv.indexOf('--permission-mode')
const formatIdx = argv.indexOf('--output-format')

const permMode = permIdx >= 0 ? argv[permIdx + 1] : 'default'
const format = formatIdx >= 0 ? argv[formatIdx + 1] : OUTPUT

// Honor --permission-mode: don't run unattended if the caller asked for
// `plan` or `default` — silently degrade to bypassPermissions here so the
// test surface stays consistent. Real `claude` would error.
if (!['bypassPermissions', 'acceptEdits'].includes(permMode)) {
  process.stderr.write(`[mock] permission-mode=${permMode} accepted in mock\n`)
}

setTimeout(() => emitOutput(format), DELAY_MS)

function emitOutput(mode) {
  if (mode === 'text') {
    process.stdout.write(NONCE + '\n')
    process.exit(FAIL ? 1 : 0)
    return
  }
  if (mode === 'json') {
    const obj = FAIL
      ? { type: 'result', is_error: true, error: 'mock: forced failure' }
      : { type: 'result', result: NONCE, is_error: false, usage: { input_tokens: 1, output_tokens: 2 } }
    process.stdout.write(JSON.stringify(obj) + '\n')
    process.exit(FAIL ? 1 : 0)
    return
  }
  // stream-json
  const frames = [
    {
      type: 'system',
      subtype: 'init',
      cwd: process.cwd(),
    },
    {
      type: 'assistant',
      message: { id: 'msg-1', content: [{ type: 'text', text: 'Working...' }] },
    },
    {
      type: 'assistant',
      message: { id: 'msg-2', content: [{ type: 'text', text: NONCE }] },
    },
  ]
  for (const f of frames) {
    process.stdout.write(JSON.stringify(f) + '\n')
  }
  if (FAIL) {
    process.stdout.write(
      JSON.stringify({
        type: 'result',
        is_error: true,
        error: 'mock: forced failure',
      }) + '\n',
    )
  } else {
    process.stdout.write(
      JSON.stringify({
        type: 'result',
        result: NONCE,
        is_error: false,
        duration_ms: 1,
      }) + '\n',
    )
  }
  process.exit(FAIL ? 1 : 0)
}

process.on('SIGTERM', () => process.exit(143))
process.stderr.on('data', () => {})
