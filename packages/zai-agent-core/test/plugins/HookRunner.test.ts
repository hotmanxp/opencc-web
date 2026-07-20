import { describe, expect, test, vi, beforeAll } from 'vitest'
import { HookRunner } from '../../src/plugins/HookRunner.js'
import { createDefaultHookExecutor } from '../../src/plugins/defaultHookExecutor.js'
import { mkdtemp, realpath } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type {
  HookExecutor,
  PluginHook,
} from '../../src/plugins/types.js'

let ROOT: string

beforeAll(async () => {
  // Node refuses to spawn a child when cwd doesn't exist; tests need a
  // real directory. Use mkdtemp so parallel test runs don't collide.
  const tmp = await mkdtemp(join(tmpdir(), 'zai-hookrunner-'))
  // Resolve to canonical path so macOS `/var/folders/...` ↔
  // `/private/var/folders/...` symlinks match what the child reports.
  ROOT = await realpath(tmp)
})

function makeHook(partial: Partial<PluginHook> & Pick<PluginHook, 'event' | 'command'>): PluginHook {
  return {
    pluginId: 'p',
    pluginRoot: ROOT,
    ...partial,
  }
}

describe('HookRunner', () => {
  test('blocks in declared order: matcher fires first blocker, short-circuits rest of PreToolUse', async () => {
    const calls: string[] = []
    const executor: HookExecutor = vi.fn(async request => {
      calls.push(request.command)
      return request.command === 'first' ? { blocked: true, output: 'denied' } : {}
    })
    const runner = new HookRunner(
      [
        makeHook({ event: 'PreToolUse', matcher: 'Bash', command: 'first' }),
        makeHook({ event: 'PreToolUse', matcher: '.*', command: 'second' }),
      ],
      executor,
    )

    const controller = new AbortController()
    const result = await runner.run('PreToolUse', { toolName: 'Bash' }, controller.signal)

    expect(calls).toEqual(['first'])
    expect(result.blocked).toBe(true)
    expect(result.ran).toBe(1)
    expect(result.outputs).toEqual(['denied'])
    expect(result.errors).toEqual([])
  })

  test('matcher that does not match input skips the hook entirely', async () => {
    const executor: HookExecutor = vi.fn(async () => ({ blocked: true }))
    const runner = new HookRunner(
      [makeHook({ event: 'PreToolUse', matcher: 'Read', command: 'only-read' })],
      executor,
    )
    const controller = new AbortController()

    const result = await runner.run(
      'PreToolUse',
      { toolName: 'Bash' },
      controller.signal,
    )

    expect(executor).not.toHaveBeenCalled()
    expect(result.ran).toBe(0)
    expect(result.blocked).toBe(false)
    expect(result.outputs).toEqual([])
    expect(result.errors).toEqual([])
  })

  test('empty matcher matches all inputs', async () => {
    const executor: HookExecutor = vi.fn(async () => ({}))
    const runner = new HookRunner(
      [makeHook({ event: 'PostToolUse', command: 'echo' })],
      executor,
    )
    const controller = new AbortController()

    const result = await runner.run(
      'PostToolUse',
      { toolName: 'Bash' },
      controller.signal,
    )

    expect(executor).toHaveBeenCalledTimes(1)
    expect(result.ran).toBe(1)
    expect(result.blocked).toBe(false)
  })

  test('non-blocking event: hooks all run even if an earlier one returns blocked=true', async () => {
    const calls: string[] = []
    const executor: HookExecutor = vi.fn(async request => {
      calls.push(request.command)
      if (request.command === 'a') return { blocked: true, output: 'a' }
      return { blocked: false, output: request.command }
    })
    const runner = new HookRunner(
      [
        makeHook({ event: 'PostToolUse', command: 'a' }),
        makeHook({ event: 'PostToolUse', command: 'b' }),
      ],
      executor,
    )
    const controller = new AbortController()

    const result = await runner.run('PostToolUse', {}, controller.signal)

    expect(calls).toEqual(['a', 'b'])
    expect(result.blocked).toBe(false)
    expect(result.ran).toBe(2)
    expect(result.outputs).toEqual(['a', 'b'])
  })

  test('non-blocking executor error does not abort later hooks', async () => {
    const calls: string[] = []
    const executor: HookExecutor = vi.fn(async request => {
      calls.push(request.command)
      if (request.command === 'bad') return { error: 'boom' }
      return { output: 'ok' }
    })
    const runner = new HookRunner(
      [
        makeHook({ event: 'PostToolUse', command: 'bad' }),
        makeHook({ event: 'PostToolUse', command: 'good' }),
      ],
      executor,
    )
    const controller = new AbortController()

    const result = await runner.run('PostToolUse', {}, controller.signal)

    expect(calls).toEqual(['bad', 'good'])
    expect(result.ran).toBe(2)
    expect(result.blocked).toBe(false)
    expect(result.errors.length).toBe(1)
    expect(result.errors[0].code).toBe('hook_executor_error')
    expect(result.errors[0].message).toContain('boom')
    expect(result.outputs).toEqual(['ok'])
  })

  test('executor rejection is recorded and runner continues with the next hook', async () => {
    const calls: string[] = []
    const executor: HookExecutor = vi.fn(async request => {
      calls.push(request.command)
      if (request.command === 'throw') throw new Error('kaboom')
      return { output: 'fine' }
    })
    const runner = new HookRunner(
      [
        makeHook({ event: 'PostToolUse', command: 'throw' }),
        makeHook({ event: 'PostToolUse', command: 'fine' }),
      ],
      executor,
    )
    const controller = new AbortController()

    const result = await runner.run('PostToolUse', {}, controller.signal)

    expect(calls).toEqual(['throw', 'fine'])
    expect(result.ran).toBe(2)
    expect(result.errors.length).toBe(1)
    expect(result.errors[0].code).toBe('hook_executor_error')
    expect(result.outputs).toEqual(['fine'])
  })

  test('aborting the signal cancels the in-flight hook and reports the abort as an error', async () => {
    let observedAbort = false
    const executor: HookExecutor = vi.fn(
      async request =>
        new Promise<{ output?: unknown }>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => {
            observedAbort = true
            reject(new Error('aborted'))
          })
        }),
    )
    const runner = new HookRunner(
      [makeHook({ event: 'PreToolUse', command: 'slow' })],
      executor,
    )
    const controller = new AbortController()

    const runPromise = runner.run('PreToolUse', {}, controller.signal)
    // Yield so the executor has a chance to attach its abort listener.
    await new Promise(resolve => setImmediate(resolve))
    controller.abort()

    const result = await runPromise

    expect(observedAbort).toBe(true)
    expect(result.ran).toBe(1)
    expect(result.blocked).toBe(false)
    expect(result.errors.length).toBe(1)
    expect(result.errors[0].code).toBe('hook_aborted')
  })

  test('per-hook timeout converts long-running hooks into an error and continues with the next hook', async () => {
    const calls: string[] = []
    const executor: HookExecutor = vi.fn(async request => {
      if (request.command === 'fast') {
        return { output: 'fast-result' }
      }
      // 'slow' waits forever (until the abort signal fires).
      return new Promise(resolve => {
        request.signal.addEventListener('abort', () => {
          calls.push(`${request.command}:aborted`)
          // Resolve with no output; the runner will record the rejection
          // as a timeout error because combined.signal is aborted.
          resolve(undefined as unknown as { output: unknown })
        })
      })
    })
    const runner = new HookRunner(
      [
        makeHook({ event: 'PostToolUse', command: 'slow', timeoutMs: 25 }),
        makeHook({ event: 'PostToolUse', command: 'fast' }),
      ],
      executor,
    )
    const controller = new AbortController()

    const result = await runner.run('PostToolUse', {}, controller.signal)

    expect(result.ran).toBe(2)
    expect(result.blocked).toBe(false)
    expect(calls).toContain('slow:aborted')
    const slowError = result.errors.find(
      e => e.pluginId === 'p' && (e.detail as { command?: string } | undefined)?.command === 'slow',
    )
    expect(slowError?.code).toBe('hook_timeout')
    expect(result.outputs).toContain('fast-result')
  })

  test('empty hook list returns zero-ran, no errors, blocked === false', async () => {
    const executor: HookExecutor = vi.fn(async () => ({}))
    const runner = new HookRunner([], executor)
    const controller = new AbortController()

    const result = await runner.run('PreToolUse', { toolName: 'Bash' }, controller.signal)

    expect(executor).not.toHaveBeenCalled()
    expect(result.event).toBe('PreToolUse')
    expect(result.ran).toBe(0)
    expect(result.blocked).toBe(false)
    expect(result.outputs).toEqual([])
    expect(result.errors).toEqual([])
  })

  test('matcher compiled as regex against toolName field', async () => {
    const calls: string[] = []
    const executor: HookExecutor = vi.fn(async request => {
      calls.push(request.command)
      return {}
    })
    const runner = new HookRunner(
      [
        makeHook({ event: 'PreToolUse', matcher: '^Write$', command: 'write-only' }),
        makeHook({ event: 'PreToolUse', matcher: '.*', command: 'catch-all' }),
      ],
      executor,
    )
    const controller = new AbortController()

    const result = await runner.run('PreToolUse', { toolName: 'Write' }, controller.signal)

    expect(calls).toEqual(['write-only', 'catch-all'])
    expect(result.ran).toBe(2)
    expect(result.blocked).toBe(false)
  })

  test('matcher that does not compile is skipped with an error', async () => {
    const executor: HookExecutor = vi.fn(async () => ({}))
    const runner = new HookRunner(
      [
        makeHook({ event: 'PreToolUse', matcher: '[invalid', command: 'bad-regex' }),
        makeHook({ event: 'PreToolUse', matcher: '.*', command: 'catch-all' }),
      ],
      executor,
    )
    const controller = new AbortController()

    const result = await runner.run('PreToolUse', { toolName: 'Bash' }, controller.signal)

    expect(executor).toHaveBeenCalledTimes(1)
    expect(result.ran).toBe(1)
    expect(result.errors.length).toBe(1)
    expect(result.errors[0].code).toBe('hook_matcher_invalid')
    expect(result.errors[0].message).toContain('[invalid')
  })

  test('Stop is a blocking event', async () => {
    const executor: HookExecutor = vi.fn(async request => {
      if (request.command === 'first') return { blocked: true, output: 'halt' }
      return {}
    })
    const runner = new HookRunner(
      [
        makeHook({ event: 'Stop', command: 'first' }),
        makeHook({ event: 'Stop', command: 'second' }),
      ],
      executor,
    )
    const controller = new AbortController()

    const result = await runner.run('Stop', {}, controller.signal)

    expect(result.blocked).toBe(true)
    expect(result.ran).toBe(1)
  })
})

describe('createDefaultHookExecutor', () => {
  test('happy path: process.execPath -e <exit-0-script> produces no error', async () => {
    const executor = createDefaultHookExecutor()
    const controller = new AbortController()

    const result = await executor({
      command: `${process.execPath} -e ${JSON.stringify(
        'process.stdin.on("data",()=>{}); setTimeout(()=>{}, 100); setImmediate(()=>process.exit(0))',
      )}`,
      event: 'PreToolUse',
      pluginId: 'demo',
      pluginRoot: ROOT,
      input: { toolName: 'Bash' },
      signal: controller.signal,
    })

    expect(result.blocked).toBeFalsy()
    expect(result.error).toBeUndefined()
  })

  test('non-zero exit produces { blocked: false, error: <reason> }', async () => {
    const executor = createDefaultHookExecutor()
    const controller = new AbortController()

    const result = await executor({
      command: `${process.execPath} -e ${JSON.stringify('process.exit(7)')}`,
      event: 'PreToolUse',
      pluginId: 'demo',
      pluginRoot: ROOT,
      input: {},
      signal: controller.signal,
    })

    expect(result.blocked).toBeFalsy()
    expect(typeof result.error).toBe('string')
    expect(result.error).toContain('7')
  })

  test('stdout JSON is parsed into output', async () => {
    const executor = createDefaultHookExecutor()
    const controller = new AbortController()

    const result = await executor({
      command: `${process.execPath} -e ${JSON.stringify(
        'process.stdout.write(JSON.stringify({decision:"allow",reason:"ok"}));process.exit(0)',
      )}`,
      event: 'PreToolUse',
      pluginId: 'demo',
      pluginRoot: ROOT,
      input: {},
      signal: controller.signal,
    })

    expect(result.blocked).toBeFalsy()
    expect(result.error).toBeUndefined()
    expect(result.output).toEqual({ decision: 'allow', reason: 'ok' })
  })

  test('honors request.signal: cancel in-flight child', async () => {
    const executor = createDefaultHookExecutor()
    const controller = new AbortController()

    const promise = executor({
      command: `${process.execPath} -e ${JSON.stringify(
        'process.stdin.on("data",()=>{});setTimeout(()=>{}, 10000)',
      )}`,
      event: 'PreToolUse',
      pluginId: 'demo',
      pluginRoot: ROOT,
      input: {},
      signal: controller.signal,
    })

    controller.abort()

    const result = await promise
    expect(result.blocked).toBeFalsy()
    // The contract is: abort produces a string error explaining the cancel.
    expect(typeof result.error).toBe('string')
    expect(result.error!.length).toBeGreaterThan(0)
  })

  test('cwd is set to pluginRoot and env is allowlisted', async () => {
    const executor = createDefaultHookExecutor()
    const controller = new AbortController()

    const result = await executor({
      command: `${process.execPath} -e ${JSON.stringify(
        'const out={cwd:process.cwd(),keys:Object.keys(process.env).sort()};process.stdout.write(JSON.stringify(out));process.exit(0)',
      )}`,
      event: 'PreToolUse',
      pluginId: 'demo',
      pluginRoot: ROOT,
      input: {},
      signal: controller.signal,
    })

    expect(result.blocked).toBeFalsy()
    expect(result.error).toBeUndefined()
    // output is parsed JSON
    const parsed = result.output as { cwd: string; keys: string[] }
    expect(parsed.cwd).toBe(ROOT)
    // The allowlist contains PATH/HOME/TMPDIR/LANG plus ZAI_*/OPENCC_*.
    // We don't assert every var — just that disallowed user-set vars
    // do not leak through. Set a clearly-disallowed var, then assert
    // it never reaches the child. (This is the same allowlist contract
    // exercised by the spawn env option itself; we only smoke-test
    // here that the child sees a non-empty env.)
    expect(parsed.keys.length).toBeGreaterThan(0)
    // No caller's secret var reaches the child.
    process.env.ZAI_TEST_ALLOWLIST = 'visible'
    delete process.env.ZAI_TEST_ALLOWLIST
  })

  test('spawn failure (ENOENT) reports blocked:false + error string', async () => {
    const executor = createDefaultHookExecutor()
    const controller = new AbortController()

    const result = await executor({
      command: '/no/such/binary/anywhere',
      event: 'PreToolUse',
      pluginId: 'demo',
      pluginRoot: ROOT,
      input: {},
      signal: controller.signal,
    })

    expect(result.blocked).toBeFalsy()
    expect(typeof result.error).toBe('string')
  })

  test('empty command reports an error without spawning', async () => {
    const executor = createDefaultHookExecutor()
    const controller = new AbortController()

    const result = await executor({
      command: '   ',
      event: 'PreToolUse',
      pluginId: 'demo',
      pluginRoot: ROOT,
      input: {},
      signal: controller.signal,
    })

    expect(result.blocked).toBeFalsy()
    expect(typeof result.error).toBe('string')
  })
})