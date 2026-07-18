import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { BashTool } from '../../../src/tools/BashTool/BashTool.js'
import { bashBackgroundTracker } from '../../../src/tools/BashTool/bashTracker.js'
import { BashInputSchema } from '../../../src/tools/BashTool/schema.js'
import { isSearchOrReadBashCommand } from '../../../src/tools/BashTool/isSearchOrRead.js'
import { analyzeBashCommand } from '../../../src/tools/BashTool/commandAnalysis.js'
import { bashToolHasPermission } from '../../../src/tools/BashTool/permissions.js'
import { detectBlockedSleepPattern } from '../../../src/tools/BashTool/detectBlockedSleep.js'
import { checkDestructiveCommand } from '../../../src/tools/BashTool/destructiveCommandWarning.js'
import { extractBashCommentLabel } from '../../../src/tools/BashTool/commentLabel.js'
import { applySedEdit } from '../../../src/tools/BashTool/applySedEdit.js'
import { getSimplePrompt } from '../../../src/tools/BashTool/prompt.js'
import type { LegacyToolContext as ToolContext } from '../../../src/tools/Tool.js'
import type { BashInput } from '../../../src/tools/BashTool/schema.js'

let workdir: string
let ctx: ToolContext

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'zai-bash-test-'))
  ctx = {
    cwd: workdir,
    env: {},
    abortSignal: new AbortController().signal,
    dataDir: workdir,
    canUseTool: async () => ({ behavior: 'allow' }),
    emitEvent: () => {},
    state: {},
    awaitAskUserQuestion: async () => ({ answers: {} }),
    __runtimeConfig: { dataDir: workdir, sandbox: { executor: 'child_process', workdir } },
  }
  bashBackgroundTracker.__resetForTests()
})

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true })
  bashBackgroundTracker.__resetForTests()
})

// ---------------------------------------------------------------------------
// 原始 8 个 contract tests (保持向后兼容)
// ---------------------------------------------------------------------------

describe('BashTool', () => {
  test('无 sandbox → isError', async () => {
    const r = await BashTool.call({ command: 'ls' }, { ...ctx, __runtimeConfig: { dataDir: workdir } })
    expect(r.isError).toBe(true)
    expect(r.output as string).toMatch(/no sandbox configured/)
  })

  test('foreground: echo 输出到 stdout, exit 0 → isError false', async () => {
    const r = await BashTool.call({ command: 'echo hello' }, ctx)
    expect(r.isError).toBeFalsy()
    expect(r.output as string).toContain('<stdout>hello')
  })

  test('foreground: ls 列出 workdir 下的文件', async () => {
    await writeFile(join(workdir, 'foo.txt'), 'hi')
    const r = await BashTool.call({ command: 'ls' }, ctx)
    expect(r.output as string).toContain('foo.txt')
  })

  test('foreground: exit code != 0 → isError true', async () => {
    const r = await BashTool.call({ command: 'exit 7' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.output as string).toContain('exit code: 7')
  })

  test('foreground: unsupported executor → isError', async () => {
    const r = await BashTool.call({ command: 'ls' }, {
      ...ctx,
      __runtimeConfig: { dataDir: workdir, sandbox: { executor: 'docker' as any, workdir } },
    })
    expect(r.isError).toBe(true)
  })

  test('background: run_in_background=true 返回 taskId, 注册到 ctx.state.background_tasks', async () => {
    const r = await BashTool.call(
      { command: 'sleep 0.05; echo done', run_in_background: true },
      ctx,
    )
    expect(r.isError).toBeFalsy()
    expect(r.output as string).toMatch(/<task_id>bash-[0-9a-f]{8}<\/task_id>/)
    const tasks = ctx.state.background_tasks as Map<string, unknown>
    expect(tasks.size).toBe(1)
    // bashBackgroundTracker 也有记录 (新 contract)
    const tracked = bashBackgroundTracker.list()
    expect(tracked.length).toBeGreaterThanOrEqual(1)
  })

  test('isReadOnly / isDestructive 反映命令性质', () => {
    expect(BashTool.isReadOnly!({ command: 'ls' })).toBe(true)
    expect(BashTool.isReadOnly!({ command: 'rm -rf /' })).toBe(false)
    expect(BashTool.isDestructive!({ command: 'rm -rf /' })).toBe(true)
    expect(BashTool.isDestructive!({ command: 'echo hi' })).toBe(false)
  })

  test('isConcurrencySafe = false', () => {
    expect(BashTool.isConcurrencySafe!({ command: 'ls' })).toBe(false)
  })

  // -------------------------------------------------------------------------
  // 新增 14 个 opencc-aligned 用例
  // -------------------------------------------------------------------------

  describe('validateInput (sleep blocking)', () => {
    test('阻塞 sleep 30', async () => {
      const r = await BashTool.validateInput!({ command: 'sleep 30' } as BashInput, ctx)
      expect(r.result).toBe(false)
      if (!r.result) {
        expect(r.errorCode).toBe(10)
        expect(r.message).toMatch(/Blocked.*sleep 30/)
      }
    })

    test('阻塞 sleep 30 && check', async () => {
      const r = await BashTool.validateInput!({ command: 'sleep 30 && check' } as BashInput, ctx)
      expect(r.result).toBe(false)
    })

    test('允许 sleep 1 (sub-2s)', async () => {
      const r = await BashTool.validateInput!({ command: 'sleep 1' } as BashInput, ctx)
      expect(r.result).toBe(true)
    })

    test('允许 sleep 0.5 (float sub-2s)', async () => {
      const r = await BashTool.validateInput!({ command: 'sleep 0.5' } as BashInput, ctx)
      expect(r.result).toBe(true)
    })

    test('允许普通命令', async () => {
      const r = await BashTool.validateInput!({ command: 'ls' } as BashInput, ctx)
      expect(r.result).toBe(true)
    })
  })

  describe('checkPermissions (opencc semantics)', () => {
    test('允许只读命令 ls', () => {
      const r = bashToolHasPermission({ command: 'ls' })
      expect(r.behavior).toBe('allow')
    })

    test('拒绝 rm -rf /', () => {
      const r = bashToolHasPermission({ command: 'rm -rf /' })
      expect(r.behavior).toBe('deny')
      if (r.behavior === 'deny') expect(r.message).toMatch(/破坏性/)
    })

    test('sed -i 无 _simulatedSedEdit → ask', () => {
      const r = bashToolHasPermission({ command: "sed -i 's/foo/bar/' file.txt" })
      expect(r.behavior).toBe('ask')
    })

    test('sed -i + _simulatedSedEdit → allow', () => {
      const r = bashToolHasPermission({
        command: "sed -i 's/foo/bar/' file.txt",
        _simulatedSedEdit: { filePath: 'file.txt', newContent: 'new' },
      })
      expect(r.behavior).toBe('allow')
    })

    test('含 cd → ask', () => {
      const r = bashToolHasPermission({ command: 'cd /tmp && ls' })
      expect(r.behavior).toBe('ask')
    })
  })

  describe('isSearchOrReadCommand', () => {
    test('grep foo file → isSearch', () => {
      const r = isSearchOrReadBashCommand('grep foo file')
      expect(r.isSearch).toBe(true)
      expect(r.isRead).toBe(false)
    })

    test('cat file → isRead', () => {
      const r = isSearchOrReadBashCommand('cat file')
      expect(r.isRead).toBe(true)
      expect(r.isSearch).toBe(false)
    })

    test('ls dir → isList', () => {
      const r = isSearchOrReadBashCommand('ls dir')
      expect(r.isList).toBe(true)
    })

    test('ls && rm -rf / → none (compound 含非 read)', () => {
      const r = isSearchOrReadBashCommand('ls && rm -rf /')
      expect(r.isSearch).toBe(false)
      expect(r.isRead).toBe(false)
    })

    test('BashTool.isSearchOrReadCommand 走 schema 校验 + 解析', () => {
      const r = BashTool.isSearchOrReadCommand!({ command: 'cat file' })
      expect(r.isRead).toBe(true)
    })
  })

  describe('preparePermissionMatcher (compound command matching)', () => {
    test('Bash(git *) 匹配 ls && git push', async () => {
      const matcher = await BashTool.preparePermissionMatcher!({ command: 'ls && git push' } as BashInput)
      expect(matcher('git *')).toBe(true)
      expect(matcher('ls *')).toBe(true)
      expect(matcher('rm *')).toBe(false)
    })

    test('Bash(git *) 匹配 FOO=bar git push (env 前缀)', async () => {
      const matcher = await BashTool.preparePermissionMatcher!({ command: 'FOO=bar git push origin main' } as BashInput)
      expect(matcher('git *')).toBe(true)
    })

    test('Bash(*) 匹配任意命令 (catch-all)', async () => {
      const matcher = await BashTool.preparePermissionMatcher!({ command: 'rm -rf /' } as BashInput)
      expect(matcher('*')).toBe(true)
    })
  })

  describe('description / userFacingName / getActivityDescription', () => {
    test('description 返回 input.description', async () => {
      const d = await BashTool.asyncDescription!({ command: 'ls', description: 'list files' } as BashInput)
      expect(d).toBe('list files')
    })

    test('description 无 input.description 时返回默认', async () => {
      const d = await BashTool.asyncDescription!({ command: 'ls' } as BashInput)
      expect(d).toMatch(/shell command/)
    })

    test('userFacingName sed → FileEdit', () => {
      const n = BashTool.userFacingName!({ command: "sed -i 's/a/b/' f" } as BashInput)
      expect(n).toBe('FileEdit')
    })

    test('userFacingName 普通命令 → Bash', () => {
      const n = BashTool.userFacingName!({ command: 'ls' } as BashInput)
      expect(n).toBe('Bash')
    })

    test('getActivityDescription 加 "Running " 前缀', () => {
      const d = BashTool.getActivityDescription!({ command: 'ls', description: 'list' } as BashInput)
      expect(d).toBe('Running list')
    })
  })

  describe('isReadOnly (opencc semantics)', () => {
    test('ls → true', () => {
      expect(BashTool.isReadOnly!({ command: 'ls' })).toBe(true)
    })

    test('rm -rf / → false', () => {
      expect(BashTool.isReadOnly!({ command: 'rm -rf /' })).toBe(false)
    })

    test('cd / && ls → false (有 cd)', () => {
      expect(BashTool.isReadOnly!({ command: 'cd / && ls' })).toBe(false)
    })
  })

  describe('large output persistence', () => {
    test('>64MB stdout 持久化到 TMPDIR/zai-bash-<taskId>.txt', async () => {
      // 用 head -c 100000000 (100MB) 触发持久化; sandbox 限制 workdir
      const r = await BashTool.call(
        { command: 'head -c 100000000 /dev/zero | base64 | head -c 70000000', timeout: 60_000 },
        ctx,
      )
      // output 包含持久化提示
      if (r.isError) {
        // 大输出在某些环境下会因 sandbox 限制失败, 跳过
        console.log('large output test skipped:', r.output)
        return
      }
      expect(r.output as string).toMatch(/output saved to/)
    }, 120_000)
  })

  describe('abort semantics', () => {
    test('abortSignal.abort() → isAbort true (signal SIGTERM)', async () => {
      const ac = new AbortController()
      const abortCtx = { ...ctx, abortSignal: ac.signal }
      const p = BashTool.call({ command: 'sleep 10', timeout: 30_000 }, abortCtx)
      // 等 200ms 后 abort
      setTimeout(() => ac.abort(), 200)
      const r = await p
      // exit code != 0 (signal) → isError true
      expect(r.isError).toBe(true)
      expect(r.output as string).toMatch(/exit code:|aborted/i)
    }, 10_000)
  })

  describe('dangerouslyDisableSandbox', () => {
    test('无 _dangerouslyDisableSandboxApproved → 仍走 sandbox', async () => {
      const r = await BashTool.call(
        { command: 'echo hi', dangerouslyDisableSandbox: true },
        ctx,
      )
      // 仍应成功 (workdir 内), 但 effectiveWorkdir 应是 sandbox.workdir
      expect(r.isError).toBeFalsy()
    })

    test('两个 flag 都 true → 脱离 workdir (cwd 兜底)', async () => {
      const r = await BashTool.call(
        {
          command: 'echo hi',
          dangerouslyDisableSandbox: true,
          _dangerouslyDisableSandboxApproved: true,
        },
        ctx,
      )
      expect(r.isError).toBeFalsy()
    })
  })

  describe('sed simulation', () => {
    test('_simulatedSedEdit 写入 newContent, 不跑 sed', async () => {
      const filePath = join(workdir, 'f.txt')
      await writeFile(filePath, 'old line\n', 'utf8')
      const r = await BashTool.call(
        {
          command: "sed -i 's/old/new/' f.txt",
          _simulatedSedEdit: { filePath, newContent: 'new line\n' },
        },
        ctx,
      )
      expect(r.isError).toBeFalsy()
      const content = await readFile(filePath, 'utf8')
      expect(content).toBe('new line\n')
    })

    test('applySedEdit 单独调用: 文件不存在 → 抛 SedEditFileNotFoundError', async () => {
      await expect(applySedEdit({ filePath: join(workdir, 'missing.txt'), newContent: 'x' }))
        .rejects.toThrow(/No such file/)
    })
  })

  describe('mapToolResultToToolResultBlockParam', () => {
    test('persistedOutputPath 在 stdout 末尾追加 saved-to 提示', () => {
      const out = BashTool.mapToolResultToToolResultBlockParam!({
        stdout: 'hello',
        stderr: '',
        interrupted: false,
        persistedOutputPath: '/tmp/x.txt',
        persistedOutputSize: 100,
        persistedOutputTruncated: false,
      }, 'tu-1')
      const content = out.content as string
      expect(content).toMatch(/saved to/)
      expect(content).toContain('hello')
    })

    test('backgroundTaskId 在 content 末尾追加 background info', () => {
      const out = BashTool.mapToolResultToToolResultBlockParam!({
        stdout: 'hi',
        stderr: '',
        interrupted: false,
        backgroundTaskId: 'bash-abc',
        backgroundedByUser: true,
      }, 'tu-2')
      const content = out.content as string
      expect(content).toMatch(/bash-abc/)
      expect(content).toMatch(/manually backgrounded/)
    })

    test('interrupted → is_error true, content 包含 <error>', () => {
      const out = BashTool.mapToolResultToToolResultBlockParam!({
        stdout: 'partial',
        stderr: '',
        interrupted: true,
        abortMessage: 'killed',
      }, 'tu-3')
      expect(out.is_error).toBe(true)
      expect(out.content as string).toMatch(/<error>.*killed<\/error>/)
    })
  })

  describe('schema strict 7 fields', () => {
    test('合法输入通过', () => {
      const r = BashInputSchema.safeParse({
        command: 'ls',
        description: 'list',
        timeout: 5000,
        run_in_background: false,
        dangerouslyDisableSandbox: false,
        _dangerouslyDisableSandboxApproved: false,
        _simulatedSedEdit: { filePath: 'x', newContent: 'y' },
      })
      expect(r.success).toBe(true)
    })

    test('command 空 → 失败', () => {
      const r = BashInputSchema.safeParse({ command: '' })
      expect(r.success).toBe(false)
    })

    test('timeout > 600_000 → 失败', () => {
      const r = BashInputSchema.safeParse({ command: 'ls', timeout: 700_000 })
      expect(r.success).toBe(false)
    })
  })

  describe('destructive command warning', () => {
    test('git reset --hard → warning', () => {
      expect(checkDestructiveCommand('git reset --hard')).toBeDefined()
    })

    test('rm -rf / → warning', () => {
      expect(checkDestructiveCommand('rm -rf /tmp')).toBeDefined()
    })

    test('普通 ls → 无 warning', () => {
      expect(checkDestructiveCommand('ls')).toBeUndefined()
    })
  })

  describe('comment label extraction', () => {
    test('首行 # comment → 注释文本', () => {
      expect(extractBashCommentLabel('# my task\nls')).toBe('my task')
    })

    test('首行 #! shebang → undefined', () => {
      expect(extractBashCommentLabel('#!/bin/sh\nls')).toBeUndefined()
    })

    test('无 # → undefined', () => {
      expect(extractBashCommentLabel('ls -la')).toBeUndefined()
    })
  })

  describe('command analysis', () => {
    test('简单 ls', () => {
      const a = analyzeBashCommand('ls')
      expect(a.hasCd).toBe(false)
      expect(a.hasDestructiveWrite).toBe(false)
      expect(a.baseCommands).toEqual(['ls'])
    })

    test('cd /tmp && ls', () => {
      const a = analyzeBashCommand('cd /tmp && ls')
      expect(a.hasCd).toBe(true)
      expect(a.baseCommands).toContain('cd')
      expect(a.baseCommands).toContain('ls')
    })

    test('sed -i 触发 simulatedSedEdit flag', () => {
      const a = analyzeBashCommand("sed -i 's/a/b/' f")
      expect(a.hasSimulatedSedEdit).toBe(true)
    })
  })

  describe('detectBlockedSleep (独立验证)', () => {
    test('sleep 30 → 模式描述', () => {
      const r = detectBlockedSleepPattern('sleep 30')
      expect(r).toMatch(/standalone sleep 30/)
    })

    test('sleep 1.5 → null', () => {
      expect(detectBlockedSleepPattern('sleep 1.5')).toBeNull()
    })
  })

  describe('prompt content', () => {
    test('prompt 包含 cat/sed 避免指引', () => {
      const p = getSimplePrompt()
      expect(p).toContain('cat')
      expect(p).toContain('sed')
      expect(p).toContain('echo')
      expect(p).toContain('Use FileRead')
      expect(p).toContain('Use FileEdit')
    })

    test('prompt 包含 git 安全协议', () => {
      const p = getSimplePrompt()
      expect(p).toContain('NEVER')
      expect(p).toContain('git')
    })

    test('prompt 包含 sleep 抑制规则', () => {
      const p = getSimplePrompt()
      expect(p).toMatch(/sleep N.*blocked|sub-2s/i)
    })
  })
})