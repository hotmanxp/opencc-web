import { afterEach, describe, expect, it, vi } from 'vitest'

// Bun's mock.module patches the module registry process-wide; vitest's
// vi.mock is scoped per test file, so no child-process isolation is needed.
vi.mock('../../src/cli/supervisor.js', () => ({
  runSupervisor: vi.fn(async () => ({ exitCode: 0 })),
}))

afterEach(() => {
  vi.clearAllMocks()
})

describe('cli/start.ts', () => {
  it('calls runSupervisor when --managed is the default and ZAI_NO_MANAGED not set', async () => {
    // runStart calls process.exit(exitCode) once the supervisor returns;
    // throw from the exit spy so the run stops before it boots the direct
    // server, then assert the supervisor path was reached.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as never)
    try {
      const { runSupervisor } = await import('../../src/cli/supervisor.js')
      const { runStart } = await import('../../src/cli/start.js')
      await expect(
        runStart({ port: '9201', open: false, managed: true }),
      ).rejects.toThrow('process.exit called')
      expect(runSupervisor).toHaveBeenCalled()
    } finally {
      exitSpy.mockRestore()
    }
  }, 15_000)
})
