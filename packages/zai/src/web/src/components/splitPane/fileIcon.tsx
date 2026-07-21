/**
 * 文件树 icon 选择器 — 给每个文件/目录挑一个专属形状的 SVG icon,
 * 而不是把所有文件都折叠成同一个<FileOutlined>.
 *
 * 真正的"每个语言一个形状"实现在 ./languageIcons.tsx,这里负责:
 *   1. classifyFile(name) — 把 basename 归到 FileKind('ts'/'tsx'/'json'/...)
 *   2. pickFileIcon(kind) — 把 FileKind 对应到上面那个 SVG 组件
 *   3. 暴露 <FileIcon name="..." /> 和 <DirIcon name open /> 给 FsTab 用
 *
 * Index.css 仍然用 [data-file-ext="..."] / [data-dir="true"] 上色 —
 * 现在 SVG 已经自带色块, 所以 CSS 的 color 设定只覆盖悬停态;
 * 主色由 SVG 自己决定. 保留 data 属性是为了不破坏 FsTab.test.tsx
 * 现存的 [data-file-ext="..."] 选择器断言.
 */
import * as L from './languageIcons.js';

/* ── 分类枚举 ─────────────────────────────────────────────── */

export type FileKind =
  | 'ts'
  | 'tsx'
  | 'js'
  | 'jsx'
  | 'json'
  | 'jsonl'
  | 'html'
  | 'css'
  | 'scss'
  | 'vue'
  | 'svelte'
  | 'md'
  | 'tex'
  | 'py'
  | 'go'
  | 'rs'
  | 'java'
  | 'kt'
  | 'rb'
  | 'php'
  | 'c'
  | 'cpp'
  | 'sh'
  | 'yaml'
  | 'toml'
  | 'lock'
  | 'image'
  | 'pdf'
  | 'doc'
  | 'xls'
  | 'ppt'
  | 'archive'
  | 'text'
  | 'log'
  | 'license'
  | 'docker'
  | 'env'
  | 'git'
  | 'npmrc'
  | 'makefile'
  | 'config'
  | 'other';

/**
 * 根据 basename 推断分类。
 *   1. 特殊文件名优先 (package.json / .gitignore / Dockerfile / Makefile)
 *   2. 复合扩展名 (.d.ts / .config.js / .test.tsx)
 *   3. 普通扩展名按后缀归类
 */
export function classifyFile(name: string): FileKind {
  if (!name) return 'other';
  const lower = name.toLowerCase();

  // ── 特殊文件名 ─────────────────────────────────────
  if (lower === 'package.json' || lower === 'package-lock.json') return 'json';
  if (lower === 'tsconfig.json' || lower.endsWith('tsconfig.json')) return 'json';
  if (lower === '.gitignore' || lower === '.gitattributes' || lower === '.gitmodules') return 'git';
  if (lower === '.dockerignore') return 'git';
  if (lower === '.npmrc' || lower === '.yarnrc' || lower === '.yarnrc.yml' || lower === '.pnpmrc') return 'npmrc';
  if (lower === '.env' || lower.startsWith('.env.') || lower.endsWith('.env')) return 'env';
  if (lower === 'dockerfile' || lower === 'dockerfile.dev' || lower === 'containerfile') return 'docker';
  if (lower === 'makefile' || lower === 'gnumakefile' || lower === 'rakefile') return 'makefile';
  if (lower === 'license' || lower.startsWith('license')) return 'license';
  if (lower === 'readme.md' || lower === 'readme') return 'md';

  // ── 复合扩展 ──────────────────────────────────────
  if (lower.endsWith('.d.ts')) return 'ts';
  if (lower.endsWith('.test.ts') || lower.endsWith('.spec.ts')) return 'ts';
  if (lower.endsWith('.test.tsx') || lower.endsWith('.spec.tsx')) return 'tsx';
  if (lower.endsWith('.config.js') || lower.endsWith('.config.cjs') || lower.endsWith('.config.mjs')) return 'js';
  if (lower.endsWith('.config.ts')) return 'ts';

  // ── 普通扩展名 ──────────────────────────────────────
  const dot = lower.lastIndexOf('.');
  if (dot < 0) {
    if (lower === 'dockerfile') return 'docker';
    if (lower === 'makefile') return 'makefile';
    return 'other';
  }
  const ext = lower.slice(dot + 1);

  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
      return 'ts';
    case 'tsx':
      return 'tsx';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'js';
    case 'jsx':
      return 'jsx';
    case 'json':
      return 'json';
    case 'jsonl':
    case 'ndjson':
      return 'jsonl';
    case 'html':
    case 'htm':
    case 'xhtml':
      return 'html';
    case 'css':
      return 'css';
    case 'scss':
    case 'sass':
    case 'less':
      return 'scss';
    case 'vue':
      return 'vue';
    case 'svelte':
      return 'svelte';
    case 'md':
    case 'markdown':
      return 'md';
    case 'tex':
    case 'bib':
      return 'tex';
    case 'py':
    case 'pyi':
    case 'pyc':
      return 'py';
    case 'go':
      return 'go';
    case 'rs':
      return 'rs';
    case 'java':
      return 'java';
    case 'kt':
    case 'kts':
      return 'kt';
    case 'rb':
    case 'erb':
      return 'rb';
    case 'php':
    case 'phtml':
      return 'php';
    case 'c':
    case 'h':
      return 'c';
    case 'cpp':
    case 'cxx':
    case 'cc':
    case 'hpp':
    case 'hxx':
      return 'cpp';
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'fish':
      return 'sh';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'toml':
      return 'toml';
    case 'lock':
      return 'lock';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'svg':
    case 'ico':
    case 'bmp':
    case 'avif':
      return 'image';
    case 'pdf':
      return 'pdf';
    case 'doc':
    case 'docx':
    case 'rtf':
      return 'doc';
    case 'xls':
    case 'xlsx':
    case 'csv':
      return 'xls';
    case 'ppt':
    case 'pptx':
      return 'ppt';
    case 'zip':
    case 'tar':
    case 'gz':
    case 'tgz':
    case 'bz2':
    case '7z':
    case 'rar':
    case 'jar':
    case 'war':
      return 'archive';
    case 'txt':
      return 'text';
    case 'log':
      return 'log';
    default:
      return 'other';
  }
}

/**
 * 把 FileKind 对应到 languageIcons.tsx 里那个具体的 icon 组件.
 * 这一层映射确保每个 kind 都拿到对应形状 icon —
 * 不再有"所有 fallback 都是 FileOutlined"的问题.
 */
function pickFileIconKind(kind: FileKind): (props: { 'data-file-ext'?: FileKind; size?: number }) => JSX.Element {
  switch (kind) {
    case 'ts':        return L.TsIcon;
    case 'tsx':       return L.TsxIcon;
    case 'js':        return L.JsIcon;
    case 'jsx':       return L.JsxIcon;
    case 'json':      return L.JsonIcon;
    case 'jsonl':     return L.JsonlIcon;
    case 'html':      return L.HtmlIcon;
    case 'css':       return L.CssIcon;
    case 'scss':      return L.ScssIcon;
    case 'vue':       return L.VueIcon;
    case 'svelte':    return L.SvelteIcon;
    case 'md':        return L.MdIcon;
    case 'tex':       return L.TexIcon;
    case 'py':        return L.PyIcon;
    case 'go':        return L.GoIcon;
    case 'rs':        return L.RsIcon;
    case 'java':      return L.JavaIcon;
    case 'kt':        return L.KtIcon;
    case 'rb':        return L.RbIcon;
    case 'php':       return L.PhpIcon;
    case 'c':         return L.CIcon;
    case 'cpp':       return L.CppIcon;
    case 'sh':        return L.ShIcon;
    case 'yaml':      return L.YamlIcon;
    case 'toml':      return L.TomlIcon;
    case 'lock':      return L.LockIcon;
    case 'image':     return L.ImageIcon;
    case 'pdf':       return L.PdfIcon;
    case 'doc':       return L.DocIcon;
    case 'xls':       return L.XlsIcon;
    case 'ppt':       return L.PptIcon;
    case 'archive':   return L.ArchiveIcon;
    case 'text':      return L.TextIcon;
    case 'log':       return L.LogIcon;
    case 'license':   return L.LicenseIcon;
    case 'docker':    return L.DockerIcon;
    case 'env':       return L.EnvIcon;
    case 'git':       return L.GitIcon;
    case 'npmrc':     return L.NpmrcIcon;
    case 'makefile':  return L.MakefileIcon;
    case 'config':
    case 'other':
    default:
      return L.OtherIcon;
  }
}

export function FileIcon({ name }: { name: string }): JSX.Element {
  const kind = classifyFile(name);
  const Icon = pickFileIconKind(kind);
  return <Icon data-file-ext={kind} />;
}

export function DirIcon({ name, open }: { name: string; open?: boolean }): JSX.Element {
  // 不按子项细分(opencode 的文件夹图标种类繁多,VSCode 也是只有
  // src/ / test/ / node_modules/ 等才上专门图标,不值得为几个名字
  // 引入映射表).
  void name;
  return <L.DirIconSvg open={open} data-dir="true" />;
}
