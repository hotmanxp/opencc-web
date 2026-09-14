/**
 * 对话 Markdown 里的文件路径检测。
 *
 * 用途:把 agent 提到的文件渲染成可点击 chip(预览 / 打开位置)。因此判定
 * 必须是**保守**的 —— 宁可漏掉,也不能把版本号(`1.5`)、域名(`a.b.com`)、
 * 包版本(`react-dom`)误渲染成文件链接。依据只有扩展名白名单 + 结构约束,
 * 不做模糊猜测。
 *
 * 有意不覆盖:
 * - 含空格的路径 —— prose 里无法与普通短语区分
 * - Windows 反斜杠路径 —— zai 目前只跑 macOS / Linux
 * - 裸 `.env` 这类 dotfile(无目录前缀)—— prose 里歧义太大
 */

/** 可点击的扩展名白名单(源码 / 配置 / 文档)。刻意不含图片等二进制:
 *  预览它们要整文件走 base64,不适合在对话里误点触发。 */
const FILE_EXTENSIONS = new Set([
  // 代码
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte', 'astro',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp', 'hpp',
  'cxx', 'cs', 'php', 'swift', 'scala', 'dart', 'lua', 'r', 'pl', 'pm', 'ex',
  'exs', 'erl', 'hs', 'ml', 'clj', 'cljs',
  // shell
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  // 配置 / 数据
  'json', 'jsonc', 'json5', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'properties', 'lock', 'xml', 'csv', 'tsv', 'sql', 'graphql', 'gql', 'proto',
  'tf', 'hcl', 'gradle', 'cmake',
  // 文档 / Web
  'md', 'markdown', 'mdx', 'txt', 'rst', 'tex', 'html', 'htm', 'css', 'scss',
  'sass', 'less', 'svg',
])

/** 无扩展名但足以判定为文件的常见文件名。 */
const BARE_FILENAMES = new Set([
  'Dockerfile', 'Containerfile', 'Makefile', 'Procfile', 'Vagrantfile',
  'Justfile', 'Brewfile', 'Rakefile', 'Gemfile', 'LICENSE', 'NOTICE', 'CHANGELOG',
])

/**
 * 候选 token:可选前导 `/`,若干 `/` 分隔的段,末段带 `.ext`。
 * 只管"长得像路径",是否真是文件交给 isFilePath 用白名单判定。
 * `:` 不在字符类里,所以 `src/a.ts:42` 只会圈中 `src/a.ts`(行号留在正文)。
 */
const CANDIDATE_RE = /\/?[\w~.@+-]*(?:\/[\w~.@+-]+)*\.[A-Za-z][A-Za-z0-9]{0,9}/g

/**
 * 单个 token 是否为可预览的文件路径。
 * 也用于行内代码:`` `src/index.ts` `` 走这里判定。
 */
export function isFilePath(raw: string): boolean {
  const s = raw.trim()
  if (s.length < 3 || s.length > 400) return false
  if (/\s/.test(s)) return false
  // `//` 只在 URL / 协议里出现,顺手挡掉 `https://x.com/a.md` 被截出来的尾段
  if (s.includes('//')) return false
  if (s.startsWith('-')) return false // CLI flag
  if (/[<>"|*?]/.test(s)) return false // HTML 边界 / 通配符

  const base = s.slice(s.lastIndexOf('/') + 1)
  if (!base || base === '.' || base === '..') return false
  const dot = base.lastIndexOf('.')

  if (dot > 0) {
    return FILE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase())
  }
  if (dot === 0) {
    // dotfile:带目录前缀(`src/.env`)才认,裸 `.env` 不认
    return s.includes('/')
  }
  return BARE_FILENAMES.has(base)
}

export type TextOrPathSegment =
  | { kind: 'text'; value: string }
  | { kind: 'path'; value: string }

/**
 * 把一段纯文本按文件路径切成 text / path 片段。
 * 无命中时返回单个 text 片段(调用方据此跳过重渲染)。
 */
export function splitFilePaths(text: string): TextOrPathSegment[] {
  const out: TextOrPathSegment[] = []
  let last = 0
  for (const m of text.matchAll(CANDIDATE_RE)) {
    const raw = m[0]
    if (!isFilePath(raw)) continue
    const start = m.index ?? 0
    if (start > last) out.push({ kind: 'text', value: text.slice(last, start) })
    out.push({ kind: 'path', value: raw })
    last = start + raw.length
  }
  if (!out.length) return [{ kind: 'text', value: text }]
  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) })
  return out
}

/**
 * 相对路径按 cwd 补成绝对路径 —— agent 正文里写的是相对 session cwd 的路径,
 * 而 /api/fs/preview 用 node:path.resolve(服务进程 cwd),两者不一定同一个。
 * 绝对路径原样返回;`~/...` 原样返回(服务端 expandTilde 处理,见 safePath.ts)。
 */
export function toAbsolutePath(p: string, cwd: string | null | undefined): string {
  if (p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:[\\/]/.test(p)) return p
  if (!cwd) return p
  return `${cwd.replace(/\/+$/, '')}/${p.replace(/^\.\//, '')}`
}
