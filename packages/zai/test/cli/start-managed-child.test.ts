import { describe, expect, it, vi } from 'vitest'

// Bun's mock.module patches the module registry process-wide with no restore
// API, so the original test ran the assertion in a child process. vitest's
// vi.mock is scoped per test file, so mocking in-process is safe here.
vi.mock('../../src/cli/supervisor.js', () => ({
  runSupervisor: vi.fn(async () => {
    throw new Error('supervisor should not run')
  }),
}))
// The direct server path would bind a real port; make createApp throw so the
// test never binds anything. The assertion is that the supervisor path was
// NOT taken — if it were, runSupervisor would have been called.
vi.mock('../../src/server/index.js', () => ({
  createApp: vi.fn(async () => {
    throw new Error('direct-server-reached')
  }),
}))

describe('cli/start.ts --managed-child', () => {
  it('skips the supervisor path when spawned as a managed child', async () => {
    const { runStart } = await import('../../src/cli/start.js')
    const { runSupervisor } = await import('../../src/cli/supervisor.js')
    let error: string | null = null
    try {
      await runStart({ port: '9201', open: false, managedChild: true })
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    expect(error).toBe('direct-server-reached')
    expect(runSupervisor).not.toHaveBeenCalled()
  })
})
