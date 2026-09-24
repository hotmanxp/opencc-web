import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Empty, Input, Segmented, Spin, Switch, Tree, message } from 'antd';
import { XIcon, FolderOpenIcon, RotateCwIcon } from 'lucide-react';
import { FileIcon, DirIcon } from './fileIcon.js';
import type { DataNode } from 'antd/es/tree';
import { useFsList } from './useFsList.js';
import { useFsFile } from './useFsFile.js';
import { useFsSearch } from './useFsSearch.js';
import { useFsContentSearch } from './useFsContentSearch.js';
import { FsSearchList } from './FsSearchList.js';
import { FsContentSearchList } from './FsContentSearchList.js';
import type { FsFile, FilePreviewPayload } from '../../../shared/fs.js';
import { classifyKind } from '@shared/fileKind';
import { isDocumentPreviewKind } from '../desktop/FilePreviewBody.js';
import { DocumentPreview } from '../documentPreview/index.js';
import { useAgentStore } from '../../store/useAgentStore.js';
import { extToLanguage } from './extToLang.js';
import { MarkdownText } from '../markdown/MarkdownText.js';
import { FsContextMenu } from './FsContextMenu.js';
import { useFsWrite } from './useFsWrite.js';
import { useCodeThemeMode } from '../../hooks/useCodeThemeMode.js';

// TextEditor: dynamic-imported CodeMirror; we keep a module-scoped
// cache rather than React.lazy + Suspense so FsTab tests don't need
// to wait on a chunk that happy-dom never resolves. After the first
// import resolves, subsequent mounts reuse the cached reference.
type TextEditorComponent = React.ComponentType<{
  initialContent: string;
  language: string | null;
  saving?: boolean;
  onSave: (newContent: string) => void | Promise<void>;
  onCancel: () => void;
}>;
let cachedTextEditor: TextEditorComponent | null = null;
function loadTextEditor(): Promise<TextEditorComponent> {
  if (cachedTextEditor) return Promise.resolve(cachedTextEditor);
  return import('./TextEditor.js').then((m) => {
    cachedTextEditor = m.TextEditor;
    return cachedTextEditor;
  });
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

// Wrapper that resolves TextEditor via module-scoped cache (loadTextEditor)
// before mounting it. Avoids the Suspense-and-React.lazy pattern, which
// (a) happy-dom never resolves and (b) would couple FsTab to a Suspense
// boundary for a chunk that rarely matters. Edit mode is the only entry
// point — most users never trigger this lazy path.
function LazyTextEditor(props: {
  initialContent: string;
  language: string | null;
  saving?: boolean;
  onSave: (newContent: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [Editor, setEditor] = useState<TextEditorComponent | null>(cachedTextEditor);
  useEffect(() => {
    if (Editor) return;
    let cancelled = false;
    loadTextEditor().then((m) => {
      if (!cancelled) setEditor(() => m);
    });
    return () => {
      cancelled = true;
    };
  }, [Editor]);
  if (!Editor) {
    // Loading state — the editor needs ~540 KB chunk; show the same
    // padding/typography the editor will use so layout doesn't jump.
    return (
      <div
        data-testid="fs-editor-loading"
        className="flex-1 min-h-0 p-3 text-[color:var(--text-dim-45)] text-xs"
      >
        正在加载编辑器…
      </div>
    );
  }
  const TextEditor = Editor;
  return (
    <TextEditor
      initialContent={props.initialContent}
      language={props.language}
      saving={props.saving}
      onSave={props.onSave}
      onCancel={props.onCancel}
    />
  );
}

// We track loaded children in a map keyed by parent path.
type Entry = { name: string; path: string; type: 'dir' | 'file'; size: number | null };
type LoadedMap = Record<string, Entry[]>;

// HTML preview view mode. Defaults to 'preview' (the rendered iframe);
// users can flip to 'source' to read the markup directly. The state is
// kept in FsTab so it survives selection changes within the same cwd.
type HtmlMode = 'preview' | 'source';

/**
 * Render HTML preview inside a sandboxed <iframe>. The server hands us
 * a base64 data URL with mime `text/html`; we mount it as iframe.src so
 * scripts / images / links resolve inside the iframe document. The
 * sandbox attribute is the security boundary — we deliberately do NOT
 * include `allow-same-origin`, so the iframe is treated as a unique
 * opaque origin and cannot read cookies / localStorage / parent DOM.
 *
 * Source-toggle: when `mode === 'source'` we decode the base64 back to
 * raw markup and render it in a <pre>, so users can compare markup vs
 * render. The decoded string is memoized per dataUrl so toggling back
 * and forth doesn't repeat the work.
 *
 * Returns the column-flex wrapper expected by `fs-preview`. The
 * <iframe> gets `flex: 1` + explicit `min-height: 0` to inherit the
 * outer container's vertical scroll behavior and stretch to fill.
 */
function HtmlPreview({
  dataUrl,
  name,
  mode,
}: {
  dataUrl: string;
  name: string | undefined;
  mode: HtmlMode;
}): JSX.Element {
  // Decode base64 data URL back to raw markup for the source view.
  // Server writes `data:text/html;charset=utf-8;base64,<payload>`; the
  // payload is utf8-bytes-encoded via Buffer (latin1 round-trips bytes,
  // including multi-byte utf8 sequences, correctly back to the original
  // string when atob() decodes each byte). atob is available in modern
  // browsers and happy-dom. Failures fall back to the iframe view so
  // the user always sees *something*.
  const source = useMemo(() => {
    if (mode !== 'source') return null;
    const idx = dataUrl.indexOf('base64,');
    if (idx < 0) return null;
    try {
      return atob(dataUrl.slice(idx + 'base64,'.length));
    } catch {
      return null;
    }
  }, [dataUrl, mode]);

  if (mode === 'source' && source !== null) {
    return (
      <pre
        data-testid="fs-preview-html-source"
        className="flex-1 min-h-0 m-0 p-3 overflow-auto rounded-md font-mono text-xs whitespace-pre-wrap break-words"
        style={{
          background: 'var(--bg-faint-04)',
          color: 'var(--text-dim-85)',
          lineHeight: 1.55,
        }}
      >
        {source}
      </pre>
    );
  }

  return (
    <iframe
      data-testid="fs-preview-html"
      src={dataUrl}
      title={name ?? 'HTML preview'}
      // SECURITY: see file header. allow-scripts lets the HTML run its
      // own JS (we want that); allow-same-origin is INTENTIONALLY OMITTED
      // so the iframe is opaque-origin and can't reach into the parent.
      // No allow-forms / -popups / -top-navigation — these enable phishing
      // and tab hijacking without enabling anything users want from a
      // local HTML preview.
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className="flex-1 min-h-0 w-full border-0 rounded-md"
      style={{ background: 'var(--bg-card)' }}
    />
  );
}

/**
 * Build an absolute path from a session cwd and a tree-relative path,
 * preserving whatever separator convention the cwd uses. Server-side
 * `path.resolve` returns POSIX `/` on macOS/Linux but `\\` on Windows;
 * joining with a hard-coded `/` produces mixed separators that break
 * cmd-line / Git Bash pasting for the "Copy Absolute Path" action.
 *
 * Detection: pick `\\` when cwd contains a backslash, otherwise `/`.
 * Strip the trailing separator (either kind) before joining. Returns
 * relPath unchanged when cwd is null so downstream clipboard code still
 * has something to copy.
 *
 * Exported for testability — the right-click handler in this module is
 * the only caller in production.
 */
export function buildAbsPath(cwd: string | null, relPath: string): string {
  if (!cwd) return relPath;
  const sep = cwd.includes('\\') ? '\\' : '/';
  const trimmed = cwd.replace(/[\\/]$/, '');
  return relPath ? `${trimmed}${sep}${relPath}` : trimmed;
}

/**
 * 把系统拖入的 File 转成 FilePreviewDrawer 可消费的 payload(纯前端,不落盘)。
 *
 * 浏览器安全限制:从 Finder/资源管理器拖入的文件拿不到绝对路径
 * (Chrome 已移除 File.path),因此只能读内容本地预览,不能像树里
 * 选中的文件那样走 /api/fs/*(路径编辑/插入对话 @引用)。
 * - image  → readAsDataURL 得 dataUrl(FilePreviewBody 直接喂 <img>)
 * - html   → readAsText 得 utf8 content(iframe srcDoc 分支)
 * - text   → readAsText 得 content
 * - binary → 仅元数据 + ext,抽屉展示"不支持内联预览"提示
 */
async function fileToPreviewPayload(f: File): Promise<FilePreviewPayload> {
  const kind = classifyKind(f.name);
  const base = { path: f.name, size: f.size, mtime: f.lastModified };
  // 文档类(2026-09-21)在「系统拖入」这条路上拿不到绝对路径(浏览器不给
  // File.path),而 DocumentPreview 取字节必须走 /api/fs/raw 的绝对路径 ——
  // 所以退化成 binary 提示,而不是渲染一个必然 400 的文档预览。
  if (kind === 'binary' || isDocumentPreviewKind(kind)) {
    const idx = f.name.lastIndexOf('.');
    return { ...base, kind: 'binary', ext: idx > 0 ? f.name.slice(idx).toLowerCase() : undefined };
  }
  if (kind === 'image') {
    const dataUrl = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(r.error ?? new Error('readAsDataURL failed'));
      r.readAsDataURL(f);
    });
    return { ...base, kind, dataUrl, mime: f.type || undefined };
  }
  return { ...base, kind, content: await f.text() };
}

/**
 * Render the file content with Prism syntax highlighting when the
 * extension maps to a known code language; fall back to a plain
 * <pre> for prose-like files (.md / .json / .txt / unknown).
 *
 * The outer container (`fs-preview`) is the column-flex scroller; the
 * inner <pre> / SyntaxHighlighter only needs `flex: 1, min-height: 0`
 * to inherit that scroll behavior and grow with the panel height.
 */
function FilePreview({
  file,
  htmlMode,
  pendingLine,
}: {
  file: FsFile;
  htmlMode: HtmlMode;
  pendingLine: number | null;
}): JSX.Element {
  const { name } = file;
  const content = file.content ?? '';
  // 语法 token 配色按 <html data-theme> 在 oneDark / oneLight 之间切 —— 见
  // hooks/useCodeThemeMode.ts。以前这里恒用 oneDark:浅色主题下不仅「浅底 +
  // 浅色 token」糊成一片,oneDark 主题对象里的 `text-shadow: 0 1px rgba(0,0,0,.3)`
  // 还会被 react-syntax-highlighter 并进 <pre> 的行内样式并被所有 token 继承,
  // 在白底上就是每个字形下方一道深色重影(暗底上不可见,所以只在浅色主题暴露)。
  const themeMode = useCodeThemeMode();
  // We use a state-driven async pattern instead of React.lazy +
  // <Suspense> because (a) Suspense + lazy in happy-dom test env
  // doesn't resolve, leaving the fallback forever and tripping our
  // FsTab tests, and (b) it lets us cache the SyntaxHighlighter
  // component once across renders, avoiding reimport on every file
  // click. HLC carries both the component and the two theme style
  // sheets as separate fields, populated from the same module.
  const [hl, setHl] = useState<{
    SyntaxHighlighter: React.ComponentType<any>;
    oneDark: Record<string, React.CSSProperties>;
    oneLight: Record<string, React.CSSProperties>;
  } | null>(null);
  const lang = name ? extToLanguage(name) : null;
  useEffect(() => {
    if (!lang || hl) return;
    let cancelled = false;
    import('../markdown/syntaxHighlighter.js').then((m) => {
      if (!cancelled) {
        setHl({ SyntaxHighlighter: m.SyntaxHighlighter, oneDark: m.oneDark, oneLight: m.oneLight });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [lang, hl]);

  // pendingLine: scroll to that 1-based line and pulse a yellow highlight
  // for 2 seconds. Hooks MUST sit at the top of the component function,
  // before any early returns — otherwise React's rules-of-hooks ESLint
  // rule fails and the effect would run in the wrong order across renders.
  //
  // All three preview branches (code, plain text, MD) now emit per-line
  // `data-line` anchors, so the same `querySelector` path works everywhere
  // — no more brittle `lineHeight * (N-1)` math for the SyntaxHighlighter
  // branch (see FsTab.test "clicking a content search row … pendingLine"
  // and the wrapper-anchored regression test).
  //
  // Why `hl` is in the dep list: for code files the SyntaxHighlighter
  // chunk loads asynchronously. The first effect run after `pendingLine`
  // changes happens BEFORE the gutter spans are mounted, so the
  // querySelector returns null and we early-return. When `hl` resolves
  // (microtask later), React re-runs the effect with the same `pendingLine`
  // but with a populated `pendingRef`, and the querySelector hits the
  // data-line anchor. Without `hl` in the dep list, the second run never
  // happens and the jump effect silently no-ops. Plain-text / MD branches
  // mount synchronously, so the first run already finds the anchor and
  // they aren't affected by this dep.
  const pendingRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (pendingLine == null) return;
    const content = file.content ?? '';
    if (!content) return;
    const el = pendingRef.current?.querySelector<HTMLElement>(
      `[data-line="${pendingLine}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.style.transition = 'background 0.3s';
    el.style.background = 'rgba(255, 200, 0, 0.4)';
    const id = setTimeout(() => {
      el.style.background = '';
    }, 2000);
    return () => clearTimeout(id);
  }, [pendingLine, file.content, hl]);

  // Image kind: the server returned a base64 dataUrl for binary image
  // formats (png/jpg/gif/webp/bmp/ico/avif). Render with a plain <img>
  // — auto-fit, transparent background, checker pattern helps spot
  // transparency vs. solid images.
  if (file.kind === 'image' && file.dataUrl) {
    return (
      <div
        data-testid="fs-preview-image"
        className="flex-1 min-h-0 overflow-auto rounded-md flex items-start justify-center p-3"
        style={{
          backgroundImage:
            'linear-gradient(45deg, var(--bg-faint-05) 25%, transparent 25%), linear-gradient(-45deg, var(--bg-faint-05) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--bg-faint-05) 75%), linear-gradient(-45deg, transparent 75%, var(--bg-faint-05) 75%)',
          backgroundSize: '16px 16px',
          backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
        }}
      >
        <img
          src={file.dataUrl}
          alt={name ?? ''}
          className="max-w-full h-auto block"
        />
      </div>
    );
  }

  // HTML kind: server returned kind:'html' + a text/html dataUrl. Hand
  // off to <HtmlPreview>; that component owns the iframe vs source
  // toggle (driven by the Segmented control in the header).
  if (file.kind === 'html' && file.dataUrl) {
    return <HtmlPreview dataUrl={file.dataUrl} name={name} mode={htmlMode} />;
  }

  // 文档类(2026-09-21):/fs/file 只回了元数据({kind, path, size}),
  // 字节由 DocumentPreview 自己走 /api/fs/raw。渲染器只实现一次 —— 与
  // 对话抽屉 / 桌面预览共用 components/documentPreview。
  //
  // 注意:这个分支必须在**所有 hooks 之后**(与 image/html 分支同理),
  // 提前 return 会破环 rules-of-hooks。
  if (isDocumentPreviewKind(file.kind)) {
    return (
      // 用字面量而不是下面的 CONTAINER_CLASS:那个常量在 image/html 分支之后
      // 才声明,在这里引用会踩 TDZ。overflow-hidden(不是 auto)—— 文档渲染器
      // 各自管自己的滚动容器。
      <div data-testid="fs-preview-document" className="flex-1 min-h-0 overflow-hidden rounded-md">
        <DocumentPreview path={file.path ?? name ?? ''} kind={file.kind} />
      </div>
    );
  }

  const CONTAINER_CLASS = 'flex-1 min-h-0 overflow-auto rounded-md';

  // MD 分支: 在 lang 检查之前,先识别 .md / .markdown,走 MarkdownText。
  // 用 regex 而非 extToLanguage, 因为 extToLanguage 不把 MD 视为 code,
  // 返回 null, 会让 MD 落到 plain text 分支(就是现状的 bug)。
  if (name && /\.(md|markdown)$/i.test(name)) {
    return (
      <div ref={pendingRef} data-testid="fs-preview-md" className={CONTAINER_CLASS}>
        <MarkdownText text={content} />
      </div>
    );
  }

  if (lang) {
    // We use a state-driven async pattern instead of React.lazy +
    // <Suspense> because (a) Suspense + lazy in happy-dom test env
    // doesn't resolve, leaving the fallback forever and tripping our
    // FsTab tests, and (b) it lets us cache the SyntaxHighlighter
    // component once across renders, avoiding reimport on every file
    // click. The `useState` initialiser runs synchronously so the
    // very first mount can already render highlighted code if the
    // chunk is already cached from a previous click in the session.
    if (!hl) {
      return (
        <div data-testid="fs-preview-code" className={CONTAINER_CLASS}>
          <pre
            data-testid="fs-preview-code-fallback"
            className="m-0 p-3 font-mono text-xs whitespace-pre-wrap break-words"
            style={{
              background: 'var(--bg-faint-04)',
              color: 'var(--text-dim-85)',
              lineHeight: 1.55,
            }}
          >
            {content}
          </pre>
        </div>
      );
    }
    const { SyntaxHighlighter, oneDark, oneLight } = hl;
    return (
      <div ref={pendingRef} data-testid="fs-preview-code" className={CONTAINER_CLASS}>
        <SyntaxHighlighter
          language={lang}
          style={themeMode === 'light' ? oneLight : oneDark}
          customStyle={{
            margin: 0,
            // Right padding bumped to 44px so the floating line-number
            // gutter (added via showLineNumbers) doesn't sit on top of
            // the first character. Library defaults: gutter <code> uses
            // `float: left; paddingRight: 10px`, auto-minWidth based on
            // the largest line number. 44px is enough for files up to
            // 999 lines, which is well past the 200KB server cap.
            padding: '12px 12px 12px 44px',
            background: 'transparent',
            fontSize: 12,
            lineHeight: 1.55,
          }}
          codeTagProps={{ style: { fontFamily: MONO } }}
          wrapLongLines={false}
          // Per-line `data-line={N}` anchors. The library only attaches
          // `lineProps` when `wrapLines` is true (see highlight.js
          // createLineElement), so we set both. `wrapLines` and
          // `wrapLongLines` are independent flags — wrapLongLines stays
          // false so long lines don't word-wrap; wrapLines just toggles
          // per-line <span> wrapping. Without `showLineNumbers` we get
          // data-line anchors but no visible gutter; without wrapLines
          // we get the gutter but no anchors for the jump effect. Both
          // are required for the content-search row click to land
          // precisely on the matched line.
          wrapLines
          lineProps={(lineNumber: number) => ({
            'data-line': String(lineNumber),
          })}
          showLineNumbers
          // Subtle, non-clickable gutter: 11px font + ~35% opacity so
          // the line numbers don't compete with the code itself.
          lineNumberStyle={{
            color: 'var(--text-dim-35)',
            fontSize: 11,
          }}
        >
          {content}
        </SyntaxHighlighter>
      </div>
    );
  }
  return (
    <div ref={pendingRef} data-testid="fs-preview-text" className={CONTAINER_CLASS}>
      <pre
        className="m-0 p-3 whitespace-pre-wrap break-words"
        style={{
          background: 'var(--bg-faint-04)',
          color: 'var(--text-dim-85)',
        }}
      >
        {content.split('\n').map((line, idx) => (
          <span key={idx} data-line={idx + 1} className="block">
            {line}
          </span>
        ))}
      </pre>
    </div>
  );
}

// FilePreview is the largest pure subtree under FsTab: for a 2 MB text
// file it stitches ~50k `<span data-line>` nodes into the DOM, and on
// every FsTab re-render (search input change, header toggle, dirty dot
// update, etc.) React would otherwise re-walk that whole tree. The
// subtree is also pure — its only inputs are the file payload, the
// htmlMode toggle, and the pendingLine jump target — so memo() with a
// shallow-equality is a safe, cheap win. We deliberately compare the
// fields that actually drive the rendered DOM (path / kind / content
// slice / dataUrl / htmlMode / pendingLine) rather than `Object.is`,
// because `useFsFile` returns a fresh wrapper object on every fetch
// even when the underlying file payload is byte-identical.
//
// Caveat: this only suppresses the *re-render*. It does not reduce the
// absolute DOM size — that needs line virtualization. If we still see
// jank after this lands, the next step is to swap the inner
// `content.split('\n').map(...)` / `<SyntaxHighlighter>` branches for a
// windowed renderer. Don't do both at once; you want to be able to
// bisect the perf delta.
const FilePreviewMemo = memo(FilePreview, (prev, next) => {
  const a = prev.file;
  const b = next.file;
  if (a.path !== b.path) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'text' && a.content !== b.content) return false;
  if (a.kind === 'image' && a.dataUrl !== b.dataUrl) return false;
  if (a.kind === 'html' && a.dataUrl !== b.dataUrl) return false;
  if (prev.htmlMode !== next.htmlMode) return false;
  if (prev.pendingLine !== next.pendingLine) return false;
  return true;
});

/** 「文件」(文件树) tab 的哨兵 key. 文件 tab 的 key 是相对 cwd 的 POSIX 路径, 不会撞上它. */
const FILES_TAB = 'files';

/** tab 标题只显示 basename; 完整路径走 title 属性. */
function basenameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? path : path.slice(idx + 1);
}

/**
 * 一个 tab chip: [icon] [名字] [×].
 *
 * 用 div[role=tab] 而不是 <button>: 文件 tab 内部还要嵌一个关闭按钮,
 * button 不能嵌套 button. 键盘可达性 (Enter/Space 激活) 手动补齐.
 *
 * closable=false 用于「文件」tab —— 它始终存在, 关掉就没有文件树入口了.
 */
function TabItem({
  label,
  icon,
  active,
  closable,
  title,
  testId,
  onSelect,
  onClose,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  closable: boolean;
  title: string;
  testId: string;
  onSelect: () => void;
  onClose?: () => void;
}) {
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      data-testid={testId}
      title={title}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`shrink-0 flex items-center gap-1 h-7 pl-2 pr-1 rounded-t cursor-pointer select-none border-b-2 ${
        active
          ? 'border-b-[color:var(--accent-start)] text-[color:var(--text-primary)] bg-[var(--bg-card)]'
          : 'border-b-transparent text-[color:var(--text-secondary)] hover:bg-[var(--bg-card-hover)]'
      }`}
    >
      {icon}
      <span className="max-w-[160px] overflow-hidden text-ellipsis whitespace-nowrap text-xs">
        {label}
      </span>
      {closable && (
        <button
          type="button"
          data-testid={`${testId}-close`}
          aria-label={`关闭 ${label}`}
          title={`关闭 ${label}`}
          onClick={(e) => {
            e.stopPropagation();
            onClose?.();
          }}
          className="w-4 h-4 p-0 inline-flex items-center justify-center rounded border-0 bg-transparent cursor-pointer text-[10px] opacity-60 hover:opacity-100 text-[color:var(--text-dim-55)]"
        >
          <XIcon />
        </button>
      )}
    </div>
  );
}

export function FsTab({ cwd }: { cwd: string | null }) {
  const root = useFsList(cwd, '');
  // 打开的**文件** tab (相对 cwd 的路径, 按打开顺序). 「文件」tab 是隐式的
  // 第一个, 不入数组 —— 它不可关闭, 始终存在.
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  // 激活的 tab: FILES_TAB 或某个文件路径.
  const [activeKey, setActiveKey] = useState<string>(FILES_TAB);
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  const [loaded, setLoaded] = useState<LoadedMap>({});
  // 只有激活的文件 tab 才拉内容: 后台 tab 不占网络/内存, 切回来重新拉.
  // 代价是切 tab 有一次 loading 闪烁, 换来的是「打开 N 个文件 = N 次请求」
  // 变成最多 1 次.
  const selected = activeKey === FILES_TAB ? null : activeKey;
  const file = useFsFile(cwd, selected);
  const [contextMenu, setContextMenu] = useState<{ path: string; absPath: string; x: number; y: number; kind?: 'file' | 'dir' } | null>(null);
  // Search-mode toggle. When non-empty after trim, the left pane renders
  // <FsSearchList> instead of the directory tree. Right-side preview
  // (selected/file) is unchanged — search results reuse setSelected().
  // `draft` mirrors the input value; `submittedQuery` is what the hook
  // actually searches against. We commit on Enter (or clear-confirm) so
  // the user is not paying the search cost on every keystroke.
  const [draft, setDraft] = useState<string>('');
  const [submittedQuery, setSubmittedQuery] = useState<string>('');
  const search = useFsSearch(cwd, submittedQuery);
  // Content-search mode: 'name' (fuzzy filename) vs 'content' (ripgrep).
  // The Switch in the header toggles between them. When mode === 'content',
  // useFsContentSearch fires with `enabled: true`; otherwise it stays inert
  // so the user only pays the ripgrep cost when they explicitly opt in.
  const [mode, setMode] = useState<'name' | 'content'>('name');
  // pendingLine: 1-based line number passed to FilePreview when the user
  // clicks a content-search row. FilePreview scrolls the matching
  // <span data-line={n}> into view and pulses a yellow highlight for 2s.
  const [pendingLine, setPendingLine] = useState<number | null>(null);
  const contentSearch = useFsContentSearch(
    cwd,
    submittedQuery,
    { enabled: mode === 'content' },
  );
  // HTML preview view mode: 'preview' shows the rendered iframe,
  // 'source' shows the markup. Driven by a Segmented control rendered
  // only when the active file is HTML (see below).
  const [htmlMode, setHtmlMode] = useState<HtmlMode>('preview');
  // 系统拖入的悬浮高亮标记(拖入预览走 FilePreviewDrawer,见 handleFsDrop)
  const [dropHover, setDropHover] = useState(false);
  // True only when the currently-selected file is an HTML preview.
  // Used to gate the Segmented control in the header so it doesn't
  // appear for unrelated file types.
  const showHtmlToggle =
    !!file.data && file.data.kind === 'html' && !!file.data.dataUrl;
  // 当前文件是否文档类(docx/sheet/ppt/pdf/legacy-office)—— 决定预览区
  // 是否套用文本预览的 p-3 + 等宽字体外框。
  const activeIsDocument = !!file.data && isDocumentPreviewKind(file.data.kind);

  // Edit-mode state.
  const { save: saveFile, saving } = useFsWrite();
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set());

  // 打开(或聚焦)一个文件 tab. 已打开则只切过去, 不重复入栈.
  // line 非空时同时设置 pendingLine, 让 FilePreview 跳转到该行 (内容搜索
  // 结果点击); 普通打开 (文件树点击) 传 null, 清掉上一次的跳转目标 ——
  // 否则切到另一个 tab 时旧的行号会对新文件重新触发一次高亮/滚动.
  const openFile = useCallback((path: string, line: number | null = null) => {
    setOpenTabs((cur) => (cur.includes(path) ? cur : [...cur, path]));
    setActiveKey(path);
    setPendingLine(line);
  }, []);

  // 关闭一个文件 tab. 关掉的是当前激活 tab 时, 焦点依次退到右邻居 →
  // 左邻居 → 「文件」tab, 不会出现「tab 全关掉但面板空白」的状态.
  const closeTab = (path: string) => {
    const idx = openTabs.indexOf(path);
    if (idx < 0) return;
    const next = openTabs.filter((p) => p !== path);
    setOpenTabs(next);
    if (activeKey === path) {
      setActiveKey(next[idx] ?? next[idx - 1] ?? FILES_TAB);
    }
  };

  // Save handler — marks dirty by tree path key so renderTree lookup matches.
  const handleSave = async (path: string, content: string) => {
    const r = await saveFile(path, content);
    if (r.ok) {
      setDirtyPaths((prev) => {
        const next = new Set(prev);
        next.add(path);
        return next;
      });
      setEditingPath(null);
      void message.success('已保存');
    } else {
      void message.error(r.error ?? '保存失败');
    }
  };
  const handleCancel = () => {
    setEditingPath(null);
  };

  // 目录树 / 两个搜索列表共用的右键菜单打开器。path 为相对 cwd 的路径,
  // 与「复制相对路径」同值;absPath 由 buildAbsPath 还原绝对路径;kind 供
  // 「插入对话」生成对应类型的 @引用 chip。
  const openContextMenu = (p: string, x: number, y: number, kind?: 'file' | 'dir') => {
    setContextMenu({ path: p, absPath: buildAbsPath(cwd, p), x, y, kind });
  };

  // 系统文件拖入 → 前端读取内容,生成 payload 后打开右侧 FilePreviewDrawer
  // (与右键「预览」同一个抽屉,体验一致)。见 fileToPreviewPayload 注释:
  // 浏览器拿不到拖入文件的绝对路径,故只预览、不产生 @引用。
  const handleFsDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropHover(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    if (files.length > 1) void message.info(`检测到 ${files.length} 个文件,仅预览第一个(${files[0].name})`);
    try {
      const payload = await fileToPreviewPayload(files[0]);
      useAgentStore.getState().openFilePreviewLocal(payload);
    } catch (err) {
      void message.error(`读取文件失败:${(err as Error).message}`);
    }
  };

  // Reset on cwd change. 打开的 tab 全部作废 —— 它们是相对旧 cwd 的路径.
  useEffect(() => {
    setOpenTabs([]);
    setActiveKey(FILES_TAB);
    setExpandedKeys([]);
    setLoaded({});
    setContextMenu(null);
    setDraft('');
    setSubmittedQuery('');
    setMode('name');
    setPendingLine(null);
    setEditingPath(null);
    setDirtyPaths(new Set());
    setDropHover(false);
  }, [cwd]);

  if (!cwd) {
    return (
      <div className="p-4">
        <Empty description="未选择会话 cwd" />
      </div>
    );
  }

  // 拉取单个目录的 entries 并写入 loaded 映射。lazy 展开与「刷新」共用,
  // 保证刷新时能重拉已展开的子目录,而不只是根节点。
  const fetchDirEntries = async (key: string): Promise<void> => {
    try {
      const r = await fetch(`/api/fs/list?dir=${encodeURIComponent(key)}`);
      const j = await r.json();
      if (j?.ok && Array.isArray(j.entries)) {
        setLoaded((cur) => ({ ...cur, [key]: j.entries }));
      } else {
        setLoaded((cur) => ({ ...cur, [key]: [] }));
      }
    } catch {
      setLoaded((cur) => ({ ...cur, [key]: [] }));
    }
  };

  const handleLoadData = (treeNode: DataNode): Promise<void> => {
    const key = String(treeNode.key);
    if (loaded[key]) {
      return Promise.resolve();
    }
    return fetchDirEntries(key);
  };

  // 刷新目录树:重拉根目录,并重拉所有已加载(已展开)的子目录,让整棵
  // 树反映最新的文件状态。只调 root.refetch() 仅刷新根节点,懒加载的
  // 子目录(loaded 映射)会一直停留在旧状态 —— 这正是「刷新无效」的根因。
  const refreshAll = () => {
    void root.refetch();
    const loadedKeys = Object.keys(loaded);
    if (loadedKeys.length > 0) {
      void Promise.all(loadedKeys.map((key) => fetchDirEntries(key)));
    }
  };

  const renderTree = (entries: Array<{ name: string; path: string; type: 'dir' | 'file'; size: number | null }>): DataNode[] =>
    entries.map((e) => {
      const children = loaded[e.path];
      // For directory nodes:
      //   - children loaded → render real children (may be [] = empty dir)
      //   - children not yet loaded → leave `children` undefined so antd Tree
      //     fires `loadData` on expand (the previous version injected a
      //     `[ { __ph } ]` placeholder which made Tree think the node was
      //     already loaded and skip the fetch — that's why drill-down was
      //     stuck at every level).
      // Files are always leaves.
      const isLoaded = Object.prototype.hasOwnProperty.call(loaded, e.path);
      const isDirty = e.type === 'file' && dirtyPaths.has(e.path);
      return {
        key: e.path,
        title: (
          // 长文件名(2026-08-17-dsh-kernel-batch-00-baseline-dual-track.md 这种
          // 几十字符的 plan/spec 文件)在 fs-tree 受限宽度下默认换行,导致相邻
          // 节点文本相互重叠. 这里把 title 内的 <span> 切成 block + 满宽 +
          // nowrap + ellipsis;父级 .ant-tree-title 也已同步改 block + width:100%,
          // 配合 .ant-tree-node-content-wrapper 改成 flex:1 让剩余空间撑出来,
          // max-width:100% 在 inline-block 上的"父级由内容决定宽"循环依赖被破除.
          // dirty dot 维持 inline-block 圆点,不影响后续文本省略计算.
          <span
            title={e.name}
            className="font-mono text-xs block w-full overflow-hidden text-ellipsis whitespace-nowrap"
          >
            {isDirty && (
              <span
                data-testid={`fs-tree-dirty-${e.name}`}
                className="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle"
                style={{ background: 'rgba(255,102,0,0.7)' }}
              />
            )}
            {e.name}
          </span>
        ),
        icon:
          e.type === 'dir' ? (
            <DirIcon name={e.name} open={expandedKeys.includes(e.path)} />
          ) : (
            <FileIcon name={e.name} />
          ),
        isLeaf: e.type === 'file',
        children:
          e.type === 'dir'
            ? isLoaded
              ? renderTree(children ?? [])
              : undefined
            : undefined,
      } as DataNode;
    });

  const refreshBtn = (
    <Button
      size="small"
      icon={<RotateCwIcon />}
      loading={root.loading}
      onClick={refreshAll}
      title="刷新目录"
    >
      刷新
    </Button>
  );

  const treeData = root.data?.ok && root.data.entries ? renderTree(root.data.entries) : [];

  const isFilesTab = activeKey === FILES_TAB;
  // 头部路径行: 「文件」tab 显示 cwd 本身, 文件 tab 显示该文件的绝对路径.
  const activePathLabel = isFilesTab ? (cwd ?? '') : buildAbsPath(cwd, activeKey);

  return (
    <div
      data-testid="fs-tab-root"
      className="flex flex-col h-full"
      style={{
        outline: dropHover ? '2px dashed rgba(255,102,0,.55)' : 'none',
        outlineOffset: -2,
      }}
      onDragOver={(e) => {
        // 只响应系统文件拖入(Files 类型);其它拖拽不拦截
        if (e.dataTransfer?.types?.includes('Files')) {
          e.preventDefault();
          setDropHover(true);
        }
      }}
      onDragLeave={() => setDropHover(false)}
      onDrop={(e) => void handleFsDrop(e)}
    >
      {/* Tab 条: 「文件」(文件树, 不可关闭) + 已打开的文件 (可关闭).
          取代旧的「文件树 | 预览」左右分栏 —— 同一时刻只显示一个面板. */}
      <div
        data-testid="fs-tab-strip"
        role="tablist"
        className="flex items-center gap-1 px-2 pt-1 shrink-0 overflow-x-auto bg-[var(--bg-tab)] border-b border-b-[color:var(--border-light)]"
      >
        <TabItem
          testId="fs-tab-files"
          label="文件"
          title={cwd}
          icon={<FolderOpenIcon />}
          active={isFilesTab}
          closable={false}
          onSelect={() => setActiveKey(FILES_TAB)}
        />
        {openTabs.map((p) => (
          <TabItem
            key={p}
            testId={`fs-file-tab-${p}`}
            label={basenameOf(p)}
            title={buildAbsPath(cwd, p)}
            icon={<FileIcon name={basenameOf(p)} size={14} />}
            active={activeKey === p}
            closable
            onSelect={() => setActiveKey(p)}
            onClose={() => closeTab(p)}
          />
        ))}
      </div>
      <div
        data-testid="fs-tab-header"
        className="flex items-center gap-2 py-1.5 px-3 shrink-0 border-b border-b-[color:var(--border-light)]"
      >
        {/* 当前 tab 的路径: 「文件」tab 显示 cwd, 文件 tab 显示该文件的绝对
            路径. 搜索框只在「文件」tab 出现 —— 在文件 tab 上输入搜索词会把
            树的结果换掉, 而那时树并不在视野里. */}
        <span
          data-testid="fs-path"
          className="flex-1 min-w-0 font-mono text-xs truncate"
          style={{ color: 'var(--text-dim-55)' }}
          title={activePathLabel}
        >
          {activePathLabel}
        </span>
        {isFilesTab && (
          <>
            <Input
              data-testid="fs-search-input"
              size="small"
              placeholder="搜索文件…(回车搜索)"
              allowClear
              value={draft}
              onChange={(e) => {
                const v = e.target.value;
                setDraft(v);
                // Allowing the user to clear the search by hitting the
                // × icon (or selecting all + delete) should also collapse
                // back to the directory tree — so empty drafts commit
                // immediately, mirroring an "Enter" with no input.
                if (v === '') setSubmittedQuery('');
              }}
              onPressEnter={() => setSubmittedQuery(draft.trim())}
              className="w-44 shrink-0"
            />
            <Switch
              size="small"
              data-testid="fs-search-mode"
              aria-label="切换文件名/内容搜索"
              checked={mode === 'content'}
              onChange={(v) => setMode(v ? 'content' : 'name')}
              checkedChildren="内容"
              unCheckedChildren="文件名"
            />
          </>
        )}
        {showHtmlToggle && (
          <Segmented
            data-testid="fs-html-mode"
            size="small"
            value={htmlMode}
            onChange={(v) => setHtmlMode(v as HtmlMode)}
            options={[
              { label: '预览', value: 'preview' },
              { label: '源码', value: 'source' },
            ]}
          />
        )}
        {file.data && file.data.kind === 'text' && file.data.path && editingPath !== file.data.path && (
          <Button
            size="small"
            data-testid="fs-edit-btn"
            onClick={() => setEditingPath(file.data!.path!)}
          >
            编辑
          </Button>
        )}
        {editingPath && file.data && file.data.path === editingPath && file.data.kind === 'text' && (
          <>
            <Button
              size="small"
              data-testid="fs-save-btn"
              loading={saving}
              onClick={() => {
                const ev = new CustomEvent('fs-editor-get-doc');
                const editor = document.querySelector('[data-testid="fs-editor"]');
                let newContent: string | null = null;
                const handler = (e: Event) => {
                  newContent = (e as CustomEvent<string>).detail;
                };
                window.addEventListener('fs-editor-doc', handler);
                editor?.dispatchEvent(ev);
                window.removeEventListener('fs-editor-doc', handler);
                void handleSave(selected!, newContent ?? file.data!.content ?? '');
              }}
            >
              保存
            </Button>
            <Button size="small" data-testid="fs-cancel-btn" onClick={handleCancel}>
              取消
            </Button>
          </>
        )}
        {isFilesTab && refreshBtn}
      </div>
      {/* 面板区: 高度链路走 flex (SplitPane 的 Tabs 被 .zai-pane-fill 拉满),
          不再用 calc(100vh - Npx) 这类跟外层结构耦合的魔数. */}
      <div data-testid="fs-panel" className="flex-1 min-h-0">
        {isFilesTab ? (
          <div data-testid="fs-tree" className="h-full overflow-auto px-2 py-1">
            {submittedQuery.length > 0 ? (
              mode === 'content' ? (
                <FsContentSearchList
                  entries={contentSearch.data?.entries ?? []}
                  loading={contentSearch.loading}
                  error={contentSearch.error}
                  truncated={contentSearch.data?.truncated ?? false}
                  query={submittedQuery}
                  onSelect={(p, l) => openFile(p, l)}
                  onItemContextMenu={openContextMenu}
                />
              ) : (
                <FsSearchList
                  entries={search.data?.entries ?? []}
                  loading={search.loading}
                  error={search.error}
                  truncated={search.data?.truncated ?? false}
                  query={submittedQuery}
                  onSelect={(p) => openFile(p)}
                  onItemContextMenu={openContextMenu}
                />
              )
            ) : root.error && !root.data?.ok ? (
              <Empty description={root.error} />
            ) : root.loading && treeData.length === 0 ? (
              <div className="p-4 text-center">
                <Spin />
              </div>
            ) : treeData.length === 0 ? (
              <div className="p-4 text-xs" style={{ color: 'var(--text-dim-45)' }}>
                目录为空
              </div>
            ) : (
              <Tree
                treeData={treeData}
                showIcon
                // 目录树是纯导航控件: 节点文字是"点进去"的靶子, 拖选它没有
                // 意义 (要路径走右键菜单的"复制相对/绝对路径", 2026-09-20).
                // 不加这条时, 在树上拖拽会划出一片蓝底选中文本, 还会和
                // 单击打开文件/目录的手感打架.
                className="select-none"
                loadData={handleLoadData}
                expandedKeys={expandedKeys}
                onExpand={(keys) => setExpandedKeys(keys)}
                onSelect={(_keys, info) => {
                  // Files: open them in a new tab (or focus the existing one).
                  // Directories: toggle expand on click. Loading is lazy —
                  // adding an unloaded dir to expandedKeys triggers loadData
                  // since renderTree leaves `children` undefined until loaded.
                  const key = String(info.node.key);
                  if (info.node.isLeaf) {
                    openFile(key);
                  } else {
                    setExpandedKeys((cur) =>
                      cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key],
                    );
                  }
                }}
                onRightClick={({ node, event }) => {
                  event.preventDefault();
                  openContextMenu(String(node.key), event.clientX, event.clientY, node.isLeaf ? 'file' : 'dir');
                }}
              />
            )}
          </div>
        ) : (
          <div
            data-testid="fs-preview"
            className={
              // 文档类由 DocxRenderer/SheetRenderer 等自带内边距与正文字体,
              // 继承 fs-preview 的 p-3 + font-mono 会让表格/正文错位。
              activeIsDocument
                ? 'h-full flex flex-col overflow-hidden text-xs'
                : 'h-full flex flex-col p-3 overflow-hidden font-mono text-xs'
            }
          >
            {file.loading ? (
              <div className="text-center p-6">
                <Spin />
              </div>
            ) : file.error ? (
              <Empty description={file.error} />
            ) : file.data && editingPath && file.data.path === editingPath && file.data.kind === 'text' && file.data.content !== undefined ? (
              <LazyTextEditor
                initialContent={file.data.content}
                language={file.data.name ? extToLanguage(file.data.name) : null}
                saving={saving}
                onSave={(newContent) => void handleSave(editingPath, newContent)}
                onCancel={handleCancel}
              />
            ) : file.data && (file.data.content !== undefined || file.data.kind === 'image' || file.data.kind === 'html' || isDocumentPreviewKind(file.data.kind)) ? (
              <FilePreviewMemo file={file.data} htmlMode={htmlMode} pendingLine={pendingLine} />
            ) : (
              <Empty description="没有内容" />
            )}
          </div>
        )}
      </div>
      {contextMenu && cwd && (
        <FsContextMenu
          path={contextMenu.path}
          absPath={contextMenu.absPath}
          cwd={cwd}
          kind={contextMenu.kind}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
          onDeleted={() => {
            setContextMenu(null);
            // 被删掉的文件可能正开在某个 tab 里 —— 关掉它, 免得留一个
            // 永远报「文件不存在」的僵尸 tab.
            closeTab(contextMenu.path);
            refreshAll();
          }}
        />
      )}
    </div>
  );
}