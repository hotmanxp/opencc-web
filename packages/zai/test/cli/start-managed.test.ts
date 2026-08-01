import { afterEach, describe, expect, it, mock } from 'bun:test'

afterEach(() => {
  mock.restore()
})

describe('cli/start.ts', () => {
  it('calls runSupervisor when --managed is the default and ZAI_NO_MANAGED not set', async () => {
    const fakeRun = mock(async () => ({ exitCode: 0 }))
    mock.module('../../src/cli/supervisor.js', () => ({ runSupervisor: fakeRun }))
    const { runStart } = await import('../../src/cli/start.js')
    await runStart({ port: '9201', open: false, managed: true })
    expect(fakeRun).toHaveBeenCalled()
  })
})
