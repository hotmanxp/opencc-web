#!/usr/bin/env node
/**
 * Mock opencode CLI fixture for the keyless loopback tests in
 * `test/unit/subagents/opencode/run.test.ts`.
 *
 * Mimics `opencode run --format json`: newline-delimited JSON frames on
 * stdout, each carrying `sessionID` / `timestamp` / `part`. Frame vocabulary
 * follows the provider spec's smoke (`step_start` / `text` / `step_finish`).
 *
 * argv (process.argv.slice(2)) as built by `opencodeSpawnArgv`:
 *   [THIS_FILE, 'run', '--format', 'json', (…'-m', model)?, prompt]
 *
 * Toggles via env:
 *   - MOCK_NONCE       — the answer text (default 'mock-answer').
 *   - MOCK_MODE        — scenario selector (default 'normal'):
 *       normal    → step_start, text(NONCE), step_finish(reason:stop); exit 0
 *       multtext  → two parts + a re-emitted same-id part (dedup test)
 *       garbage   → one non-JSON line then the normal frames
 *       noanswer  → step_finish(reason:stop) with NO text frame
 *       fail      → step_finish(reason:error) + stderr; exit 0
 *       maxtokens → text(NONCE) + step_finish(reason:length)
 *       exiterr   → stderr only, exit 3, NO step_finish (auth-hang analog)
 *   - MOCK_DELAY_MS    — wait before emitting (used by the cancel test).
 *   - MOCK_ECHO_PROMPT — when '1', append the received prompt to the answer.
 */

import process from 'node:process'

const NONCE = process.env.MOCK_NONCE ?? 'mock-answer'
const MODE = process.env.MOCK_MODE ?? 'normal'
const DELAY_MS = Number(process.env.MOCK_DELAY_MS ?? '0')
const ECHO_PROMPT = process.env.MOCK_ECHO_PROMPT === '1'

const argv = process.argv.slice(2)
const prompt = argv.length > 0 ? argv[argv.length - 1] : ''
const answer = ECHO_PROMPT ? `${NONCE} :: ${prompt}` : NONCE

const SESSION = 'ses_mock'
let ts = 0
const stamp = () => ts++
const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

const stepStart = () =>
  write({ type: 'step_start', sessionID: SESSION, timestamp: stamp(), part: { id: 'prt_ss', type: 'step-start' } })
const textFrame = (id, t) =>
  write({ type: 'text', sessionID: SESSION, timestamp: stamp(), part: { id, type: 'text', text: t, time: { start: stamp(), end: stamp() } } })
const stepFinish = (reason) =>
  write({ type: 'step_finish', sessionID: SESSION, timestamp: stamp(), part: { id: 'prt_sf', type: 'step-finish', reason, tokens: { input: 1, output: 2 }, cost: 0 } })

function run() {
  switch (MODE) {
    case 'multtext':
      stepStart()
      // A trailing-whitespace blank part must be ignored; same-id re-emission
      // keeps only the last text.
      textFrame('prt_a', '   ')
      textFrame('prt_b', 'first part')
      textFrame('prt_b', 'first part (final)')
      textFrame('prt_c', 'second part')
      stepFinish('stop')
      process.exit(0)
      return
    case 'garbage':
      stepStart()
      process.stdout.write('this line is not json\n')
      textFrame('prt_b', answer)
      stepFinish('stop')
      process.exit(0)
      return
    case 'noanswer':
      stepStart()
      stepFinish('stop')
      process.exit(0)
      return
    case 'fail':
      stepStart()
      textFrame('prt_b', 'partial')
      stepFinish('error')
      process.stderr.write('mock: forced failure\n')
      process.exit(0)
      return
    case 'maxtokens':
      stepStart()
      textFrame('prt_b', answer)
      stepFinish('length')
      process.exit(0)
      return
    case 'exiterr':
      process.stderr.write('opencode: not authenticated\n')
      process.exit(3)
      return
    case 'normal':
    default:
      stepStart()
      textFrame('prt_b', answer)
      stepFinish('stop')
      process.exit(0)
      return
  }
}

setTimeout(run, DELAY_MS)

process.on('SIGTERM', () => process.exit(143))
process.stderr.on('data', () => {})
