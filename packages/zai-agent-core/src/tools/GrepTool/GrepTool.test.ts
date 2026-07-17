import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'

// ============================================================================
// Module mocks — must come before importing the SUT
// ============================================================================
//
// The SUT (GrepTool.ts) loads `spawn`, `execFile`, `execFileSync` via
// top-level ESM `import`, which IS intercepted by vi.mock. We can now
// fully control:
//   - `node:child_process` → `spawn` (controls ripgrep behavior)
//                          → `execFile` (controls codesign / xattr)
//                          → `execFileSync` (controls which/where rg)
//   - `node:fs`           → `existsSync` (controls vendor path detection)
//   - `node:util`         → `promisify` (passes through, execFile stays mockable)
// `fs/promises` is used by fallbackSearch (stat/readFile/readdir) — keep real.
// ============================================================================

const spawnMock = vi.fn()
const execFileMock = vi.fn()
const execFileSyncMock = vi.fn()

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  execFile: (...args: unknown[]) => execFileMock(...args),
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}))

// Helper to invoke execFile as if it were a real callback-style fn
// (because the SUT uses promisify(execFile) and waits on the callback).
function invokeExecFileCallback(
  args: unknown[],
  result: { stdout: string; stderr: string },
  err?: Error,
) {
  const cb = args[args.length - 1]
  if (typeof cb === 'function') {
    if (err) cb(err)
    else cb(null, result)
    return
  }
  // Fallback: some call paths pass options as last arg (no callback)
  if (args.length >= 2 && typeof args[args.length - 2] === 'function') {
    const cb2 = args[args.length - 2] as Function
    if (err) cb2(err)
    else cb2(null, result)
  }
}

const existsSyncMock = vi.fn()
vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
}))

// ============================================================================
// Import SUT AFTER mocks
// ============================================================================

const { GrepTool } = await import('./GrepTool.js')

// ============================================================================
// Helpers
// ============================================================================

type SpawnHandler = {
  code?: number | string | null
  signal?: NodeJS.Signals | null
  stdout?: string
  stderr?: string
  error?: NodeJS.ErrnoException
}

/**
 * Create a fake child process that mimics Node's ChildProcess EventEmitter
 * pattern for stdout/stderr/close/error.
 */
function fakeChild(handler: SpawnHandler) {
  const child = new EventEmitter() as any
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()

  // Defer emission so callers can attach listeners first
  queueMicrotask(() => {
    if (handler.error) {
      child.emit('error', handler.error)
      return
    }
    if (handler.stdout) child.stdout.emit('data', Buffer.from(handler.stdout))
    if (handler.stderr) child.stderr.emit('data', Buffer.from(handler.stderr))
    child.emit('close', handler.code ?? null, handler.signal ?? null)
  })

  return child
}

function baseCtx(): any {
  return {
    cwd: '/work',
    env: {},
    abortSignal: new AbortController().signal,
    dataDir: '/work/.zai',
    canUseTool: async () => ({ behavior: 'allow' }),
    emitEvent: () => {},
    state: {},
  }
}

// ============================================================================
// Reset state between tests
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks()
  // Default: vendor exists → ripgrep path resolves to vendor binary
  existsSyncMock.mockReturnValue(true)
  // Default: system rg absent (which/where returns nothing / throws)
  execFileSyncMock.mockImplementation(() => {
    throw new Error('not on PATH')
  })
  // Default: execFile succeeds with empty stdout (no codesign action)
  execFileMock.mockImplementation((...args: unknown[]) =>
    invokeExecFileCallback(args, { stdout: '', stderr: '' }),
  )
  delete process.env.CLAUDE_CODE_GLOB_TIMEOUT_SECONDS
  // Default platform = darwin so vendor resolution is non-null.
  // Tests that need a different platform override this.
  Object.defineProperty(process, 'platform', { value: 'darwin', writable: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ============================================================================
// Tests
// ============================================================================

describe('GrepTool — ripgrep vendor path (1 match)', () => {
  test('vendor 命中 + 1 行匹配 → "Found 1 matches:"', async () => {
    spawnMock.mockImplementation(() =>
      fakeChild({ code: 0, stdout: 'a.js:1:foo', stderr: '' }),
    )

    const r = await GrepTool.call({ pattern: 'foo', path: '/abs' }, baseCtx())
    expect(r.isError).toBeFalsy()
    expect(r.output).toContain('Found 1 matches:')
    expect(r.output).toContain('a.js:1:foo')

    // Spawn should be called with a vendor binary path (contains 'rg-darwin')
    const cmd = spawnMock.mock.calls[0][0] as string
    expect(cmd).toContain('rg-')
    expect(cmd).not.toBe('rg')
  })
})

describe('GrepTool — fallback path', () => {
  test('vendor miss + no rg on PATH → fallback (不调 spawn)', async () => {
    // vendor doesn't exist; execFileSync (which/where) returns no rg
    existsSyncMock.mockReturnValue(false)
    execFileSyncMock.mockImplementation(() => '')

    const r = await GrepTool.call(
      { pattern: 'x', path: '/definitely-does-not-exist-xyz' },
      baseCtx(),
    )
    expect(r.isError).toBe(true)
    expect(r.output).toContain('Path not found')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  test('fallback path 无效 → "Path not found:", isError:true', async () => {
    existsSyncMock.mockReturnValue(false)
    execFileSyncMock.mockImplementation(() => '')

    const r = await GrepTool.call(
      { pattern: 'x', path: '/nonexistent' },
      baseCtx(),
    )
    expect(r.isError).toBe(true)
    expect(r.output).toContain('Path not found:')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  test('fallback 正则非法 → "Invalid regex:", isError:true', async () => {
    existsSyncMock.mockReturnValue(false)
    execFileSyncMock.mockImplementation(() => '')

    const r = await GrepTool.call({ pattern: '[', path: '/tmp' }, baseCtx())
    expect(r.isError).toBe(true)
    expect(r.output).toContain('Invalid regex:')
  })
})

describe('GrepTool — system-rg 路径 (resolveRgPathSystem)', () => {
  test('vendor miss + system rg 在 PATH → spawn 用 "rg" (非 vendor 路径)', async () => {
    // Vendor 不存在 → resolveRgPathVendor 返回 null
    existsSyncMock.mockReturnValue(false)
    // which/where 返回 /usr/bin/rg → resolveRgPathSystem 命中
    execFileSyncMock.mockImplementation(() => '/usr/bin/rg\n')
    // spawn 正常返回
    spawnMock.mockImplementation(() =>
      fakeChild({ code: 0, stdout: 'a:1:hit', stderr: '' }),
    )

    const r = await GrepTool.call({ pattern: 'x', path: '/abs' }, baseCtx())
    expect(r.isError).toBeFalsy()
    expect(r.output).toContain('Found 1 matches:')

    // 关键断言：spawn 必须用 'rg' (system 模式)，而非 vendor 二进制路径
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const cmd = spawnMock.mock.calls[0][0] as string
    expect(cmd).toBe('/usr/bin/rg')
    expect(cmd).not.toContain('rg-darwin')
    // execFileSync 必须以 which/where 方式被调用
    expect(execFileSyncMock).toHaveBeenCalledTimes(1)
    expect(execFileSyncMock.mock.calls[0][0]).toBe('which')
    expect(execFileSyncMock.mock.calls[0][1]).toEqual(['rg'])
  })

  test('vendor miss + execFileSync 抛错 → resolveRgPathSystem 返回 null → fallback', async () => {
    existsSyncMock.mockReturnValue(false)
    // 模拟 which/where 找不到 rg (抛错)
    execFileSyncMock.mockImplementation(() => {
      throw new Error('rg not found')
    })

    const r = await GrepTool.call(
      { pattern: 'x', path: '/definitely-does-not-exist-xyz' },
      baseCtx(),
    )
    expect(r.isError).toBe(true)
    expect(r.output).toContain('Path not found')
    // 没有可用 rg → spawn 完全不调用
    expect(spawnMock).not.toHaveBeenCalled()
  })

  test('win32 platform → execFileSync 用 where (非 which)', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', writable: true })
    existsSyncMock.mockReturnValue(false)
    execFileSyncMock.mockImplementation(() => 'C:\\tools\\rg.exe\n')
    spawnMock.mockImplementation(() =>
      fakeChild({ code: 0, stdout: 'a:1:hit', stderr: '' }),
    )

    const r = await GrepTool.call({ pattern: 'x', path: '/abs' }, baseCtx())
    expect(r.isError).toBeFalsy()

    expect(execFileSyncMock.mock.calls[0][0]).toBe('where')
    const cmd = spawnMock.mock.calls[0][0] as string
    expect(cmd).toBe('C:\\tools\\rg.exe')
  })
})

describe('GrepTool — spawn 错误处理', () => {
  test('ENOENT → 降级 (vendor miss → fallback)', async () => {
    // Vendor exists but spawn fails with ENOENT → resolveAllRgPaths has only
    // vendor (system rg not on PATH) → no fallback → null → fallbackSearch
    existsSyncMock.mockReturnValue(true)
    spawnMock.mockImplementation(() =>
      fakeChild({
        error: Object.assign(new Error('spawn fail'), { code: 'ENOENT' }),
      }),
    )

    const r = await GrepTool.call(
      { pattern: 'x', path: '/definitely-does-not-exist-xyz' },
      baseCtx(),
    )
    // ENOENT on vendor → loop exits → null → fallbackSearch → path not found
    expect(r.isError).toBe(true)
    expect(r.output).toContain('Path not found')
  })

  test('ENOENT 多级回退: vendor ENOENT → 试用 system rg → fallback', async () => {
    // Spec: vendor → system → fallback. 验证 system rg 也失败时落入 fallback。
    existsSyncMock.mockReturnValue(true) // vendor 存在
    execFileSyncMock.mockImplementation(() => '/usr/bin/rg\n') // system 也命中
    // 两次 spawn 都 ENOENT (vendor 和 system 都不存在/不可执行)
    spawnMock.mockImplementation(() =>
      fakeChild({
        error: Object.assign(new Error('spawn fail'), { code: 'ENOENT' }),
      }),
    )

    const r = await GrepTool.call(
      { pattern: 'x', path: '/definitely-does-not-exist-xyz' },
      baseCtx(),
    )
    // 两个 rg 都 ENOENT → loop 退出 → fallback → path not found
    expect(r.isError).toBe(true)
    expect(r.output).toContain('Path not found')
    // spawn 尝试了两次 (vendor + system)
    expect(spawnMock).toHaveBeenCalledTimes(2)
    // 第一次是 vendor 路径，第二次是 system 路径
    const firstCmd = spawnMock.mock.calls[0][0] as string
    const secondCmd = spawnMock.mock.calls[1][0] as string
    expect(firstCmd).toContain('rg-')
    expect(secondCmd).toBe('/usr/bin/rg')
  })

  test('EAGAIN 重试 (os error 11) → args 含 -j 1', async () => {
    existsSyncMock.mockReturnValue(true)
    spawnMock.mockImplementationOnce(() =>
      fakeChild({ code: 2, stderr: 'os error 11', stdout: '' }),
    )
    spawnMock.mockImplementationOnce(() =>
      fakeChild({ code: 0, stdout: 'c.js:3:retry', stderr: '' }),
    )

    const r = await GrepTool.call({ pattern: 'retry' }, baseCtx())
    expect(r.isError).toBeFalsy()
    expect(r.output).toContain('Found 1 matches:')

    expect(spawnMock).toHaveBeenCalledTimes(2)
    const retryArgs = spawnMock.mock.calls[1][1] as string[]
    expect(retryArgs).toContain('-j')
    expect(retryArgs[retryArgs.indexOf('-j') + 1]).toBe('1')
  })

  test('超时 SIGTERM → 输出 timeout 包装信息', async () => {
    existsSyncMock.mockReturnValue(true)
    spawnMock.mockImplementation(() =>
      fakeChild({
        code: null,
        signal: 'SIGTERM',
        stdout: 'partial:1:line',
        stderr: '',
      }),
    )

    const r = await GrepTool.call({ pattern: 'partial' }, baseCtx())
    expect(r.output).toContain('search may be incomplete')
    expect(r.output).toContain('timed out after')
  })

  test('buffer 溢出 ERR_CHILD_PROCESS_STDIO_MAXBUFFER → "(output truncated)"', async () => {
    existsSyncMock.mockReturnValue(true)
    const maxBufferErr = Object.assign(
      new Error('stdout maxBuffer length exceeded'),
      { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' },
    )
    spawnMock.mockImplementation(() =>
      fakeChild({
        error: maxBufferErr,
        stdout: 'x:1:line1\nx:2:line2',
        stderr: '',
      }),
    )

    const r = await GrepTool.call({ pattern: 'x' }, baseCtx())
    expect(r.output).toContain('output truncated')
  })
})

describe('GrepTool — args 构建', () => {
  test('mode=files_with_matches → args 含 --files-with-matches', async () => {
    existsSyncMock.mockReturnValue(true)
    spawnMock.mockImplementation(() =>
      fakeChild({ code: 0, stdout: 'a.js\nb.js', stderr: '' }),
    )

    await GrepTool.call(
      { pattern: 'x', output_mode: 'files_with_matches' },
      baseCtx(),
    )

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('--files-with-matches')
  })

  test('mode=count → args 含 --count', async () => {
    existsSyncMock.mockReturnValue(true)
    spawnMock.mockImplementation(() =>
      fakeChild({ code: 0, stdout: 'a.js:5', stderr: '' }),
    )

    await GrepTool.call({ pattern: 'x', output_mode: 'count' }, baseCtx())

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('--count')
  })

  test('ignore_case → args 含 -i', async () => {
    existsSyncMock.mockReturnValue(true)
    spawnMock.mockImplementation(() =>
      fakeChild({ code: 0, stdout: '', stderr: '' }),
    )

    await GrepTool.call({ pattern: 'x', ignore_case: true }, baseCtx())

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('-i')
  })

  test('glob="*.ts" → args 含 --glob *.ts', async () => {
    existsSyncMock.mockReturnValue(true)
    spawnMock.mockImplementation(() =>
      fakeChild({ code: 0, stdout: '', stderr: '' }),
    )

    await GrepTool.call({ pattern: 'x', glob: '*.ts' }, baseCtx())

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('--glob')
    expect(args).toContain('*.ts')
  })

  test('context=3 → args 含 -C 3', async () => {
    existsSyncMock.mockReturnValue(true)
    spawnMock.mockImplementation(() =>
      fakeChild({ code: 0, stdout: '', stderr: '' }),
    )

    await GrepTool.call({ pattern: 'x', context: 3 }, baseCtx())

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('-C')
    expect(args).toContain('3')
  })
})

describe('GrepTool — rg 退出码处理', () => {
  test('模式 2 (stderr) → "ripgrep error: bad regex", isError:true', async () => {
    existsSyncMock.mockReturnValue(true)
    spawnMock.mockImplementation(() =>
      fakeChild({ code: 2, stderr: 'bad regex', stdout: '' }),
    )

    const r = await GrepTool.call({ pattern: '[' }, baseCtx())
    expect(r.isError).toBe(true)
    expect(r.output).toContain('ripgrep error: bad regex')
  })

  test('模式 1 (无匹配) → "No matches"', async () => {
    existsSyncMock.mockReturnValue(true)
    spawnMock.mockImplementation(() =>
      fakeChild({ code: 1, stdout: '', stderr: '' }),
    )

    const r = await GrepTool.call({ pattern: 'nothing' }, baseCtx())
    expect(r.isError).toBeFalsy()
    expect(r.output).toBe('No matches')
  })

  test('MAX_RESULTS=200 截断 (251 行) → "Found 251+ matches (showing first 200):"', async () => {
    existsSyncMock.mockReturnValue(true)
    const lines = Array.from({ length: 251 }, (_, i) => `f.js:${i + 1}:match`).join(
      '\n',
    )
    spawnMock.mockImplementation(() =>
      fakeChild({ code: 0, stdout: lines, stderr: '' }),
    )

    const r = await GrepTool.call({ pattern: 'match' }, baseCtx())
    expect(r.output).toContain('Found 251+ matches (showing first 200):')
    // output line count = 1 header + 200 matches = 201
    const outLines = (r.output as string).split('\n')
    expect(outLines.length).toBe(201)
  })
})

describe('GrepTool — codesign (mac vs linux)', () => {
  // Now that the SUT uses top-level ESM imports for execFile, we can mock
  // codesign/xattr calls. These tests verify:
  //   1. darwin + signed ripgrep → codesign --sign - + xattr -d calls happen
  //   2. darwin + unsigned ripgrep → codesign checks but no --sign/- call
  //   3. non-darwin → codesign never invoked
  //
  // `codesignDone` is a module-level flag that flips to true after the
  // FIRST mac codesign attempt. Since `promisify(execFile)` produces
  // callback-style calls, our mock invokes the callback itself so the
  // awaited promise resolves cleanly. We re-import the module via a
  // dynamically-resolved URL to reset the module-level flag between tests.

  async function freshGrepTool() {
    vi.resetModules()
    // Use a fresh URL each time so vitest's module cache returns a new
    // copy of the module (and resets the module-level codesignDone flag).
    const url = './GrepTool.js#t=' + Math.random().toString(36).slice(2)
    const mod = await import(/* @vite-ignore */ url)
    return mod.GrepTool
  }

  test('codesign mac 已签名 (linker-signed): 触发 --sign - 和 xattr -d', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', writable: true })
    existsSyncMock.mockReturnValue(true)
    // codesign -vv -d 输出包含 "linker-signed"
    execFileMock.mockImplementation((cmd: string, args: unknown[], ...rest: unknown[]) => {
      if (cmd === 'codesign' && Array.isArray(args) && args[0] === '-vv') {
        return invokeExecFileCallback([cmd, args, ...rest], {
          stdout: 'Executable=/path/rg\nlinker-signed\n',
          stderr: '',
        })
      }
      // --sign - 或 xattr 都成功
      return invokeExecFileCallback([cmd, args, ...rest], { stdout: '', stderr: '' })
    })
    spawnMock.mockImplementation(() =>
      fakeChild({ code: 0, stdout: 'a:1:x', stderr: '' }),
    )

    const GT = await freshGrepTool()
    const r = await GT.call({ pattern: 'x', path: '/abs' }, baseCtx())
    expect(r.isError).toBeFalsy()
    expect(r.output).toContain('Found 1 matches:')

    // 验证 execFile 调用过 codesign -vv -d
    const calls = execFileMock.mock.calls.map(c => [c[0], ...(c[1] as string[])])
    const hasInspect = calls.some(
      c => c[0] === 'codesign' && c[1] === '-vv' && c[2] === '-d',
    )
    expect(hasInspect).toBe(true)

    // 验证 execFile 调用过 codesign --sign -
    const hasSign = calls.some(
      c => c[0] === 'codesign' && c[1] === '--sign' && c[2] === '-',
    )
    expect(hasSign).toBe(true)

    // 验证 execFile 调用过 xattr -d com.apple.quarantine
    const hasXattr = calls.some(
      c => c[0] === 'xattr' && c[1] === '-d' && c[2] === 'com.apple.quarantine',
    )
    expect(hasXattr).toBe(true)
  })

  test('codesign mac 未签名 (无 linker-signed): 仅检查, 不触发 --sign -', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', writable: true })
    existsSyncMock.mockReturnValue(true)
    // codesign 输出不含 linker-signed (已正确签名, 不需重新签名)
    execFileMock.mockImplementation((cmd: string, args: unknown[], ...rest: unknown[]) => {
      if (cmd === 'codesign' && Array.isArray(args) && args[0] === '-vv') {
        return invokeExecFileCallback([cmd, args, ...rest], {
          stdout: 'Executable=/path/rg\nAuthority=Apple\n',
          stderr: '',
        })
      }
      return invokeExecFileCallback([cmd, args, ...rest], { stdout: '', stderr: '' })
    })
    spawnMock.mockImplementation(() =>
      fakeChild({ code: 0, stdout: 'a:1:x', stderr: '' }),
    )

    const GT = await freshGrepTool()
    const r = await GT.call({ pattern: 'x', path: '/abs' }, baseCtx())
    expect(r.isError).toBeFalsy()
    expect(r.output).toContain('Found 1 matches:')

    const calls = execFileMock.mock.calls.map(c => [c[0], ...(c[1] as string[])])
    // 检查发生了一次
    const hasInspect = calls.some(
      c => c[0] === 'codesign' && c[1] === '-vv' && c[2] === '-d',
    )
    expect(hasInspect).toBe(true)
    // 但 --sign - 没有被调用
    const hasSign = calls.some(
      c => c[0] === 'codesign' && c[1] === '--sign' && c[2] === '-',
    )
    expect(hasSign).toBe(false)
    // xattr -d 也没有
    const hasXattr = calls.some(c => c[0] === 'xattr')
    expect(hasXattr).toBe(false)
  })

  test('codesign linux: 完全不调用 codesign/xattr, ripgrep 仍可执行', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', writable: true })
    existsSyncMock.mockReturnValue(false)
    execFileSyncMock.mockImplementation(() => '')
    spawnMock.mockImplementation(() =>
      fakeChild({ code: 0, stdout: 'a:1:x', stderr: '' }),
    )

    const GT = await freshGrepTool()
    const r = await GT.call(
      { pattern: 'x', path: '/definitely-does-not-exist-xyz' },
      baseCtx(),
    )
    // linux → vendor null → system rg 不在 PATH → fallback → path not found
    expect(r.isError).toBe(true)
    expect(r.output).toContain('Path not found')
    // 非 darwin → codesign 完全没机会被调用
    const codesignCalls = execFileMock.mock.calls.filter(
      c => c[0] === 'codesign' || c[0] === 'xattr',
    )
    expect(codesignCalls).toHaveLength(0)
  })

  test('codesign mac 但 system rg (mode=system) → codesign 跳过', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', writable: true })
    existsSyncMock.mockReturnValue(false) // vendor miss
    execFileSyncMock.mockImplementation(() => '/usr/bin/rg\n') // system 命中
    spawnMock.mockImplementation(() =>
      fakeChild({ code: 0, stdout: 'a:1:x', stderr: '' }),
    )

    const GT = await freshGrepTool()
    const r = await GT.call({ pattern: 'x', path: '/abs' }, baseCtx())
    expect(r.isError).toBeFalsy()

    // mode=system → codesignRipgrepIfNecessary 早 return, 不调用 codesign
    const codesignCalls = execFileMock.mock.calls.filter(
      c => c[0] === 'codesign' || c[0] === 'xattr',
    )
    expect(codesignCalls).toHaveLength(0)
  })
})

describe('GrepTool — timeout 配置', () => {
  test('CLAUDE_CODE_GLOB_TIMEOUT_SECONDS=60 → spawn timeout=60000', async () => {
    process.env.CLAUDE_CODE_GLOB_TIMEOUT_SECONDS = '60'
    existsSyncMock.mockReturnValue(true)
    spawnMock.mockImplementation(() =>
      fakeChild({ code: 0, stdout: 'a:1:x', stderr: '' }),
    )

    await GrepTool.call({ pattern: 'x' }, baseCtx())

    const opts = spawnMock.mock.calls[0][2]
    expect(opts.timeout).toBe(60_000)
  })
})

describe('GrepTool — path 解析', () => {
  test('absolute path → target = /abs/foo', async () => {
    existsSyncMock.mockReturnValue(true)
    spawnMock.mockImplementation(() =>
      fakeChild({ code: 0, stdout: 'a:1:x', stderr: '' }),
    )

    await GrepTool.call({ pattern: 'x', path: '/abs/foo' }, baseCtx())

    const args = spawnMock.mock.calls[0][1] as string[]
    // Last arg should be the search path
    expect(args[args.length - 1]).toBe('/abs/foo')
  })

  test('relative path → target = /work/foo', async () => {
    existsSyncMock.mockReturnValue(true)
    spawnMock.mockImplementation(() =>
      fakeChild({ code: 0, stdout: 'a:1:x', stderr: '' }),
    )

    await GrepTool.call(
      { pattern: 'x', path: './foo' },
      { ...baseCtx(), cwd: '/work' },
    )

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args[args.length - 1]).toBe('/work/foo')
  })
})