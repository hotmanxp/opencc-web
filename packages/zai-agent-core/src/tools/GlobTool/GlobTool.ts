import { createRequire } from 'node:module'
import { isAbsolute, resolve } from 'path'
import type { LegacyTool, LegacyToolContext as ToolContext } from '../Tool.js'
import { GlobInputSchema, type GlobInput, type GlobOutput } from './schema.js'
import { GLOB_TOOL_NAME, renderPrompt } from './prompt.js'

// Node 22+ has fs.promises.glob; @types/node 20 doesn't expose it. Load via createRequire.
const require_ = createRequire(import.meta.url)
const fsPromises = require_('fs/promises') as {
  glob: (pattern: string, opts: { cwd: string }) => AsyncGenerator<string>
  stat: (path: string) => Promise<{ mtimeMs: number }>
}
const glob = fsPromises.glob
const stat = fsPromises.stat

const MAX_RESULTS = 100

// tool_result block 的形状 (Anthropic SDK 复用类型) — 本地声明避免拉 @anthropic-ai/sdk
type ToolResultBlockParam = {
  type: 'tool_result'
  tool_use_id: string
  content: string | unknown[]
  is_error?: boolean
}

async function sortByMtimeDesc(
  files: string[],
): Promise<string[]> {
  const results = await Promise.allSettled(
    files.map(async (f) => {
      const s = await stat(f)
      return { f, mtimeMs: s.mtimeMs }
    }),
  )
  const withMtime: Array<{ f: string; mtimeMs: number }> = []
  for (const r of results) {
    if (r.status === 'fulfilled') withMtime.push(r.value)
    else withMtime.push({ f: (r.reason as NodeJS.ErrnoException).path ?? '', mtimeMs: 0 })
  }
  withMtime.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs
    return a.f < b.f ? -1 : a.f > b.f ? 1 : 0
  })
  return withMtime.map((x) => x.f)
}

export const GlobTool: LegacyTool<typeof GlobInputSchema, string> = {
  name: GLOB_TOOL_NAME,
  description: renderPrompt(),
  inputSchema: GlobInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  // opencc `Tool.isSearchOrReadCommand` — 用于 UI collapse
  isSearchOrReadCommand: () => ({ isSearch: true, isRead: false }),

  // opencc `Tool.preparePermissionMatcher` — 门控于 ZAI_ENABLE_PERMISSION_DENY_RULES
  preparePermissionMatcher: async (input: GlobInput) => {
    if (process.env.ZAI_ENABLE_PERMISSION_DENY_RULES !== '1') {
      return (_pattern: string) => true
    }
    return (pattern: string) => {
      const re = new RegExp(
        '^' +
          pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') +
          '$',
      )
      return re.test(input.pattern)
    }
  },

  // opencc `Tool.validateInput` — UNC 跳过 + ENOENT 提示;建议路径依赖 fs 工具(轻量实现)
  validateInput: async (input: GlobInput) => {
    if (input.path) {
      const absolute = isAbsolute(input.path)
        ? input.path
        : resolve(process.cwd(), input.path)
      // SECURITY: UNC path skip — 防止 NTLM 凭据泄露
      if (absolute.startsWith('\\\\') || absolute.startsWith('//')) {
        return { result: true }
      }
      try {
        const s = await stat(absolute)
        if (!(s as unknown as { isDirectory?: () => boolean }).isDirectory?.()) {
          return {
            result: false,
            message: `Path is not a directory: ${input.path}`,
            errorCode: 2,
          }
        }
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException
        if (err.code === 'ENOENT') {
          // suggestPathUnderCwd 等工具未在 zai 中实现, 仅给 cwd 提示
          return {
            result: false,
            message: `Directory does not exist: ${input.path}. CWD: ${process.cwd()}.`,
            errorCode: 1,
          }
        }
        throw e
      }
    }
    return { result: true }
  },

  async call(rawInput, ctx) {
    const input = rawInput as GlobInput
    const baseDir = input.path
      ? (isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path))
      : ctx.cwd

    const start = Date.now()
    let matches: string[] = []
    let hitLimit = false
    try {
      for await (const entry of glob(input.pattern, { cwd: baseDir })) {
        matches.push(entry)
        if (matches.length > MAX_RESULTS) {
          hitLimit = true
          break
        }
      }
    } catch (e) {
      return { output: `Glob failed in ${baseDir}: ${(e as Error).message}`, isError: true }
    }

    const truncated = hitLimit
    if (matches.length === 0) {
      const output: GlobOutput = {
        filenames: [],
        durationMs: Date.now() - start,
        numFiles: 0,
        truncated: false,
      }
      const header = `No files matched "${input.pattern}" in ${baseDir}`
      return { output: JSON.stringify({ ...output, header }) }
    }

    // Sort by mtime desc, tiebreak by filename
    const sorted = await sortByMtimeDesc(matches)
    const sliced = sorted.slice(0, MAX_RESULTS)
    const output: GlobOutput = {
      filenames: sliced,
      durationMs: Date.now() - start,
      numFiles: sliced.length,
      truncated,
    }
    const header = truncated
      ? `Found ${matches.length}+ files (showing first ${MAX_RESULTS}, sorted by mtime):`
      : `Found ${sliced.length} files:`
    return { output: JSON.stringify({ ...output, header }) }
  },

  // opencc `Tool.mapToolResultToToolResultBlockParam` — 模型看到的是 filename 列表 + 截断提示
  mapToolResultToToolResultBlockParam:
    (content: unknown, toolUseId: string): ToolResultBlockParam => {
      let parsed: { filenames?: string[]; truncated?: boolean } | null = null
      if (typeof content === 'string') {
        try {
          parsed = JSON.parse(content)
        } catch {
          parsed = null
        }
      }
      if (!parsed || !Array.isArray(parsed.filenames)) {
        return {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: typeof content === 'string' ? content : JSON.stringify(content),
        }
      }
      const filenames = parsed.filenames
      if (filenames.length === 0) {
        return {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: 'No files found',
        }
      }
      const lines = [
        ...filenames,
        ...(parsed.truncated
          ? [
              '(Results are truncated. Consider using a more specific path or pattern.)',
            ]
          : []),
      ]
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: lines.join('\n'),
      }
    },
}