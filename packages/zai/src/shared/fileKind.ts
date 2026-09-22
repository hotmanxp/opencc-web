// Shared file-kind classification for display_files + /fs/preview.
// Kept separate from compat/tools/displayFiles.ts (zn-agent-core) because
// the compat layer bundles to dist/opencc-core.mjs and cannot import from
// the zai package. The two sides duplicate these Sets intentionally; key
// extensions are asserted in both test suites as a sync guard.

export type FilePreviewKind =
  | 'text'
  | 'image'
  | 'html'
  | 'binary'
  // 文档预览 (2026-09-21): 纯浏览器渲染,字节走 GET /api/fs/raw。
  | 'docx'
  | 'sheet'
  | 'ppt'
  | 'pdf'
  // 旧版 OOXML 之前的二进制 Office 格式(.doc/.xls/.ppt)与 ODF 的
  // .odt/.odp —— 客户端渲染库一律不支持。单列一个 kind 而不是塞回
  // 'binary',是为了让 UI 给出「疑似旧版二进制格式,请转存为 OOXML」
  // 这种可操作的提示,而不是笼统的「不支持内联预览」。
  | 'legacy-office'

/** 能走 /api/fs/raw 取字节、由客户端渲染器解析的 kind。 */
export type DocumentKind = 'docx' | 'sheet' | 'ppt' | 'pdf'

/**
 * 文档类 kind(需要走 /api/fs/raw 拉字节、由 documentPreview/ 渲染)。
 * 服务端白名单、前端 preflight、desktopFs 的 preview 标志共用这一份判定。
 */
export const DOCUMENT_KINDS: ReadonlySet<FilePreviewKind> = new Set<FilePreviewKind>([
  'docx', 'sheet', 'ppt', 'pdf',
])

/** 客户端渲染器支持的文档 kind + 明确拒绝的 legacy 文档 kind。 */
export const PREVIEWABLE_KINDS: ReadonlySet<FilePreviewKind> = new Set<FilePreviewKind>([
  ...DOCUMENT_KINDS, 'legacy-office',
])

export function isDocumentKind(kind: FilePreviewKind): kind is DocumentKind {
  return DOCUMENT_KINDS.has(kind)
}

/** PREVIEWABLE_KINDS 的类型谓词版本(`.has()` 不做窄化,调用方会拿到 `| binary`)。 */
export function isPreviewableKind(kind: FilePreviewKind): kind is DocumentKind | 'legacy-office' {
  return PREVIEWABLE_KINDS.has(kind)
}

export const TEXT_EXTS: ReadonlySet<string> = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonc', '.json5',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.scss', '.less', '.xml',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cc', '.cpp', '.h', '.hpp',
  '.sql', '.graphql', '.gql',
  // `.log` 不在 compat 那份里;加进来是 desktopFs 收编 classifyKind 的必要条件
  // —— desktopFs 的旧 TEXT_EXTS 认 .log,只留 shared 一份后漏掉它会让 /desktop
  // 里双击 .log 从「内联文本预览」退化回「系统应用打开」。
  '.env', '.gitignore', '.gitattributes', '.lock', '.log',
])

export const HTML_EXTS: ReadonlySet<string> = new Set(['.html', '.htm'])

export const DOCX_EXTS: ReadonlySet<string> = new Set(['.docx', '.docm'])

/** SheetJS 能读的表格格式(含 .xls/.xlsb/.ods —— 见 docs/superpowers/specs/2026-09-21-document-preview-design.md §2.7)。 */
export const SHEET_EXTS: ReadonlySet<string> = new Set([
  '.xlsx', '.xlsm', '.xlsb', '.xls', '.ods', '.csv',
])

export const PPT_EXTS: ReadonlySet<string> = new Set(['.pptx', '.pptm'])

export const PDF_EXTS: ReadonlySet<string> = new Set(['.pdf'])

/**
 * 旧版二进制 Office(BIFF/OLE)与 ODF 文本/演示 —— 浏览器端无渲染库。
 * `.rtf` 放这里:它不是 OOXML 也不是纯文本,同样没有渲染器。
 */
export const LEGACY_OFFICE_EXTS: ReadonlySet<string> = new Set([
  '.doc', '.ppt', '.rtf', '.odt', '.odp',
])

/**
 * 各文档 kind 的字节上限(byte)。服务端 /api/fs/raw 据此返回 413,
 * 前端 UnsupportedNotice 直接展示同一个数字,避免两处硬编码漂移。
 */
export const DOCUMENT_MAX_BYTES: Readonly<Record<string, number>> = {
  docx: 30 * 1024 * 1024,
  sheet: 30 * 1024 * 1024,
  ppt: 50 * 1024 * 1024,
  pdf: 50 * 1024 * 1024,
}

export const IMAGE_EXTS: Readonly<Record<string, string>> = {
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

// Pure-string `extname`: the only consumer-side operation we need is
// "split off the trailing `.xxx` from a path / basename". Implementing it
// inline (rather than `import { extname } from 'node:path'`) lets the web
// bundle import this module without vite pulling a node:polyfill — both
// server and browser resolve through the same function.
function extname(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? ''
  const idx = base.lastIndexOf('.')
  return idx <= 0 ? '' : base.slice(idx)
}

export function classifyKind(absPath: string): FilePreviewKind {
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

export function mimeFromExt(absPath: string): string | undefined {
  const ext = extname(absPath).toLowerCase()
  return IMAGE_EXTS[ext]
}
