/**
 * ripgrep 桥 — P1-2。
 *
 * 复用系统 PATH 上的 ripgrep（`rg`），不依赖 zn-agent-core vendor 目录
 * （避免反向依赖）。若 PATH 无 ripgrep，回退到内置 node `grep` 简化实现
 * （仅支持正则基础子集）。
 *
 * 与 zai compat/vendor/ripgrep.ts 的差异：
 *   - 不依赖 vendor binary；走 PATH + 系统 ripgrep
 *   - 若 PATH 也无 ripgrep，自动回退到内置简易 grep（性能差但可用）
 *
 * 输出对齐 zai 的 GrepTool：
 *   - 文件路径:行号:内容（默认 ripgrep 格式）
 *   - 截断到 30_000 chars
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'

const execFileAsync = promisify(execFile)

const MAX_OUTPUT_CHARS = 30_000
const DEFAULT_TIMEOUT_MS = 10_000

export interface RipgrepToolOptions {
  cwd: string
}

/**
 * 检测 ripgrep 可用性。
 */
async function resolveRgPath(): Promise<string | null> {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    const { stdout } = await execFileAsync(cmd, ['rg'], { timeout: 3000 })
    const rgPath = stdout.trim().split(/\r?\n/)[0]
    return rgPath || null
  } catch {
    return null
  }
}

/**
 * 内置简易 grep fallback — 当系统无 ripgrep 时启用。
 * 仅支持字面字符串匹配 + path glob（简化），与 ripgrep 行为差异大。
 */
async function fallbackGrep(
  pattern: string,
  searchPath: string,
  opts: { cwd: string; ignoreCase: boolean; maxResults?: number },
): Promise<{ output: string; matchCount: number; usedFallback: true }> {
  const { readdir, readFile, stat } = await import('node:fs/promises')
  const { join, relative } = await import('node:path')

  const re = new RegExp(
    opts.ignoreCase
      ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    opts.ignoreCase ? 'i' : '',
  )

  const results: string[] = []
  let matchCount = 0
  const limit = opts.maxResults ?? 100

  async function walk(p: string): Promise<void> {
    if (results.length >= limit) return
    let st
    try {
      st = await stat(p)
    } catch {
      return
    }
    if (st.isDirectory()) {
      let entries: string[]
      try {
        entries = await readdir(p)
      } catch {
        return
      }
      for (const e of entries) {
        if (e === 'node_modules' || e === '.git' || e.startsWith('.')) continue
        await walk(join(p, e))
      }
    } else if (st.isFile()) {
      try {
        const content = await readFile(p, 'utf-8')
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i] ?? '')) {
            const rel = relative(opts.cwd, p)
            results.push(`${rel}:${i + 1}:${lines[i]}`)
            matchCount++
            if (results.length >= limit) return
          }
        }
      } catch {
        // skip binary files
      }
    }
  }

  await walk(searchPath)
  return {
    output: results.join('\n') || '(no matches)',
    matchCount,
    usedFallback: true,
  }
}

export function createRipgrepTool(opts: RipgrepToolOptions) {
  return defineTool({
    name: 'Ripgrep',
    description:
      'Search files with ripgrep-compatible regex pattern. Returns lines as `path:line:content`. ' +
      `Output beyond ${MAX_OUTPUT_CHARS} characters is truncated.`,
    parameters: {
      pattern: {
        type: 'string',
        description: 'Search pattern (regex or literal string).',
        required: true,
      },
      path: {
        type: 'string',
        description: 'File or directory to search (default: cwd).',
      },
      ignore_case: {
        type: 'boolean',
        description: 'Case-insensitive match (ripgrep -i).',
      },
      max_results: {
        type: 'integer',
        description: 'Cap number of matched lines (default 100).',
      },
      file_type: {
        type: 'string',
        description: 'File pattern to include (ripgrep --type).',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          output: { type: 'string', description: 'Matched lines in `path:line:content` form.' },
          matchCount: { type: 'integer', description: 'Total matches found.' },
          usedFallback: { type: 'boolean', description: 'True when system ripgrep was unavailable.' },
          truncated: { type: 'boolean', description: 'True when output was truncated.' },
        },
        additionalProperties: false,
      },
      render(_args, value) {
        const v = value as { output: string }
        return [{ type: 'text', text: v.output }]
      },
    },
    async execute(args) {
      const a = args as {
        pattern: string
        path?: string
        ignore_case?: boolean
        max_results?: number
        file_type?: string
      }
      const searchPath = a.path ?? opts.cwd
      const rgPath = await resolveRgPath()

      // Path 1: 用系统 ripgrep
      if (rgPath) {
        const rgArgs: string[] = ['--no-heading', '--line-number', '--color=never']
        if (a.ignore_case) rgArgs.push('-i')
        if (a.max_results !== undefined) rgArgs.push('-m', String(a.max_results))
        if (a.file_type) rgArgs.push('--type', a.file_type)
        rgArgs.push(a.pattern, searchPath)
        try {
          const { stdout, stderr } = await execFileAsync(rgPath, rgArgs, {
            cwd: opts.cwd,
            timeout: DEFAULT_TIMEOUT_MS,
            maxBuffer: 10 * 1024 * 1024,
          })
          const full = stdout || stderr || '(no matches)'
          const truncated = full.length > MAX_OUTPUT_CHARS
          return {
            output: truncated ? full.slice(0, MAX_OUTPUT_CHARS) : full,
            matchCount: full.split('\n').filter(Boolean).length,
            usedFallback: false,
            truncated,
          }
        } catch (err) {
          const e = err as { code?: string; stdout?: string; stderr?: string }
          // ripgrep exit code 1 = no matches（不算错误）
          if (e.code === 'ENOENT' || e.code === '1') {
            const full = e.stdout ?? '(no matches)'
            return {
              output: full,
              matchCount: 0,
              usedFallback: false,
              truncated: false,
            }
          }
          return {
            output: `[error] ripgrep failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
            matchCount: 0,
            usedFallback: false,
            truncated: false,
          }
        }
      }

      // Path 2: 内置 fallback
      const result = await fallbackGrep(a.pattern, searchPath, {
        cwd: opts.cwd,
        ignoreCase: a.ignore_case ?? false,
        maxResults: a.max_results,
      })
      const truncated = result.output.length > MAX_OUTPUT_CHARS
      return {
        output: truncated ? result.output.slice(0, MAX_OUTPUT_CHARS) : result.output,
        matchCount: result.matchCount,
        usedFallback: true,
        truncated,
      }
    },
  })
}

/**
 * 注册 ripgrep 工具到 dsh ctx。
 */
export function registerRipgrepTool(
  ctx: Context,
  opts: RipgrepToolOptions,
): () => void {
  const tools = ctx.get('tools') as { register: (definition: unknown) => () => void } | undefined
  if (!tools) {
    throw new Error(
      '[dsh-bridge] ripgrep: tools service unavailable — was @deepseek-ai/dsh-tools loaded?',
    )
  }
  return tools.register(createRipgrepTool(opts)) as () => void
}