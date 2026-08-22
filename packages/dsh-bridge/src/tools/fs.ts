/**
 * fs 工具桥 — P1-1（Read/Edit/Write）。
 *
 * 实现对齐 zai compat/tools/index.ts 的 FileRead/FileWrite/FileEdit：
 *   - Read: 支持 offset/limit 行号显示；>30_000 chars 截断（Anthropic 参考阈值）
 *   - Edit: surgical text replace，支持 replace_all
 *   - Write: mkdir -p 后写文件
 *
 * 用 dsh-tools `defineTool` + `ctx.tools.register()` 注册到 dsh。
 */

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'

/**
 * 大文件输出截断阈值 — 对齐 Anthropic 30_000 chars 参考值。
 */
const MAX_OUTPUT_CHARS = 30_000

export interface FsToolOptions {
  /** 当前 cwd — Edit/Write 报错时记录。 */
  cwd: string
}

/**
 * FileRead 工具。
 */
export function createFileReadTool(_opts: FsToolOptions) {
  return defineTool({
    name: 'FileRead',
    description:
      'Read a UTF-8 text file. Optional offset/limit return a numbered line slice. ' +
      `Output beyond ${MAX_OUTPUT_CHARS} characters is truncated.`,
    parameters: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to read.',
        required: true,
      },
      offset: {
        type: 'integer',
        description: 'Line offset (0-based) to start reading from.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of lines to read.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          output: { type: 'string', description: 'Numbered file contents (truncated if long).' },
          totalLines: { type: 'integer', description: 'Total line count of the file.' },
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
        file_path: string
        offset?: number
        limit?: number
      }
      try {
        const raw = await readFile(a.file_path, 'utf-8')
        const lines = raw.split('\n')
        const offset = a.offset ?? 0
        const limit = a.limit ?? lines.length
        const slice = lines.slice(offset, offset + limit)
        const numbered = slice
          .map((line, idx) => `${(offset + idx + 1).toString().padStart(6, ' ')}\t${line}`)
          .join('\n')
        const truncated = lines.length > offset + limit
        const totalLines = lines.length

        // 字符级截断（与 Anthropic 30K 参考阈值对齐）
        let output = numbered
        let wasCharTruncated = false
        if (output.length > MAX_OUTPUT_CHARS) {
          output = output.slice(0, MAX_OUTPUT_CHARS)
          wasCharTruncated = true
        }

        let summary = ''
        if (truncated) {
          summary += `\n\n(truncated at line ${offset + limit}; file has ${totalLines} lines total)`
        }
        if (wasCharTruncated) {
          summary += `\n\n(output further truncated at ${MAX_OUTPUT_CHARS} chars)`
        }

        return { output: output + summary, totalLines, truncated: truncated || wasCharTruncated }
      } catch (err) {
        return {
          output: `[error] failed to read ${a.file_path}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          totalLines: 0,
          truncated: false,
        }
      }
    },
  })
}

/**
 * FileWrite 工具。
 */
export function createFileWriteTool(_opts: FsToolOptions) {
  return defineTool({
    name: 'FileWrite',
    description:
      'Write UTF-8 text content to a file. Creates parent directories as needed.',
    parameters: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to write.',
        required: true,
      },
      content: {
        type: 'string',
        description: 'Full file content to write.',
        required: true,
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          output: { type: 'string', description: 'Human-readable summary of the write.' },
          bytesWritten: { type: 'integer', description: 'Number of bytes written.' },
        },
        additionalProperties: false,
      },
      render(_args, value) {
        const v = value as { output: string }
        return [{ type: 'text', text: v.output }]
      },
    },
    async execute(args) {
      const a = args as { file_path: string; content: string }
      try {
        await mkdir(dirname(a.file_path), { recursive: true })
        await writeFile(a.file_path, a.content, 'utf-8')
        return {
          output: `wrote ${a.content.length} bytes to ${a.file_path}`,
          bytesWritten: a.content.length,
        }
      } catch (err) {
        return {
          output: `[error] failed to write ${a.file_path}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          bytesWritten: 0,
        }
      }
    },
  })
}

/**
 * FileEdit 工具 — surgical text replace。
 */
export function createFileEditTool(_opts: FsToolOptions) {
  return defineTool({
    name: 'FileEdit',
    description:
      'Edit a UTF-8 text file by surgical string replacement. Use replace_all=true ' +
      'to replace every occurrence (otherwise only the first match is replaced).',
    parameters: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to edit.',
        required: true,
      },
      old_string: {
        type: 'string',
        description: 'The exact text to replace.',
        required: true,
      },
      new_string: {
        type: 'string',
        description: 'The replacement text.',
        required: true,
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace every occurrence instead of the first.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          output: { type: 'string', description: 'Human-readable summary of the edit.' },
          replacements: { type: 'integer', description: 'Number of replacements made.' },
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
        file_path: string
        old_string: string
        new_string: string
        replace_all?: boolean
      }
      try {
        const raw = await readFile(a.file_path, 'utf-8')
        if (!raw.includes(a.old_string)) {
          return {
            output: `[error] old_string not found in ${a.file_path}`,
            replacements: 0,
          }
        }

        let updated: string
        let count: number
        if (a.replace_all) {
          const parts = raw.split(a.old_string)
          count = parts.length - 1
          updated = parts.join(a.new_string)
        } else {
          const idx = raw.indexOf(a.old_string)
          updated =
            raw.slice(0, idx) +
            a.new_string +
            raw.slice(idx + a.old_string.length)
          count = 1
        }

        await mkdir(dirname(a.file_path), { recursive: true })
        await writeFile(a.file_path, updated, 'utf-8')
        return {
          output: `replaced ${count} occurrence${count === 1 ? '' : 's'} in ${a.file_path}`,
          replacements: count,
        }
      } catch (err) {
        return {
          output: `[error] failed to edit ${a.file_path}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          replacements: 0,
        }
      }
    },
  })
}

/**
 * FileStat 工具 — 元数据读取（mode/mtime/size 简表）。
 *
 * 对齐 zai compat/tools 的 fs::* 工具集能力。模型经常需要先 stat 再决定
 * 是 Read 还是 Edit，避免无意义操作。
 */
export function createFileStatTool(_opts: FsToolOptions) {
  return defineTool({
    name: 'FileStat',
    description: 'Read file metadata (size, mtime, mode, isDirectory).',
    parameters: {
      file_path: {
        type: 'string',
        description: 'Absolute path to stat.',
        required: true,
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          output: { type: 'string', description: 'Human-readable stat summary.' },
          size: { type: 'integer', description: 'Size in bytes.' },
          isDirectory: { type: 'boolean', description: 'True when path is a directory.' },
        },
        additionalProperties: false,
      },
      render(_args, value) {
        const v = value as { output: string }
        return [{ type: 'text', text: v.output }]
      },
    },
    async execute(args) {
      const a = args as { file_path: string }
      try {
        const s = await stat(a.file_path)
        return {
          output: `${a.file_path}: size=${s.size} mtime=${s.mtime.toISOString()} mode=${s.mode.toString(8)} dir=${s.isDirectory()}`,
          size: s.size,
          isDirectory: s.isDirectory(),
        }
      } catch (err) {
        return {
          output: `[error] failed to stat ${a.file_path}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          size: 0,
          isDirectory: false,
        }
      }
    },
  })
}

/**
 * 一次性注册 fs 工具到 dsh ctx。
 *
 * 返回 disposer 数组（每个工具一个 disposer）。
 */
export function registerFsTools(
  ctx: Context,
  opts: FsToolOptions,
): Array<() => void> {
  const tools = ctx.get('tools') as { register: (definition: unknown) => () => void } | undefined
  if (!tools) {
    throw new Error(
      '[dsh-bridge] fs: tools service unavailable — was @deepseek-ai/dsh-tools loaded?',
    )
  }
  return [
    tools.register(createFileReadTool(opts)),
    tools.register(createFileWriteTool(opts)),
    tools.register(createFileEditTool(opts)),
    tools.register(createFileStatTool(opts)),
  ]
}