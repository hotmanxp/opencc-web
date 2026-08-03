import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, appendFileSync } from 'node:fs'

const DBG = '/tmp/zai-int-debug.log'
function dbg(msg: string) { appendFileSync(DBG, `${Date.now()} ${msg}\n`) }

// Spawn the real supervisor wrapping a tiny echo child that responds to 'ready' on IPC.
describe('supervisor integration', () => {
  it('restarts child after restart message', async () => {
    writeFileSync(DBG, `start\n`)
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const fixturePath = join(__dirname, 'fixtures', 'echo-child.ts')
    const supervisorPath = join(__dirname, '..', '..', 'src', 'cli', 'supervisor.ts')
    dbg(`fixture=${fixturePath} supervisor=${supervisorPath}`)
    const supLog = require('fs').openSync('/tmp/zai-sup-stderr.log', 'w')
    const supOut = require('fs').openSync('/tmp/zai-sup-stdout.log', 'w')
    const child = spawn('bun', ['run', supervisorPath, '--child-script', fixturePath], {
      stdio: ['ipc', supOut, supLog],
      env: { ...process.env, ZAI_DATA_DIR: '/tmp/zai-sup-int' },
    })
    dbg(`spawned pid=${child.pid}`)
    let count = 0
    const gotReady = new Promise<void>((resolve) => {
      child.on('message', (msg: { type?: string }) => {
        dbg(`msg ${JSON.stringify(msg)}`)
        if (msg?.type === 'ready') {
          count++
          if (count === 1) {
            dbg('sending restart')
            child.send({ type: 'restart', reason: 'user_action' })
          }
          if (count >= 2) resolve()
        }
      })
      child.on('exit', (c, s) => dbg(`child exit code=${c} sig=${s}`))
      child.on('error', (e) => dbg(`child error ${e.message}`))
    })
    await gotReady
    dbg(`count=${count}`)
    child.kill('SIGINT')
    expect(count).toBeGreaterThanOrEqual(2)
  }, 60_000)
})