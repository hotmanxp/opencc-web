import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'

const START_URL = new URL('../../src/cli/start.js', import.meta.url).href
const SUPERVISOR_URL = new URL(
  '../../src/cli/supervisor.js',
  import.meta.url,
).href
const SERVER_URL = new URL('../../src/server/index.js', import.meta.url).href

describe('cli/start.ts --managed-child', () => {
  it('skips the supervisor path when spawned as a managed child', () => {
    // Bun's mock.module patches the module registry process-wide with no
    // restore API: mocking supervisor.js / server/index.js in-process leaks
    // into sibling test files (supervisor.test.ts, managedChild-boot.test.ts)
    // that run in the same bun test process and import the same modules.
    // Run the assertion in a child process so the mocks die with it.
    const script = `
      import { mock } from 'bun:test'
      const fakeRun = mock(async () => {
        throw new Error('supervisor should not run')
      })
      mock.module(${JSON.stringify(SUPERVISOR_URL)}, () => ({
        runSupervisor: fakeRun,
      }))
      // The direct server path would bind a real port; make createApp throw so
      // the test never binds anything. The assertion is that the supervisor
      // path was NOT taken — if it were, fakeRun would have been called.
      mock.module(${JSON.stringify(SERVER_URL)}, () => ({
        createApp: mock(async () => {
          throw new Error('direct-server-reached')
        }),
      }))
      const { runStart } = await import(${JSON.stringify(START_URL)})
      let error = null
      try {
        await runStart({ port: '9201', open: false, managedChild: true })
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }
      console.log(JSON.stringify({ error, fakeRunCalls: fakeRun.mock.calls.length }))
    `
    const res = spawnSync('bun', ['-e', script], { encoding: 'utf8' })
    expect(res.status).toBe(0)
    const line = res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('{'))
      .at(-1)
    const parsed = JSON.parse(line ?? '{}') as {
      error: string | null
      fakeRunCalls: number
    }
    expect(parsed.error).toBe('direct-server-reached')
    expect(parsed.fakeRunCalls).toBe(0)
  })
})
