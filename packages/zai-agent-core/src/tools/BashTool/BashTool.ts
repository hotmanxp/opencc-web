import { z } from 'zod'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { LegacyTool, LegacyToolContext as ToolContext } from '../Tool.js'
import type { SandboxConfig } from '../../runtime/types.js'
import { renderPrompt } from './prompt.js'
import { BashInputSchema } from './schema.js'
import { pickEnv, isReadOnlyCommand, isDestructiveCommand, type BackgroundTask } from './sandbox.js'

const MAX_BUFFER = 10 * 1024 * 1024

export const BashTool: LegacyTool<typeof BashInputSchema, string> = {
  name: 'Bash',
  description: renderPrompt(),
  inputSchema: BashInputSchema,
  isConcurrencySafe: () => false,
  isReadOnly: (input) => isReadOnlyCommand((input as z.infer<typeof BashInputSchema>).command),
  isDestructive: (input) => isDestructiveCommand((input as z.infer<typeof BashInputSchema>).command),

  async call(rawInput, ctx) {
    const input = rawInput as z.infer<typeof BashInputSchema>
    const cfg = ctx.__runtimeConfig?.sandbox
    if (!cfg) return { output: 'Bash disabled: no sandbox configured in RuntimeConfig', isError: true }
    if (cfg.executor !== 'child_process') {
      return { output: `unsupported executor: ${cfg.executor}`, isError: true }
    }
    if (input.run_in_background) return runInBackground(input, cfg, ctx)
    return runForeground(input, cfg, ctx)
  },
}

function runForeground(
  input: z.infer<typeof BashInputSchema>,
  cfg: SandboxConfig,
  ctx: ToolContext,
): Promise<{ output: string; isError: boolean }> {
  return new Promise(resolve => {
    const child = spawn('sh', ['-c', input.command], {
      cwd: cfg.workdir,
      env: pickEnv(process.env, cfg.envAllowlist),
      timeout: input.timeout ?? cfg.maxCpuMs ?? 600_000,
      signal: ctx.abortSignal,
    })
    let stdout = '', stderr = ''
    child.stdout?.on('data', d => { stdout += d.toString() })
    child.stderr?.on('data', d => { stderr += d.toString() })
    child.on('close', (code, signal) => {
      const output = [
        stdout && `<stdout>${truncate(stdout)}</stdout>`,
        stderr && `<stderr>${truncate(stderr)}</stderr>`,
        `exit code: ${code ?? signal ?? 'unknown'}`,
      ].filter(Boolean).join('\n')
      resolve({ output, isError: code !== 0 })
    })
    child.on('error', err => resolve({ output: `spawn error: ${err.message}`, isError: true }))
  })
}

function runInBackground(
  input: z.infer<typeof BashInputSchema>,
  cfg: SandboxConfig,
  ctx: ToolContext,
): { output: string; isError: boolean } {
  const taskId = `bash-${randomUUID().slice(0, 8)}`
  const child = spawn('sh', ['-c', input.command], {
    cwd: cfg.workdir,
    env: pickEnv(process.env, cfg.envAllowlist),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const tasks = ((ctx.state.background_tasks ??= new Map<string, BackgroundTask>()) as Map<string, BackgroundTask>)
  const task: BackgroundTask = {
    taskId, pid: child.pid ?? -1,
    description: input.description ?? input.command.slice(0, 60),
    startedAt: Date.now(), stdout: '', stderr: '',
    status: 'running', child,
  }
  child.stdout?.on('data', d => { task.stdout += d.toString() })
  child.stderr?.on('data', d => { task.stderr += d.toString() })
  child.on('close', (code, signal) => {
    task.status = code === 0 ? 'completed' : 'failed'
    task.exitCode = code ?? undefined
    task.signal = signal ?? undefined
  })
  tasks.set(taskId, task)
  return {
    output: `<task_id>${taskId}</task_id>\n<status>running</status>\n<description>${task.description}</description>`,
    isError: false,
  }
}

function truncate(s: string): string {
  if (s.length <= MAX_BUFFER) return s
  return s.slice(0, MAX_BUFFER) + '\n...truncated'
}
