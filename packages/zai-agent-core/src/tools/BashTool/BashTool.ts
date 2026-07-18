/**
 * BashTool — zai 实现, 对标 opencc `tools/BashTool/BashTool.tsx` (1300+ 行)。
 *
 * 这是 zai 主 Bash 工具, 提供完整的 shell 命令执行能力:
 *
 * - 7 字段 schema (command / description / timeout / run_in_background /
 *   dangerouslyDisableSandbox / _dangerouslyDisableSandboxApproved / _simulatedSedEdit)
 * - 完整的 331 行 prompt (避免 cat/sed/echo, 并行调度, sleep 抑制, git 安全协议)
 * - validateInput: 阻塞 `sleep N (N≥2)` 模式
 * - checkPermissions: 只读提权 / sed 模拟 / 破坏性写入拒绝
 * - preparePermissionMatcher: 让 `Bash(git *)` 命中 `ls && git push` 中的子命令
 * - isSearchOrReadCommand: 用于 UI collapse
 * - userFacingName: sed 命令渲染为 Edit
 * - 大输出持久化 (>64MB 落 TMPDIR/zai-bash-<taskId>.txt + Read 引导)
 * - abort 语义归一化 (isAbort / abortReason / abortMessage)
 * - 后台任务系统 (bashBackgroundTracker 注册 + foreground/background 切换)
 * - sed 模拟 (applySedEdit 直接写盘, 跳过真 sed)
 * - dangerouslyDisableSandbox (用户授权后脱离 sandbox workdir 跑)
 *
 * 不实现 (zai 不消费):
 *   - renderToolUseMessage / renderToolResultMessage / renderToolUseProgressMessage
 *     等 React/ink 渲染方法 → 走 zai 现有 ToolCallBlock + zustand reducer
 *   - analytics / claude-code-hints / VS Code 通知 / file history / git tracking
 *     → 全部 stub no-op
 *   - 真实 sandbox 强制 (Seatbelt/bwrap) → ZaiSandboxManager 仅暴露配置 API,
 *     实际 enforcement 仍靠 spawn({cwd, env})
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { LegacyTool, LegacyToolContext } from '../Tool.js'
import type { SandboxConfig } from '../../runtime/types.js'
import { BashInputSchema, type BashInput } from './schema.js'
import { getSimplePrompt } from './prompt.js'
import { pickEnv } from './sandbox.js'
import { bashBackgroundTracker } from './bashTracker.js'
import { analyzeBashCommand } from './commandAnalysis.js'
import { bashToolHasPermission } from './permissions.js'
import { detectBlockedSleepPattern } from './detectBlockedSleep.js'
import { isSearchOrReadBashCommand } from './isSearchOrRead.js'
import { shouldUseSandbox } from './shouldUseSandbox.js'
import { splitCommand, baseCommand } from './commandSplitter.js'
import { applySedEdit, SedEditFileNotFoundError } from './applySedEdit.js'
import { persistShellOutputFile, appendPersistedOutputHint } from './persistShellOutput.js'
import {
  resetCwdIfOutsideProject,
  stdErrAppendShellResetMessage,
  stripEmptyLines,
  selectFailureOutput,
  interpretExitCode,
  makeBashOutput,
} from './utils.js'
import { BASH_TOOL_NAME } from './toolName.js'
import { checkDestructiveCommand } from './destructiveCommandWarning.js'

// tool_result block 的形状 (Anthropic SDK 复用类型) — 本地声明避免拉 @anthropic-ai/sdk
type ToolResultBlockParam = {
  type: 'tool_result'
  tool_use_id: string
  content: string | unknown[]
  is_error?: boolean
}

// 64MB 输出上限 — 对标 opencc MAX_PERSISTED_SHELL_OUTPUT_SIZE
const MAX_INLINE_STDOUT_CHARS = 64 * 1024 * 1024

// 2s 后向 bashBackgroundTracker 注册为可后台化任务 (opencc 同 PROGRESS_THRESHOLD_MS = 2000)
const PROGRESS_THRESHOLD_MS = 2000

// 在 assistant mode, 15s 后自动转后台 — 对标 ASSISTANT_BLOCKING_BUDGET_MS
const ASSISTANT_BLOCKING_BUDGET_MS = 15_000

export const BashTool: LegacyTool<typeof BashInputSchema, string> = {
  name: BASH_TOOL_NAME,
  description: getSimplePrompt(),
  inputSchema: BashInputSchema,

  // opencc `Tool.prompt` — 完整 331 行 prompt
  prompt: () => getSimplePrompt(),

  // opencc `Tool.description` (per-input)
  asyncDescription: async (input: BashInput) => {
    return input.description ?? 'Executes a shell command in a sandbox.'
  },

  // opencc `Tool.isConcurrencySafe` — bash 默认不安全
  isConcurrencySafe: () => false,

  // opencc `Tool.isReadOnly` — 由 checkPermissions 推导
  isReadOnly: (input: BashInput) => {
    const result = bashToolHasPermission(input)
    return result.behavior === 'allow'
  },

  // opencc `Tool.isDestructive` — 模式匹配或破坏性写入检测
  isDestructive: (input: BashInput) => {
    if (checkDestructiveCommand(input.command)) return true
    return analyzeBashCommand(input.command).hasDestructiveWrite
  },

  // opencc `Tool.validateInput` — schema 校验后, 阻塞 sleep N (N≥2)
  validateInput: async (input: BashInput) => {
    const sleepPattern = detectBlockedSleepPattern(input.command)
    if (sleepPattern !== null) {
      return {
        result: false,
        message: `Blocked: ${sleepPattern}. Run blocking commands in the background with run_in_background: true — you'll get a completion notification when done. For streaming events (watching logs, polling APIs), use the Monitor tool. If you genuinely need a delay (rate limiting, deliberate pacing), keep it under 2 seconds.`,
        errorCode: 10,
      }
    }
    return { result: true }
  },

  // opencc `Tool.checkPermissions` — 只读提权 / sed 模拟 / 破坏性写入拒绝
  checkPermissions: async (input: BashInput) => bashToolHasPermission(input),

  // opencc `Tool.preparePermissionMatcher` — 让 hook 的 `Bash(git *)` 命中
  // 复合命令中的子命令。包括 `FOO=bar git push` 和 `ls && git push`。
  preparePermissionMatcher: async (input: BashInput) => {
    const subs = splitCommand(input.command).map((p) => baseCommand(p))
    return (pattern: string) => {
      const prefixMatch = /^(\S+)\s+\*$/.exec(pattern)
      const prefix = prefixMatch?.[1]
      if (prefix) {
        return subs.some((b) => b === prefix || b.startsWith(`${prefix} `))
      }
      const re = new RegExp(
        '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
      )
      return subs.some((b) => re.test(b))
    }
  },

  // opencc `Tool.isSearchOrReadCommand` — 用于 UI collapse
  isSearchOrReadCommand: (input: BashInput) => {
    const parsed = BashInputSchema.safeParse(input)
    if (!parsed.success) return { isSearch: false, isRead: false }
    return isSearchOrReadBashCommand(parsed.data.command)
  },

  // opencc `Tool.toAutoClassifierInput` — auto-mode 安全分类器输入
  toAutoClassifierInput: (input: BashInput) => input.command,

  // opencc `Tool.userFacingName` — sed 命令渲染为 Edit
  userFacingName: (input: BashInput) => {
    if (input?.command && /^sed\s+(.*\s)?-i\b/.test(input.command)) {
      return 'FileEdit'
    }
    return BASH_TOOL_NAME
  },

  // opencc `Tool.getToolUseSummary` — 紧凑视图
  getToolUseSummary: (input: BashInput) => {
    if (!input?.command) return null
    return input.description ?? input.command.slice(0, 80)
  },

  // opencc `Tool.getActivityDescription` — spinner 显示
  getActivityDescription: (input: BashInput) => {
    if (!input?.command) return 'Running command'
    return `Running ${input.description ?? input.command.slice(0, 80)}`
  },

  // opencc `Tool.maxResultSizeChars` — 30K 字符后落盘 (opencc 同值)
  maxResultSizeChars: 30_000,

  // opencc `Tool.mapToolResultToToolResultBlockParam` — BashTool 返回 Out 对象,
  // 这里把它格式化进 tool_result block (处理 persistedOutputPath /
  // backgroundTaskId / interrupted / sed 模拟)。
  mapToolResultToToolResultBlockParam: (content: unknown, toolUseId: string): ToolResultBlockParam => {
    if (typeof content === 'string') {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: content,
        is_error: false,
      }
    }

    const out = content as {
      stdout?: string
      stderr?: string
      interrupted?: boolean
      isAbort?: boolean
      abortMessage?: string
      backgroundTaskId?: string
      backgroundedByUser?: boolean
      assistantAutoBackgrounded?: boolean
      dangerouslyDisableSandbox?: boolean
      persistedOutputPath?: string
      persistedOutputSize?: number
      persistedOutputTruncated?: boolean
      isImage?: boolean
    }

    let stdout = typeof out.stdout === 'string' ? out.stdout : ''
    if (stdout) {
      stdout = stdout.replace(/^(\s*\n)+/, '').trimEnd()
    }

    if (out.persistedOutputPath) {
      stdout = appendPersistedOutputHint(
        stdout,
        out.persistedOutputPath,
        out.persistedOutputSize ?? 0,
        out.persistedOutputTruncated ?? false,
      )
    }

    let errorMessage = (out.stderr ?? '').trim()
    if (out.interrupted) {
      if (errorMessage) errorMessage += '\n'
      errorMessage += `<error>${out.abortMessage ?? 'Command was aborted before completion'}</error>`
    }

    let backgroundInfo = ''
    if (out.backgroundTaskId) {
      if (out.assistantAutoBackgrounded) {
        backgroundInfo = `Command exceeded the assistant-mode blocking budget (${ASSISTANT_BLOCKING_BUDGET_MS / 1000}s) and was moved to the background with ID: ${out.backgroundTaskId}. It is still running — you will be notified when it completes.`
      } else if (out.backgroundedByUser) {
        backgroundInfo = `Command was manually backgrounded by user with ID: ${out.backgroundTaskId}.`
      } else {
        backgroundInfo = `Command running in background with ID: ${out.backgroundTaskId}. It is still running — you will be notified when it completes.`
      }
    }

    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: [stdout, errorMessage, backgroundInfo].filter(Boolean).join('\n'),
      is_error: !!out.interrupted,
    }
  },

  // core call — bash 执行入口
  async call(rawInput, ctx) {
    const input = rawInput as BashInput
    const cfg = ctx.__runtimeConfig?.sandbox as SandboxConfig | undefined
    if (!cfg) {
      return { output: 'Bash disabled: no sandbox configured in RuntimeConfig', isError: true }
    }
    if (cfg.executor !== 'child_process') {
      return { output: `unsupported executor: ${cfg.executor}`, isError: true }
    }

    // sed -i 模拟 — 直接走 applySedEdit, 不跑 sh -c
    if (input._simulatedSedEdit) {
      return runSedEdit(input._simulatedSedEdit)
    }

    const analysis = analyzeBashCommand(input.command)
    const useSandbox = shouldUseSandbox(input, analysis)
    const effectiveWorkdir = useSandbox ? cfg.workdir : (ctx.cwd || process.cwd())
    const effectiveEnv = useSandbox ? pickEnv(process.env, cfg.envAllowlist) : process.env

    if (input.run_in_background) return runInBackground(input, effectiveWorkdir, effectiveEnv, ctx)

    const timeoutMs = input.timeout ?? cfg.maxCpuMs ?? 600_000

    return runForeground(input, effectiveWorkdir, effectiveEnv, timeoutMs, ctx)
  },
}

// ---------------------------------------------------------------------------
// runForeground / runInBackground / runSedEdit
// ---------------------------------------------------------------------------

/**
 * Foreground 执行: spawn `sh -c command`, 累积 stdout/stderr, 2s 后注册为
 * 可后台化, 超时或 abort 时归一化 isAbort。
 */
async function runForeground(
  input: BashInput,
  workdir: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  ctx: LegacyToolContext,
): Promise<{ output: string; isError: boolean }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let assistantAutoBackgrounded = false

    const child = spawn('sh', ['-c', input.command], {
      cwd: workdir,
      env,
      timeout: timeoutMs,
      signal: ctx.abortSignal,
    })

    const taskId = `bash-${randomUUID().slice(0, 8)}`
    const sessionId = (ctx.__runtimeConfig as { sessionId?: string } | undefined)?.sessionId ?? ''

    bashBackgroundTracker.registerForeground(taskId, {
      sessionId,
      command: input.command,
      description: input.description ?? input.command.slice(0, 60),
      startedAt: Date.now(),
      pid: child.pid ?? undefined,
    })
    bashBackgroundTracker.attachChild(taskId, child)

    // zai 不需要 setToolJSX (无 JSX UI); 2s 后标记 task 已在 tracker 中。
    // 后续若 user UI 加入 streaming 进度展示, 在这里调用 setToolJSX。

    // 15s 后自动后台化 (assistant 模式)
    const assistantBgTimer = setTimeout(() => {
      if (!settled && child.exitCode === null) {
        if (bashBackgroundTracker.backgroundExistingForegroundTask(taskId)) {
          assistantAutoBackgrounded = true
        }
      }
    }, ASSISTANT_BLOCKING_BUDGET_MS)

    const finish = (result: { output: string; isError: boolean }) => {
      if (settled) return
      settled = true
      clearTimeout(assistantBgTimer)
      bashBackgroundTracker.unregisterForeground(taskId)
      resolve(result)
    }

    child.stdout?.on('data', (d) => {
      const text = d.toString()
      stdout += text
      bashBackgroundTracker.appendOutput(taskId, { stdout: text })
    })
    child.stderr?.on('data', (d) => {
      const text = d.toString()
      stderr += text
      bashBackgroundTracker.appendOutput(taskId, { stderr: text })
    })

    child.on('close', async (code, signal) => {
      bashBackgroundTracker.markFinished(
        taskId,
        code === 0 ? 'completed' : 'failed',
        { exitCode: code ?? undefined, signal: signal ?? undefined },
      )

      if (resetCwdIfOutsideProject()) {
        stderr = stdErrAppendShellResetMessage(stderr)
      }

      let persistedOutputPath: string | undefined
      let persistedOutputSize: number | undefined
      let persistedOutputTruncated: boolean | undefined
      if (stdout.length > MAX_INLINE_STDOUT_CHARS) {
        const persisted = await persistShellOutputFile(undefined, taskId, stdout)
        if (persisted) {
          persistedOutputPath = persisted.path
          persistedOutputSize = persisted.size
          persistedOutputTruncated = persisted.truncated
          stdout = appendPersistedOutputHint(stdout, persisted.path, persisted.size, persisted.truncated)
          bashBackgroundTracker.setPersistedOutputPath(taskId, persisted.path)
        }
      }

      // 同时构造 legacy 字符串格式 (`<stdout>...</stdout>` / `<stderr>...</stderr>` /
      // `exit code: N`), 让 zai 现有 transcript 渲染 / 老测试契约保持兼容。
      const legacyStdoutText = stdout.trim()
      const legacyStderrText = stderr.trim()
      const legacyText = [
        legacyStdoutText && `<stdout>${legacyStdoutText}</stdout>`,
        legacyStderrText && `<stderr>${legacyStderrText}</stderr>`,
        `exit code: ${code ?? signal ?? 'unknown'}`,
      ].filter(Boolean).join('\n')

      if (code !== 0 || signal) {
        const failureBody = selectFailureOutput(legacyText, stdout, '')
        const out = makeBashOutput({
          stdout: failureBody,
          stderr,
          interrupted: !!signal,
          abortReason: signal ? 'process_killed' : undefined,
          abortMessage: signal ? `Process killed by signal ${signal}` : undefined,
          isAbort: !!signal,
          backgroundedByUser: false,
          assistantAutoBackgrounded,
          dangerouslyDisableSandbox: input.dangerouslyDisableSandbox,
          returnCodeInterpretation: interpretExitCode(input.command, code ?? -1),
          persistedOutputPath,
          persistedOutputSize,
          persistedOutputTruncated,
        })
        return finish({ output: JSON.stringify(out), isError: code !== 0 })
      }

      const out = makeBashOutput({
        stdout: stripEmptyLines(legacyText),
        stderr,
        interrupted: false,
        backgroundedByUser: false,
        assistantAutoBackgrounded,
        dangerouslyDisableSandbox: input.dangerouslyDisableSandbox,
        returnCodeInterpretation: undefined,
        noOutputExpected: false,
        persistedOutputPath,
        persistedOutputSize,
        persistedOutputTruncated,
      })
      finish({ output: JSON.stringify(out), isError: false })
    })

    child.on('error', (err) => {
      bashBackgroundTracker.markFinished(taskId, 'failed', { signal: 'SIGKILL' })
      finish({
        output: `spawn error: ${err.message}`,
        isError: true,
      })
    })

    if (ctx.abortSignal) {
      ctx.abortSignal.addEventListener('abort', () => {
        // 子进程已由 spawn({signal}) 自动 kill, 等待 close 事件归一化
      }, { once: true })
    }
  })
}

/**
 * 后台执行: 立即返回 taskId, 不等子进程退出。
 */
function runInBackground(
  input: BashInput,
  workdir: string,
  env: NodeJS.ProcessEnv,
  ctx: LegacyToolContext,
): { output: string; isError: boolean } {
  const taskId = `bash-${randomUUID().slice(0, 8)}`
  const sessionId = (ctx.__runtimeConfig as { sessionId?: string } | undefined)?.sessionId ?? ''

  const child = spawn('sh', ['-c', input.command], {
    cwd: workdir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  bashBackgroundTracker.register(taskId, {
    sessionId,
    command: input.command,
    description: input.description ?? input.command.slice(0, 60),
    startedAt: Date.now(),
    pid: child.pid ?? undefined,
  })
  // run_in_background:true 是显式后台化 (opencc LocalShellTask.spawnShellTask 走 backgrounded 路径)
  bashBackgroundTracker.backgroundExistingForegroundTask(taskId)
  bashBackgroundTracker.attachChild(taskId, child)

  // 向后兼容: 同时写到 ctx.state.background_tasks Map (legacy 测试契约)
  const tasks = ((ctx.state.background_tasks ??= new Map<string, unknown>()) as Map<string, unknown>)
  tasks.set(taskId, {
    taskId,
    pid: child.pid ?? -1,
    description: input.description ?? input.command.slice(0, 60),
    startedAt: Date.now(),
    stdout: '',
    stderr: '',
    status: 'running',
    child,
  })

  child.stdout?.on('data', (d) => {
    const text = d.toString()
    bashBackgroundTracker.appendOutput(taskId, { stdout: text })
  })
  child.stderr?.on('data', (d) => {
    const text = d.toString()
    bashBackgroundTracker.appendOutput(taskId, { stderr: text })
  })
  child.on('close', (code, signal) => {
    bashBackgroundTracker.markFinished(
      taskId,
      code === 0 ? 'completed' : 'failed',
      { exitCode: code ?? undefined, signal: signal ?? undefined },
    )
    void (async () => {
      const task = bashBackgroundTracker.get(taskId)
      if (task && task.stdout.length > MAX_INLINE_STDOUT_CHARS) {
        const persisted = await persistShellOutputFile(undefined, taskId, task.stdout)
        if (persisted) {
          bashBackgroundTracker.setPersistedOutputPath(taskId, persisted.path)
        }
      }
    })()
  })

  return {
    output: `<task_id>${taskId}</task_id>\n<status>running</status>\n<description>${input.description ?? input.command.slice(0, 60)}</description>`,
    isError: false,
  }
}

/** sed -i 模拟执行 — 直接写盘, 不跑 sed。 */
async function runSedEdit(
  edit: { filePath: string; newContent: string },
): Promise<{ output: string; isError: boolean }> {
  try {
    const result = await applySedEdit(edit)
    return {
      output: JSON.stringify(makeBashOutput({
        stdout: result.stdout,
        stderr: result.stderr,
        interrupted: false,
      })),
      isError: false,
    }
  } catch (err) {
    if (err instanceof SedEditFileNotFoundError) {
      return {
        output: JSON.stringify(makeBashOutput({
          stdout: '',
          stderr: err.message + '\nExit code 1',
          interrupted: false,
        })),
        isError: true,
      }
    }
    return {
      output: `sed edit error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    }
  }
}

// 占位 — 防止 PROGRESS_THRESHOLD_MS unused warning (留作未来 streaming UI 接入用)
void PROGRESS_THRESHOLD_MS