/**
 * presentFileOpencc — vendor-shape 内置工具:把**一个**本地文件直接展示在
 * 当前对话里。
 *
 * 前端渲染见 packages/zai/src/web/src/components/toolRenderers/presentFile.tsx
 * (图片 / HTML / 文本·Markdown·代码在卡片内联渲染;文档类与二进制只给元数据
 * + 右上角 ↗ 大预览)。设计:
 * docs/superpowers/specs/2026-09-24-zai-present-file-design.md。
 *
 * 取代 2026-08-20 的 DisplayFiles(多文件元数据卡):
 *   - 单文件(一次只展示一个,避免 transcript 膨胀)
 *   - kind 分类补齐文档类(docx/sheet/ppt/pdf/legacy-office),PDF / Word
 *     不再被误判成 binary
 *   - 工具描述与 schema 描述改英文(AGENTS.md:系统提示词一律英文)
 *
 * 实现位置在 opencc-src/ 而不是 compat/tools/:复用 vendor 的 buildTool +
 * zod v4 schema(直接进 zodToJsonSchema → API 请求),与 BashTool 并列成为
 * 真正的内置工具。
 */
import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { z } from 'zod/v4'
import { buildTool } from '../Tool.js'

// 扩展名分类规则必须与 packages/zai/src/shared/fileKind.ts 保持一致 ——
// zn-agent-core 不能反向 import zai(bundle 单向依赖),两份 Set 字面量各自
// 维护;presentFileOpencc.test.ts 与 zai 侧的 fileKind 测试对关键扩展名
// (png/html/ts/md/pdf/docx)双向断言,作为规则同步的护栏。
const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonc', '.json5',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.scss', '.less', '.xml',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cc', '.cpp', '.h', '.hpp',
  '.sql', '.graphql', '.gql',
  '.env', '.gitignore', '.gitattributes', '.lock', '.log',
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
const DOCX_EXTS = new Set(['.docx', '.docm'])
// SheetJS 能读的表格格式(见 2026-09-21 文档预览设计 §2.7)。
const SHEET_EXTS = new Set(['.xlsx', '.xlsm', '.xlsb', '.xls', '.ods', '.csv'])
const PPT_EXTS = new Set(['.pptx', '.pptm'])
const PDF_EXTS = new Set(['.pdf'])
// 旧版二进制 Office(BIFF/OLE)与 ODF —— 浏览器端无渲染库。
const LEGACY_OFFICE_EXTS = new Set(['.doc', '.ppt', '.rtf', '.odt', '.odp'])

/** 与 packages/zai/src/shared/fileKind.ts 的 FilePreviewKind 同构。 */
type FilePreviewKind =
  | 'text' | 'image' | 'html' | 'binary'
  | 'docx' | 'sheet' | 'ppt' | 'pdf' | 'legacy-office'

function classifyKind(absPath: string): FilePreviewKind {
  const ext = extname(absPath).toLowerCase()
  if (ext in IMAGE_EXTS) return 'image'
  if (HTML_EXTS.has(ext)) return 'html'
  if (TEXT_EXTS.has(ext)) return 'text'
  if (DOCX_EXTS.has(ext)) return 'docx'
  if (SHEET_EXTS.has(ext)) return 'sheet'
  if (PPT_EXTS.has(ext)) return 'ppt'
  if (PDF_EXTS.has(ext)) return 'pdf'
  if (LEGACY_OFFICE_EXTS.has(ext)) return 'legacy-office'
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

const TOOL_DESCRIPTION =
  'Present one local file directly to the user in this conversation. The file is ' +
  'rendered inline as a card: images, HTML pages, text / code / Markdown get an ' +
  'inline preview, and every kind gets an "open large preview" button. Use it to ' +
  'hand over an artifact (generated report, chart, image, export) instead of only ' +
  'writing its path in the reply. Images larger than 10 MiB, text / HTML larger ' +
  'than 1 MiB and unsupported binaries show metadata only. Present one file per call.'

const inputSchema = z.object({
  path: z.string().min(1).describe('Absolute path of the local file to present.'),
  caption: z
    .string()
    .max(200)
    .optional()
    .describe(
      'Optional one-line note shown above the preview, e.g. what this file is. Max 200 characters.',
    ),
})

// 前端展示数据暂存 (zai patch):mapToolResultToToolResultBlockParam 回灌给
// LLM 的 content 是 'done',但前端 presentFileRenderer 渲染卡片需要这段
// wrapper JSON —— 两者都源自 tool_result content,不能兼顾。这里把 wrapper
// 按 toolUseId 暂存,zai server 转发 runtime.tool_result 时
// takePresentFileOutput 取出(取出即删);LLM 消息历史里的 content 保持
// 'done' 不变(省上下文)。
const presentFileOutputsByToolUse = new Map<string, string>()

export function takePresentFileOutput(toolUseId: string): string | undefined {
  const output = presentFileOutputsByToolUse.get(toolUseId)
  if (output !== undefined) {
    presentFileOutputsByToolUse.delete(toolUseId)
  }
  return output
}

/** vendor-shape Tool,直接挂入 mainAgent.tools 槽(见 mainAgents.ts)。 */
export const presentFileOpenccTool = buildTool({
  name: 'PresentFile',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  async description() {
    return TOOL_DESCRIPTION
  },
  async prompt() {
    return TOOL_DESCRIPTION
  },
  get inputSchema() {
    return inputSchema
  },
  maxResultSizeChars: 20_000,
  async call({ path, caption }) {
    const file = await statOneFile(path)
    const output = JSON.stringify({
      content: [{ type: 'json' as const, json: { file, caption } }],
    })
    return { data: { output } }
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage() {
    return null
  },
  // zai patch:不把 stat 结果回灌给 LLM —— 前端已按元数据渲染卡片,LLM 拿到
  // 这些 JSON 只会浪费上下文。统一返回 'done' 让模型立刻停;wrapper 暂存进
  // 上面的 map 供 SSE → 前端展示通道使用。
  mapToolResultToToolResultBlockParam(
    content: { output?: string },
    toolUseID: string,
  ) {
    if (typeof content?.output === 'string') {
      presentFileOutputsByToolUse.set(toolUseID, content.output)
    }
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: 'done',
    }
  },
  toAutoClassifierInput() {
    return ''
  },
  checkPermissions(input) {
    return Promise.resolve({
      behavior: 'allow' as const,
      updatedInput: input,
      decisionReason: {
        type: 'mode' as const,
        mode: 'bypassPermissions' as const,
      },
    })
  },
  userFacingName: () => 'PresentFile',
})