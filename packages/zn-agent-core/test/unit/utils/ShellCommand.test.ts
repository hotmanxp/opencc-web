import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { wrapSpawn } from '../../../src/opencc-src/utils/ShellCommand.js'
import { TaskOutput } from '../../../src/opencc-src/utils/task/TaskOutput.js'

// Break the module-load cycle: opencc-src/utils/task/diskOutput.ts imports
// `../permissions/filesystem.js`, which imports `src/tools/AgentTool/agentMemory.js`
// → AgentTool → BashTool. BashTool's top-level buildTool eagerly evaluates its
// lazySchema inputSchema, reading getMaxTimeoutMs() from prompt.ts before that
// module finishes initializing → "getMaxTimeoutMs is not a function".
// diskOutput only uses getProjectTempDir() from filesystem, so stubbing the
// whole filesystem module here severs the cycle without pulling in the tool graph.
vi.mock('../../../src/opencc-src/utils/permissions/filesystem.js', () => ({
  getProjectTempDir: () => '/tmp',
  getClaudeConfigHomeDir: () => '/tmp/.claude',
}))

// tree-kill targets a fake pid in tests; stub it so it never touches a real process.
vi.mock('tree-kill', () => {
  return {
    default: (
      _pid: number,
      _signal: string,
      callback?: (err?: Error) => void,
    ) => {
      callback?.(new Error('fake pid'))
    },
  }
})

/** Minimal ChildProcess stand-in: EventEmitter + pid + null stdio. */
function makeFakeChildProcess() {
  const cp = new EventEmitter() as EventEmitter & {
    pid: number
    stdout: null
    stderr: null
  }
  cp.pid = 999999
  cp.stdout = null
  cp.stderr = null
  return cp
}

describe('ShellCommand kill + cleanup race', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not crash when cleanup() nulls #abortSignal before the queued #handleExit runs', async () => {
    const cp = makeFakeChildProcess()
    const abortController = new AbortController()
    const taskOutput = new TaskOutput('race-test-1', null)

    const cmd = wrapSpawn(cp, abortController.signal, 30000, taskOutput)

    // kill() resolves the exit promise, queueing #handleExit as a microtask.
    cmd.kill()
    // cleanup() nulls #abortSignal synchronously, before that microtask runs.
    cmd.cleanup()

    // If #handleExit reads #abortSignal.aborted on the now-null ref, this
    // rejects with `Cannot read properties of null (reading 'aborted')`.
    const result = await cmd.result
    expect(result).toBeDefined()
    expect(result.code).toBe(137)
  })

  it('still reports signalAborted truthfully when cleanup() runs after #handleExit completes', async () => {
    const cp = makeFakeChildProcess()
    const abortController = new AbortController()
    const taskOutput = new TaskOutput('race-test-2', null)

    const cmd = wrapSpawn(cp, abortController.signal, 30000, taskOutput)

    // Kill and let #handleExit fully settle before cleanup — no race here,
    // but verifies the abort metadata path still works post-fix.
    cmd.kill()
    abortController.abort()
    const result = await cmd.result
    cmd.cleanup()

    expect(result.signalAborted).toBe(true)
  })
})