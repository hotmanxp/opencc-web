import { describe, expect, it, mock } from 'bun:test'

describe('cli/start.ts --managed-child', () => {
  it('skips the supervisor path when spawned as a managed child', async () => {
    const fakeRun = mock(async () => {
      throw new Error('supervisor should not run')
    })
    mock.module('../../src/cli/supervisor.js', () => ({ runSupervisor: fakeRun }))
    // The direct server path would bind a real port; make createApp throw so
    // the test never binds anything. The assertion is that the supervisor
    // path was NOT taken — if it were, fakeRun would have been called.
    mock.module('../../src/server/index.js', () => ({
      createApp: mock(async () => {
        throw new Error('direct-server-reached')
      }),
    }))
    const { runStart } = await import('../../src/cli/start.js')
    await expect(
      runStart({ port: '9201', open: false, managedChild: true }),
    ).rejects.toThrow('direct-server-reached')
    expect(fakeRun).not.toHaveBeenCalled()
  })
})
