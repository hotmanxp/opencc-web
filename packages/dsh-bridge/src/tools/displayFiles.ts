/**
 * DisplayFiles 工具 — dsh 风格 (dsh-017)。
 *
 * 让 LLM 列出目录内容(替代 opencc DisplayFiles 工具)。
 * 简单直接:用 node:fs/promises.readdir + stat,不依赖 dsh-fs 的 FsTarget
 * 抽象(避免 dsh-fs API 变更牵连;displayFiles 是 LLM 高频工具,稳定优先)。
 *
 * 行为对齐 opencc DisplayFiles tool (opencc-src/tools/DisplayFilesTool/):
 *   - 输入: file_path (绝对路径,默认 cwd)
 *   - 输出: 按行格式 "<type> <name>  (<size> bytes)" 排序(目录在前,文件在后)
 *   - 隐藏文件 (.开头) 默认不显示,可选 include_hidden
 *   - 单目录,不递归(递归让 LLM 自己多次调用)
 *   - 截断到 30_000 chars(对齐 fs.ts)
 */

import { readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'

const MAX_OUTPUT_CHARS = 30_000
const MAX_ENTRIES = 500

export interface DisplayFilesToolOptions {
  /** 当前 cwd — 当 file_path 相对时,resolve 到此。 */
  cwd: string
}

/**
 * 列出单目录条目 — 不递归。
 *
 * 返回的 dirEntries 按 目录在前 + 文件在后 + 字母序 排序,这样 LLM
 * 能稳定看到一致输出。
 */
async function listSingleDir(
  absPath: string,
  includeHidden: boolean,
): Promise<{ name: string; type: 'dir' | 'file' | 'other'; size: number }[]> {
  const entries = await readdir(absPath, { withFileTypes: true })
  const out: { name: string; type: 'dir' | 'file' | 'other'; size: number }[] = []
  for (const entry of entries) {
    if (!includeHidden && entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      out.push({ name: entry.name, type: 'dir', size: 0 })
    } else if (entry.isFile()) {
      try {
        const s = await stat(`${absPath}/${entry.name}`)
        out.push({ name: entry.name, type: 'file', size: s.size })
      } catch {
        out.push({ name: entry.name, type: 'other', size: 0 })
      }
    } else {
      out.push({ name: entry.name, type: 'other', size: 0 })
    }
  }
  // 排序:dir 优先, 然后字母序
  out.sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1
    if (a.type !== 'dir' && b.type === 'dir') return 1
    return a.name.localeCompare(b.name)
  })
  return out
}

/**
 * DisplayFiles 工具。
 */
export function createDisplayFilesTool(opts: DisplayFilesToolOptions) {
  return defineTool({
    name: 'DisplayFiles',
    description:
      'List the contents of a single directory. Shows one entry per line, with type ' +
      'prefix (dir/file) and file size in bytes. Hidden files (starting with `.`) are ' +
      'hidden by default. Does NOT recurse — call again on subdirectories to explore. ' +
      'For reading individual files, use FileRead. For searching content, use Ripgrep.',
    parameters: {
      file_path: {
        type: 'string',
        description:
          'Absolute or relative (to cwd) path to a directory. Omit to list the current working directory.',
      },
      include_hidden: {
        type: 'boolean',
        description: 'Set to true to include hidden files (those starting with .).',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          output: { type: 'string', description: 'Directory listing text.' },
          entryCount: { type: 'integer', description: 'Number of entries shown.' },
          truncated: { type: 'boolean', description: 'True if output was truncated.' },
        },
        additionalProperties: false,
      },
      render(_args, value) {
        const v = value as { output: string }
        return [{ type: 'text', text: v.output }]
      },
    },
    async execute(args) {
      const a = args as { file_path?: string; include_hidden?: boolean }
      const requested = a.file_path && a.file_path.trim().length > 0
        ? a.file_path
        : opts.cwd
      const absPath = resolve(requested)
      const includeHidden = a.include_hidden === true

      let entries
      try {
        // 1. 检查路径存在 + 是目录
        const st = await stat(absPath)
        if (!st.isDirectory()) {
          return {
            output: `[error] ${absPath} is not a directory (it's a file or special node). ` +
              `Use FileRead to read a file.`,
            entryCount: 0,
            truncated: false,
          }
        }
        // 2. 列条目
        entries = await listSingleDir(absPath, includeHidden)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          output: `[error] failed to list ${absPath}: ${message}`,
          entryCount: 0,
          truncated: false,
        }
      }

      const lines: string[] = [`Contents of ${absPath}:`]
      const shown = entries.slice(0, MAX_ENTRIES)
      for (const e of shown) {
        if (e.type === 'dir') {
          lines.push(`  dir  ${e.name}/`)
        } else if (e.type === 'file') {
          lines.push(`  file ${e.name}  (${e.size} bytes)`)
        } else {
          lines.push(`  other ${e.name}`)
        }
      }
      const truncated = entries.length > MAX_ENTRIES
      if (truncated) {
        lines.push(`\n(truncated; showing first ${MAX_ENTRIES} of ${entries.length} entries)`)
      } else {
        lines.push(`\nTotal: ${entries.length} entries`)
      }

      let output = lines.join('\n')
      let charTruncated = false
      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(0, MAX_OUTPUT_CHARS)
        charTruncated = true
        output += `\n\n(output further truncated at ${MAX_OUTPUT_CHARS} chars)`
      }

      return {
        output,
        entryCount: shown.length,
        truncated: truncated || charTruncated,
      }
    },
  })
}

/**
 * 注册 DisplayFiles 工具到 dsh ctx.tools。
 */
export function registerDisplayFilesTool(
  ctx: Context,
  opts: DisplayFilesToolOptions,
): () => void {
  const tools = ctx.get('tools') as {
    register: (tool: ReturnType<typeof defineTool>) => () => void
  }
  if (!tools) {
    throw new Error('[dsh-bridge] registerDisplayFilesTool: ctx.tools unavailable')
  }
  return tools.register(createDisplayFilesTool(opts)) as () => void
}
