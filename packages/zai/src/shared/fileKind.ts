// Shared file-kind classification for display_files + /fs/preview.
// Kept separate from compat/tools/displayFiles.ts (zn-agent-core) because
// the compat layer bundles to dist/opencc-core.mjs and cannot import from
// the zai package. The two sides duplicate these Sets intentionally; key
// extensions are asserted in both test suites as a sync guard.

export type FilePreviewKind = 'text' | 'image' | 'html' | 'binary'

export const TEXT_EXTS: ReadonlySet<string> = new Set([
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

export const HTML_EXTS: ReadonlySet<string> = new Set(['.html', '.htm'])

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

import { extname } from 'node:path'

export function classifyKind(absPath: string): FilePreviewKind {
  const ext = extname(absPath).toLowerCase()
  if (ext in IMAGE_EXTS) return 'image'
  if (HTML_EXTS.has(ext)) return 'html'
  if (TEXT_EXTS.has(ext)) return 'text'
  return 'binary'
}

export function mimeFromExt(absPath: string): string | undefined {
  const ext = extname(absPath).toLowerCase()
  return IMAGE_EXTS[ext]
}
