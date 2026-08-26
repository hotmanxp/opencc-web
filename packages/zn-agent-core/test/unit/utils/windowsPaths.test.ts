import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock execSync so checkPathExists / findExecutable behave deterministically
// without spawning real commands (the real impl shells out to `dir`/`where.exe`,
// which only exist on Windows).
vi.mock('../../../src/opencc-src/utils/execSyncWrapper.js', () => ({
  execSync_DEPRECATED: vi.fn(),
}))

const { execSync_DEPRECATED } = await import(
  '../../../src/opencc-src/utils/execSyncWrapper.js'
)

const mockExec = execSync_DEPRECATED as unknown as ReturnType<typeof vi.fn>

// Known-installed paths for the simulated Windows box.
const GIT_CMD = 'C:\\Program Files\\Git\\cmd\\git.exe'
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const installed = new Set([GIT_CMD, GIT_BASH])

function setupWindowsBox(gitOnPath = true): void {
  mockExec.mockImplementation((command: string) => {
    if (command.startsWith('dir ')) {
      const target = command.slice(5).replace(/"/g, '')
      // Only the default install locations count when git is "installed";
      // otherwise every dir probe fails so findExecutable returns null.
      if (gitOnPath && installed.has(target)) return Buffer.from('')
      throw new Error('not found')
    }
    if (command.startsWith('where.exe')) {
      if (gitOnPath) return Buffer.from(GIT_CMD)
      throw new Error('not found')
    }
    return Buffer.from('')
  })
}

// Re-load the module fresh so resolveGitBashPath's lodash memoize() closure
// isn't shared across test cases (its resolved value is cached on first call).
async function loadWindowsPaths(gitOnPath = true) {
  vi.resetModules()
  setupWindowsBox(gitOnPath)
  return await import('../../../src/opencc-src/utils/windowsPaths.js')
}

describe('windowsPaths git-bash resolution', () => {
  beforeEach(() => {
    delete process.env.CLAUDE_CODE_GIT_BASH_PATH
  })

  it('returns the path when CLAUDE_CODE_GIT_BASH_PATH points at an existing bash.exe', async () => {
    process.env.CLAUDE_CODE_GIT_BASH_PATH = GIT_BASH
    const { resolveGitBashPath } = await loadWindowsPaths()
    expect(resolveGitBashPath()).toBe(GIT_BASH)
  })

  it('returns null (instead of exiting) when CLAUDE_CODE_GIT_BASH_PATH is missing', async () => {
    process.env.CLAUDE_CODE_GIT_BASH_PATH =
      'C:\\Program Files\\Git\\bin\\bash-missing.exe'
    const { resolveGitBashPath } = await loadWindowsPaths()
    expect(resolveGitBashPath()).toBeNull()
  })

  it('infers bash.exe from the git install directory when git is on PATH', async () => {
    const { resolveGitBashPath } = await loadWindowsPaths()
    expect(resolveGitBashPath()).toBe(GIT_BASH)
  })

  it('returns null when git is not installed', async () => {
    const { resolveGitBashPath } = await loadWindowsPaths(false)
    expect(resolveGitBashPath()).toBeNull()
  })

  it('findGitBashPath returns the resolved path when found (does not exit)', async () => {
    const { findGitBashPath } = await loadWindowsPaths()
    expect(findGitBashPath()).toBe(GIT_BASH)
  })
})