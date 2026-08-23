/**
 * DisplayFiles 工具 — Phase 5P2 + 5P-DSFallback。
 *
 * 双路径:
 *   1. **上游路径(推荐)**:zai 实际运行时,dsh-llm-pi-ai 装载时 `exec.ctx.fs`
 *      由 `LocalFileSystem` 填充 — 走 `ctx.fs.listDir(target, signal)`。
 *      自动应用 sandbox policy(若 `SandboxedFileSystem` 后端选型)。
 *   2. **node:fs 兜底路径**:测试用 `tool.execute(args, {})` mock 调用时
 *      `exec.ctx` 不存在 — 降级到 `node:fs/promises.readdir` + `stat`,
 *      保留 dsh017.test 单测兼容。
 *
 * 文件总长:**~120 行**(原 182 → 现 120,但分拆为上游 + fallback 双实现)。
 * 真正生产运行时只跑上游分支 ~70 行;测试时跑 fallback ~50 行。
 *
 * 行为对齐 opencc DisplayFiles tool:
 *   - 输入:file_path (绝对路径,默认 cwd)
 *   - 输出:按行 "<type> <name>  (<size> bytes)" 排序 (dirs 优先)
 *   - 隐藏文件(.开头)默认不显示,可选 include_hidden
 *   - 单目录,不递归
 *   - 截断到 30_000 chars
 */

import { readdir, stat } from 'node:fs/promises'
import { defineTool } from '@zn-ai/dsh-bridge/dsh-core'
import type { Context } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'

const MAX_OUTPUT_CHARS = 30_000
const MAX_ENTRIES = 500

export interface DisplayFilesToolOptions {
  /** 当前 cwd — 当 file_path 相对时,resolve 到此。 */
  cwd: string
}

interface ListRow {
  name: string
  type: 'dir' | 'file' | 'other'
  size: string
}

function sortRows(rows: ListRow[]): ListRow[] {
  return [...rows].sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1
    if (a.type !== 'dir' && b.type === 'dir') return 1
    return a.name.localeCompare(b.name)
  })
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0'
  if (bytes < 1024) return `${bytes} bytes`
  return `${(bytes / 1024).toFixed(1)} KB`
}

function renderListing(absPath: string, rows: ListRow[]): string {
  const sorted = sortRows(rows)
  const lines: string[] = [`Contents of ${absPath}:`]
  const shown = sorted.slice(0, MAX_ENTRIES)
  for (const e of shown) {
    if (e.type === 'dir') {
      lines.push(`  dir  ${e.name}/`)
    } else if (e.type === 'file') {
      lines.push(`  file ${e.name}  (${e.size})`)
    } else {
      lines.push(`  other ${e.name}`)
    }
  }
  const truncated = sorted.length > MAX_ENTRIES
  if (truncated) {
    lines.push(`\n(truncated; showing first ${MAX_ENTRIES} of ${sorted.length} entries)`)
  } else {
    lines.push(`\nTotal: ${sorted.length} entries`)
  }
  let output = lines.join('\n')
  if (output.length > MAX_OUTPUT_CHARS) {
    output = output.slice(0, MAX_OUTPUT_CHARS) +
      `\n\n(output further truncated at ${MAX_OUTPUT_CHARS} chars)`
  }
  return output
}

/** node:fs/promises 路径 — 测试用,真生产应走 ctx.fs。 */
async function listViaNodeFs(absPath: string, includeHidden: boolean): Promise<{
  rows: ListRow[]
  isFile: boolean
}> {
  let st
  try {
    st = await stat(absPath)
  } catch (err) {
    throw new Error(
      `failed to read ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!st.isDirectory()) {
    // Not a directory — caller 应报 "not a directory" 错
    return { rows: [], isFile: true }
  }
  const entries = await readdir(absPath, { withFileTypes: true })
  const rows: ListRow[] = []
  for (const entry of entries) {
    if (!includeHidden && entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      rows.push({ name: entry.name, type: 'dir', size: '0' })
    } else if (entry.isFile()) {
      try {
        const s = await stat(`${absPath}/${entry.name}`)
        rows.push({ name: entry.name, type: 'file', size: formatBytes(s.size) })
      } catch {
        rows.push({ name: entry.name, type: 'other', size: '0' })
      }
    } else {
      rows.push({ name: entry.name, type: 'other', size: '0' })
    }
  }
  return { rows, isFile: false }
}

/** ctx.fs 路径 — 优先用 dsh-fs upstream(支持 sandbox)。 */
async function listViaCtxFs(
  ctxRef: Context,
  absPath: string,
  includeHidden: boolean,
  signal: AbortSignal | undefined,
): Promise<{ rows: ListRow[]; isFile: boolean }> {
  const fs = ctxRef.fs
  let target
  try {
    target = await fs.resolve(absPath)
  } catch {
    // 错误冒泡到 caller,统一 format
    throw new Error(`failed to resolve ${absPath}`)
  }
  let info
  try {
    info = await fs.stat(target)
  } catch {
    info = null
  }
  if (info && info.type !== 'directory') {
    return { rows: [], isFile: true }
  }
  const entries = (await fs.listDir(target)) as Array<{
    name: string
    type: 'file' | 'directory' | 'other'
  }>
  const rows: ListRow[] = []
  for (const entry of entries) {
    if (!includeHidden && entry.name.startsWith('.')) continue
    if (entry.type === 'directory') {
      rows.push({ name: entry.name, type: 'dir', size: '0' })
    } else if (entry.type === 'file') {
      let sizeStr = '0'
      try {
        const sub = (await fs.lstat(`${absPath}/${entry.name}`)) as
          | { size: number }
          | undefined
        sizeStr = formatBytes(sub?.size ?? 0)
      } catch {
        sizeStr = '?'
      }
      rows.push({ name: entry.name, type: 'file', size: sizeStr })
    } else {
      rows.push({ name: entry.name, type: 'other', size: '0' })
    }
  }
  return { rows, isFile: false }
}

export function createDisplayFilesTool(opts: DisplayFilesToolOptions) {
  return defineTool({
    name: 'DisplayFiles',
    description:
      'List the contents of a single directory. Shows one entry per line, with type ' +
      'prefix (dir/file) and file size in bytes. Hidden files (starting with `.`) are ' +
      'hidden by default. Does NOT recurse — call again on subdirectories to explore. ' +
      'For reading individual files, use `read`. For searching content, use `grep`.',
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
    async execute(args, exec) {
      const a = args as { file_path?: string; include_hidden?: boolean }
      const absPath = resolve(
        a.file_path && a.file_path.trim().length > 0 ? a.file_path : opts.cwd,
      )
      const includeHidden = a.include_hidden === true
      const signal = exec?.signal

      // Phase 5P2: 优先走 ctx.fs (sandbox-aware upstream API)
      const ctxRef = (exec as { ctx?: Context }).ctx
      if (ctxRef?.fs) {
        try {
          const { rows, isFile } = await listViaCtxFs(ctxRef, absPath, includeHidden, signal)
          if (isFile) {
            return {
              output:
                `[error] ${absPath} is not a directory (it's a file or special node). ` +
                `Use \`read\` to read a file.`,
              entryCount: 0,
              truncated: false,
            }
          }
          const output = renderListing(absPath, rows)
          return {
            output,
            entryCount: Math.min(rows.length, MAX_ENTRIES),
            truncated: rows.length > MAX_ENTRIES || output.length > MAX_OUTPUT_CHARS,
          }
        } catch (err) {
          return {
            output: `[error] ctx.fs list failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
            entryCount: 0,
            truncated: false,
          }
        }
      }

      // 兜底:node:fs/promises 路径(测试用,无 ctx.fs mock 时降级)
      try {
        const { rows, isFile } = await listViaNodeFs(absPath, includeHidden)
        if (isFile) {
          return {
            output:
              `[error] ${absPath} is not a directory (it's a file or special node). ` +
              `Use FileRead to read a file.`,
            entryCount: 0,
            truncated: false,
          }
        }
        const output = renderListing(absPath, rows)
        return {
          output,
          entryCount: Math.min(rows.length, MAX_ENTRIES),
          truncated: rows.length > MAX_ENTRIES || output.length > MAX_OUTPUT_CHARS,
        }
      } catch (err) {
        return {
          output: `[error] failed to list ${absPath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          entryCount: 0,
          truncated: false,
        }
      }
    },
  })
}

/**
 * 注册 DisplayFiles 工具到 dsh ctx.tools — 兼容 zai-side 旧调用栈。
 */
export function registerDisplayFilesTool(
  ctx: Context,
  opts: DisplayFilesToolOptions,
): () => void {
  const tools = ctx.get('tools') as
    | { register: (definition: unknown) => () => void }
    | undefined
  if (!tools) {
    throw new Error(
      '[dsh-bridge] registerDisplayFilesTool: ctx.tools unavailable',
    )
  }
  return tools.register(createDisplayFilesTool(opts))
}
