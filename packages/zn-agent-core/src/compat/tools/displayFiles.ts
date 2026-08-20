/**
 * display_files — 把一组本地文件路径以卡片列表渲染进当前会话。
 * 每个卡片带 [预览] 与 [打开目录] 两个按钮,由前端 fileDisplayRenderer 处理。
 *
 * 此工具只 stat + 返回元数据(不进 transcript 大体积),
 * 文件内容由前端按需 fetch /api/fs/preview。
 *
 * 扩展名分类规则复制自 packages/zai/src/shared/fileKind.ts
 * (compat 层 bundle 到 dist/opencc-core.mjs,不能 import zai 包);
 * 关键扩展名 (png/jpg/html/ts/md) 在本文件单测和 zai 端 fileKind.test.ts
 * 各覆盖一次,作为规则同步护栏。
 */
import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { z } from 'zod'
import { makeTool } from './makeTool.js'

const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonc', '.json5',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.scss', '.less', '.xml',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cc', '.cpp', '.h', '.hpp',
  '.sql', '.graphql', '.gql',
  '.env', '.gitignore', '.gitattributes', '.lock',
])

const HTML_EXTS = new Set(['.html', '.htm'])

const IMAGE_EXTS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
}

type FilePreviewKind = 'text' | 'image' | 'html' | 'binary'

function classifyKind(absPath: string): FilePreviewKind {
  const ext = extname(absPath).toLowerCase()
  if (ext in IMAGE_EXTS) return 'image'
  if (HTML_EXTS.has(ext)) return 'html'
  if (TEXT_EXTS.has(ext)) return 'text'
  return 'binary'
}

type FileErrorCode = 'ENOENT' | 'EACCES' | 'EISDIR' | 'EPERM' | 'EBUSY' | 'ELOOP'

interface FileMeta {
  path: string
  name: string
  size: number
  mtime: number
  kind: FilePreviewKind
  error?: { code: FileErrorCode; message: string }
}

function normalizeErrno(code: string | undefined): FileErrorCode {
  switch (code) {
    case 'ENOENT':
    case 'EACCES':
    case 'EISDIR':
    case 'EPERM':
    case 'EBUSY':
    case 'ELOOP':
      return code
    default:
      return 'EPERM'
  }
}

async function statOneFile(absPath: string): Promise<FileMeta> {
  const name = basename(absPath)
  try {
    const s = await stat(absPath)
    if (s.isDirectory()) {
      return {
        path: absPath,
        name,
        size: 0,
        mtime: s.mtimeMs,
        kind: 'binary',
        error: { code: 'EISDIR', message: '路径是目录,不是文件' },
      }
    }
    return {
      path: absPath,
      name,
      size: s.size,
      mtime: s.mtimeMs,
      kind: classifyKind(absPath),
    }
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    return {
      path: absPath,
      name,
      size: 0,
      mtime: 0,
      kind: 'binary',
      error: {
        code: normalizeErrno(err.code),
        message: err.message || String(e),
      },
    }
  }
}

const DisplayFilesInput = z.object({
  paths: z
    .array(z.string().min(1))
    .min(1, 'paths 不能为空')
    .max(20, '单次最多 20 个文件')
    .describe('一组待展示的本地文件绝对路径。'),
})

export const displayFilesTool = makeTool({
  name: 'DisplayFiles',
  description:
    '把一组本地文件路径在当前会话中展示给用户:每个文件带 [预览] 与 [打开目录] 按钮。' +
    '适合在完成文件编辑/生成/汇报任务后,把产物路径列给用户。' +
    '文件大于 1 MiB 时仅展示元数据,不会内联预览。单次最多 20 个文件。',
  inputSchema: DisplayFilesInput,
  async executor({ paths }) {
    const files = await Promise.all(paths.map(statOneFile))
    // makeTool wraps executor return as { output: string }; we JSON-stringify
    // the Anthropic-style content block into output so downstream consumers
    // (and tests) can parse it back into the structured shape.
    return {
      output: JSON.stringify({
        content: [{ type: 'json' as const, json: { files } }],
      }),
    }
  },
})
