/**
 * Map a file basename → Prism language id, for `react-syntax-highlighter`.
 *
 * Only returns a language for code files (.ts / .tsx / .js / .py / .go / …).
 * Plain text, JSON, YAML, Markdown and similar are intentionally NOT mapped —
 * the preview falls back to a plain `<pre>` so we don't get half-coloured
 * markdown or JSON that looks inconsistent next to the same syntax in tool
 * output.
 *
 * The server already enforces an extension allow-list (TEXT_EXTS in
 * `routes/fs.ts`); this map is the language *display* side. Files that
 * reach the preview at all are guaranteed to be in TEXT_EXTS, but only
 * the subset below gets highlighting.
 */
const EXT_TO_LANG: Record<string, string> = {
  // TypeScript / JS family
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  // Web
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  // Systems / compiled
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  // Shell
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'shell',
  ps1: 'powershell',
  // Other
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
};

/**
 * Returns the Prism language id for `basename`, or `null` if the file
 * should be rendered as plain text.
 */
export function extToLanguage(basename: string): string | null {
  const idx = basename.lastIndexOf('.');
  if (idx <= 0) return null;
  const ext = basename.slice(idx + 1).toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}