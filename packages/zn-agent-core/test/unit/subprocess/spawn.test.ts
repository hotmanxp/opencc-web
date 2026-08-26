import { describe, it, expect } from 'vitest'
import { spawnSubprocess } from '../../../src/compat/subprocess/spawn.js'
import { DISPOSE_GRACE_MS_DEFAULT } from '../../../src/compat/subprocess/timeouts.js'

/**
 * Tests for the pipe-stdio spawn helper. We don't need a real codex install
 * for this layer; spawning Node itself is enough — the seam only wraps
 * `child_process.spawn` + env composition + kill escalation.
 *
 * IMPORTANT: these tests run OS processes. On macOS / Linux they take
 * 100–500 ms each; on Windows the `.cmd` shim resolution adds an
 * additional `cmd.exe` process. Skip-flake tolerance is generous
 * intentionally (no strict timing).
 */

const NODE_BIN = process.execPath // absolute path to the running Node binary

describe('subprocess/spawn.spawnSubprocess', () => {
  it('reports pid, exit code, and signal for a quick-exit child', async () => {
    const handle = spawnSubprocess({
      command: NODE_BIN,
      args: ['-e', "process.stdout.write('hello'); process.exit(0)"],
    })
    expect(handle.pid).toBeTypeOf('number')
    expect(handle.pid).toBeGreaterThan(0)
    const exit = await handle.exitCode
    expect(exit.code).toBe(0)
    expect(exit.signal).toBeNull()
    // Cleanup: child has already exited, killTree is a no-op but should
    // resolve immediately without throwing.
    await expect(handle.killTree(100)).resolves.toBeUndefined()
  })

  it('captures stdout bytes verbatim through the readable stream', async () => {
    const handle = spawnSubprocess({
      command: NODE_BIN,
      args: ['-e', "console.log('payload-' + 42)"],
    })
    const collected: string[] = []
    handle.stdout.on('data', (chunk: Buffer) => collected.push(chunk.toString()))
    await handle.exitCode
    expect(collected.join('')).toContain('payload-42')
  })

  it('reports a non-zero exit code when the child exits with code 1', async () => {
    // Assert the `code != 0` branch of exitSettle without relying on a
    // spawn-time ENOENT (which can interact unexpectedly with vitest's
    // unhandledException reporter in some Node versions — see SpawnError
    // handling note below). A child's own exit code is the common path.
    const handle = spawnSubprocess({
      command: NODE_BIN,
      args: ['-e', 'process.exit(7)'],
    })
    const exit = await handle.exitCode
    expect(exit.code).toBe(7)
    expect(exit.signal).toBeNull()
  })

  it('triggers killTree on AbortSignal.abort()', async () => {
    // Spawn a long-sleeping child; abort mid-flight; expect killTree's
    // SIGTERM escalation to bring it down inside the grace window.
    const ac = new AbortController()
    const handle = spawnSubprocess({
      command: NODE_BIN,
      args: ['-e', 'setTimeout(() => process.exit(0), 30_000)'],
      signal: ac.signal,
    })
    const pid = handle.pid
    expect(pid).toBeTypeOf('number')
    ac.abort()
    const exit = await Promise.race([
      handle.exitCode,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('did not exit in time')), 5000)),
    ])
    // Either the OS reported a non-zero exit (process killed by signal)
    // or the child happened to exit before SIGTERM reached it. Both are
    // acceptable for "killTree actually ran".
    expect(typeof exit.code === 'number' || exit.signal !== null).toBe(true)
  })

  it('killTree is idempotent — calling it twice resolves to the same promise', async () => {
    const handle = spawnSubprocess({
      command: NODE_BIN,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    })
    const pid = handle.pid
    expect(pid).toBeTypeOf('number')
    const first = handle.killTree(DISPOSE_GRACE_MS_DEFAULT)
    const second = handle.killTree(DISPOSE_GRACE_MS_DEFAULT)
    expect(second).toBe(first) // same Promise instance — internal dedupe
    await Promise.all([first, second])
  })

  it('forwards explicit env overlay to the child', async () => {
    const SENTINEL = `zn-test-${Date.now()}-${Math.random()}`
    const handle = spawnSubprocess({
      command: NODE_BIN,
      args: ['-e', `process.stdout.write(process.env.ZN_TEST_SENTINEL ?? 'missing')`],
      env: { ZN_TEST_SENTINEL: SENTINEL },
    })
    const collected: string[] = []
    handle.stdout.on('data', (chunk: Buffer) => collected.push(chunk.toString()))
    await handle.exitCode
    expect(collected.join('')).toBe(SENTINEL)
  })
})
