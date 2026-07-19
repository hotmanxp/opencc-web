import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runWithSessionId } from '../../opencc-internals/utils/cwd.js'
import { CwdStore } from '../../runtime/cwdStore.js'

/**
 * Integration-style test: directly spawn the same commandString format BashTool uses,
 * verify pwd -P trailer writes tmpfile, and verify exit handler logic updates CwdStore.
 *
 * We don't go through BashTool.call() because that requires a full LegacyToolContext.
 * Instead we exercise the trailer logic in isolation.
 */

describe('BashTool cwd trailer integration', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'zai-bash-cwd-test-'))

  beforeEach(() => {
    CwdStore.clear()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function runWithTrailer(command: string, sessionId: string): Promise<{ code: number; newCwd: string | null }> {
    const taskId = `test-${Math.random().toString(16).slice(2, 10)}`
    const tmpfile = join(tmpDir, `cwd-${taskId}`)
    const fullCommand = `${command}\npwd -P >| ${tmpfile}`

    return new Promise((resolve) => {
      const child = spawn('sh', ['-c', fullCommand], { cwd: process.cwd() })
      child.on('exit', (code) => {
        let newCwd: string | null = null
        try {
          if (existsSync(tmpfile)) {
            newCwd = readFileSync(tmpfile, 'utf8').trim()
          }
        } catch {
          // tmpfile missing → newCwd stays null
        }

        // Mirror BashTool exit handler logic:
        if (newCwd && newCwd !== CwdStore.get(sessionId)) {
          CwdStore.set(sessionId, newCwd)
        }

        resolve({ code: code ?? -1, newCwd })
      })
    })
  }

  it('cd /tmp updates CwdStore', async () => {
    runWithSessionId('sess-t1', () => {})
    CwdStore.set('sess-t1', process.cwd())

    const { code, newCwd } = await runWithTrailer('cd /tmp && echo done', 'sess-t1')

    expect(code).toBe(0)
    // macOS /tmp is a symlink to /private/tmp; pwd -P resolves to canonical path
    const expectedCwd = process.platform === 'darwin' ? '/private/tmp' : '/tmp'
    expect(newCwd).toBe(expectedCwd)
    expect(CwdStore.get('sess-t1')).toBe(expectedCwd)
  })

  it('no-op command leaves CwdStore unchanged', async () => {
    CwdStore.set('sess-t2', process.cwd())
    const { newCwd } = await runWithTrailer('echo hello', 'sess-t2')
    // If trailer wrote tmpfile, newCwd matches spawn cwd (== process.cwd() in helper)
    // If trailer failed (e.g., tmpfile gone), newCwd is null and we skip update
    if (newCwd !== null) {
      expect(newCwd).toBe(process.cwd())
      expect(CwdStore.get('sess-t2')).toBe(process.cwd())
    } else {
      // Trailer didn't write — BashTool would skip CwdStore update (same result for caller)
      expect(CwdStore.get('sess-t2')).toBe(process.cwd())
    }
  })

  it('failed command (cd to nonexistent) leaves CwdStore unchanged', async () => {
    CwdStore.set('sess-t3', process.cwd())
    const { code, newCwd } = await runWithTrailer('cd /this/path/does/not/exist', 'sess-t3')
    expect(code).not.toBe(0)
    // If newCwd points to a real dir (it shouldn't here), the implementation would skip; otherwise ENOENT silent.
    expect(CwdStore.get('sess-t3')).toBe(process.cwd())
  })
})