import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Empty, Input, Segmented, Spin, Switch, Tag, Tree, message } from 'antd';
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
import { LazyMonacoCodeView, type MonacoCodeViewApi } from './MonacoCodeView.js';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

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
  // 3-state view mode for .md / .html files(预览 / 源码 / 编辑)。
  // 2026-09-27:扩展原 htmlMode 仅为 HTML 服务的 2-state 模式,把 markdown
  // 也拉进来;非 .md/.html 文本文件(viewMode 字段无效)走默认「编辑」路径。
  // 切到不同文件时由下面的 useEffect 把 viewMode 重置为合适的初值。
  const [viewMode, setViewMode] = useState<'preview' | 'source' | 'edit'>('preview');
  // 系统拖入的悬浮高亮标记(拖入预览走 FilePreviewDrawer,见 handleFsDrop)
  const [dropHover, setDropHover] = useState(false);
  // True only when the currently-selected file is .md or .html — gates the
  // Segmented control in the header so it doesn't appear for unrelated types.
  const isMd = !!file.data && file.data.kind === 'text' && /\.(md|markdown)$/i.test(file.data.name ?? '');
  const isHtml = !!file.data && file.data.kind === 'html' && !!file.data.dataUrl;
  const showViewModeToggle = isMd || isHtml;
  // 当前文件是否文档类(docx/sheet/ppt/pdf/legacy-office)—— 决定预览区
  // 是否套用文本预览的 p-3 + 等宽字体外框。
  const activeIsDocument = !!file.data && isDocumentPreviewKind(file.data.kind);

  // Edit-mode state. 2026-09-27:与 AA file-preview-page.tsx 的 UX 状态机同步:
  //   - saveState:   'idle' | 'saving' | 'saved' | 'conflict'
  //   - savedFlashAt:显示「已保存」徽章 1.5s 后自动清空
  //   - editSha256:  GET 响应里的 sha256,PUT 时回传 ifMatch 做乐观并发
  //   - editorRef:   MonacoCodeView onReady 注入的 api(getValue/openSearch/...)
  //   - initialContentRef: 进入编辑时锁定 baseline,onChange 用它判 dirty
  //   - dirtyPaths:  从「最近保存过」改为「用户动过文件」(详见 renderTree)
  const { save: saveFile, saving } = useFsWrite();
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set());
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'conflict'>('idle');
  const [savedFlashAt, setSavedFlashAt] = useState<number | null>(null);
  const [editSha256, setEditSha256] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const editorRef = useRef<MonacoCodeViewApi | null>(null);
  const initialContentRef = useRef<string>('');
  const lastSavedContentRef = useRef<string>('');

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

  // Save handler — 2026-09-27:与 AA 同步,加 ifMatch + saveState/savedFlashAt
  // 状态机;CONFLICT 不退出编辑模式(用户需主动「重新加载」或重新编辑)。
  const handleSave = async (path: string, content: string, ifMatch: string | null) => {
    setSaveState('saving');
    setSaveError(null);
    const r = await saveFile(path, content, ifMatch);
    if (r.ok) {
      // 成功:更新 sha256 + dirty 标记 + saved flash;不退出编辑模式(AA 风格,
      // 用户可继续修改)。
      setEditSha256(r.sha256 ?? null);
      lastSavedContentRef.current = content;
      setDirtyPaths((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
      setSaveState('saved');
      setSavedFlashAt(Date.now());
      window.setTimeout(() => setSavedFlashAt(null), 1500);
      void message.success('已保存');
    } else if (r.code === 'CONFLICT') {
      // 冲突:不覆盖 sha256(保留原值供「保存覆盖」按钮用),让 UI 显示
      // 重新加载按钮。dirty 仍标记(用户的本地编辑 ≠ diskSha256 对应内容)。
      setSaveState('conflict');
      setSaveError(r.error ?? '文件已被修改,请重新加载');
    } else {
      setSaveState('idle');
      setSaveError(r.error ?? '保存失败');
      void message.error(r.error ?? '保存失败');
    }
  };
  const handleCancel = () => {
    setEditingPath(null);
    setSaveState('idle');
    setSaveError(null);
  };
  // 冲突后:丢弃本地编辑,重新拉服务端版本。
  // useFsFile 的 effect 只在 path/cwd 变化时拉取;同 path 不变,所以用一个
  // toggleKey 让 useFsFile 跳一下空再回来,触发重新 GET /fs/file。
  const reloadToggleRef = useRef(0);
  const handleReloadAfterConflict = () => {
    setSaveState('idle');
    setSaveError(null);
    // 关掉当前 file tab → 选中「文件」tab,再把同一路径加回去 → useFsFile 重拉。
    if (selected) {
      const path = selected;
      reloadToggleRef.current += 1;
      setOpenTabs((cur) => cur.filter((p) => p !== path));
      setActiveKey(FILES_TAB);
      // 用 setTimeout 推一帧,确保 React 已 commit 完 null path,再切回。
      window.setTimeout(() => {
        setOpenTabs((cur) => (cur.includes(path) ? cur : [...cur, path]));
        setActiveKey(path);
        setEditingPath(null);
      }, 0);
    }
  };
  // onChange:从 MonacoCodeView 同步当前内容到 baseline 比对 → dirty 标记。
  const handleEditorChange = (value: string) => {
    if (selected && value !== initialContentRef.current) {
      setDirtyPaths((prev) => {
        const next = new Set(prev);
        next.add(selected);
        return next;
      });
    } else if (selected) {
      setDirtyPaths((prev) => {
        const next = new Set(prev);
        next.delete(selected);
        return next;
      });
    }
  };
  // onReady:MonacoCodeView api 注入到 editorRef;同时把 baseline 锁定。
  const handleEditorReady = (api: typeof editorRef.current) => {
    editorRef.current = api;
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
    setSaveState('idle');
    setSavedFlashAt(null);
    setEditSha256(null);
    setSaveError(null);
    setViewMode('preview');
    initialContentRef.current = '';
    lastSavedContentRef.current = '';
  }, [cwd]);

  // 切到不同文件时:重置 viewMode 为 'preview'(让用户从渲染视图开始浏览),
  // 并同步 editingPath —— 当 viewMode === 'edit' 时进入编辑会话,否则退出。
  useEffect(() => {
    if (file.data?.path) {
      setViewMode('preview');
    }
  }, [file.data?.path]);

  // viewMode 切到 'edit' 时初始化编辑会话(锁定 baseline + sha256);
  // 切到 'preview'/'source' 时退出编辑。
  useEffect(() => {
    if (viewMode === 'edit' && file.data && file.data.kind === 'text') {
      setEditingPath(file.data.path);
      initialContentRef.current = file.data.content ?? '';
      lastSavedContentRef.current = file.data.content ?? '';
      setEditSha256(file.data.sha256 ?? null);
      setSaveState('idle');
      setSaveError(null);
    } else {
      setEditingPath(null);
      // 退出编辑时清掉 save 状态(用户切到 'source'/'preview' 后再回来需要重置)
      setSaveState('idle');
      setSaveError(null);
      setSavedFlashAt(null);
    }
  }, [viewMode, file.data?.path]);

  // 2026-09-27:全局 Cmd/Ctrl+F + Cmd/Ctrl+S(capture phase),仅在当前 tab 进入
  // 编辑模式时拦截。对齐 AA file-preview-page.tsx:485-501。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const activeIsEditing =
        !!editingPath && editingPath === activeKey && file.data?.kind === 'text';
      if (!activeIsEditing) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === 's') {
        event.preventDefault();
        if (saveState === 'saving') return;
        const content = editorRef.current?.getValue() ?? file.data?.content ?? '';
        void handleSave(editingPath, content, editSha256);
        return;
      }
      if (key === 'f') {
        if (!editorRef.current) return;
        event.preventDefault();
        editorRef.current.openSearch();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [activeKey, editingPath, editSha256, file.data, saveState]);

  // 2026-09-27:beforeunload 警告(dirty=true 时)。注意:Chrome 不允许自
  // 定义提示语,只能 returnValue="" 触发原生确认框。
  const activeIsDirty = !!activeKey && activeKey !== 'files' && dirtyPaths.has(activeKey);
  useEffect(() => {
    if (!activeIsDirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [activeIsDirty]);

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
            树的结果换掉, 而那时树并不在视野里.
            「文件」tab 时把路径 span 设 hidden —— 路径信息仍写在 DOM 里
            (testid fs-path, FsTab.test 仍能读到 textContent),只是不让它
            占据 flex 空间,搜索 Input 才能 flex-1 占满宽度. */}
        <span
          data-testid="fs-path"
          className={
            isFilesTab
              ? 'hidden'
              : 'flex-1 min-w-0 font-mono text-xs truncate'
          }
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
              // 占满头部行剩余空间:「文件」tab 时 cwd 路径已 hidden,
              // 搜索框用 flex-1 撑满,Switch 与清空按钮贴右.
              className="flex-1 min-w-0"
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
        {showViewModeToggle && (
          <Segmented
            data-testid="fs-view-mode"
            size="small"
            value={viewMode}
            onChange={(v) => setViewMode(v as 'preview' | 'source' | 'edit')}
            options={[
              { label: '预览', value: 'preview' },
              { label: '源码', value: 'source' },
              { label: '编辑', value: 'edit' },
            ]}
          />
        )}
        {file.data && file.data.kind === 'text' && file.data.path && editingPath !== file.data.path && !isMd && (
          // 只在非 .md 文件显示「编辑」按钮:.md 用 Segmented 切 3 状态,
          // .html 走 html kind(也用 Segmented)。其他代码文件(.ts/.py/...)
          // 保留单击进入编辑的快捷方式,Monaco 一直可写(readOnly 翻转)。
          <Button
            size="small"
            data-testid="fs-edit-btn"
            onClick={() => {
              setViewMode('edit');
              // 锁定 baseline = 当前 server 拉到的内容;同时记 sha256。
              // viewMode 改 'edit' 会触发上面的 useEffect 自动 init。
            }}
          >
            编辑
          </Button>
        )}
        {/* 编辑模式徽章(2026-09-27,与 AA PreviewBadges 同步):
            - saving     → <Tag>保存中…</Tag>
            - saved      → <Tag color="success">已保存</Tag>(1.5s 自动消失)
            - conflict   → <Tag color="error">文件已被修改</Tag>(带「重新加载」)
            - 其他错误   → <Tag color="error">{saveError}</Tag>
            - truncated  → <Tag>文件已截断显示</Tag>(>=2MB)
        */}
        {editingPath && file.data && file.data.path === editingPath && file.data.kind === 'text' && saveState === 'saving' && (
          <Tag data-testid="fs-saving-badge">保存中…</Tag>
        )}
        {editingPath && saveState === 'saved' && savedFlashAt !== null && (
          <Tag color="success" data-testid="fs-saved-badge">已保存</Tag>
        )}
        {editingPath && saveState === 'conflict' && (
          <span className="flex items-center gap-1">
            <Tag color="error" data-testid="fs-conflict-badge">文件已被修改,请重新加载</Tag>
            <Button size="small" data-testid="fs-conflict-reload-btn" onClick={handleReloadAfterConflict}>
              重新加载
            </Button>
          </span>
        )}
        {editingPath && saveState === 'idle' && saveError && (
          <Tag color="error" data-testid="fs-save-error-badge">{saveError}</Tag>
        )}
        {file.data && file.data.kind === 'text' && (file.data.truncated || (file.data.content !== undefined && file.data.content.length >= 2 * 1024 * 1024)) && (
          <Tag data-testid="fs-truncated-badge">文件已截断显示</Tag>
        )}
        {editingPath && file.data && file.data.path === editingPath && file.data.kind === 'text' && (
          <>
            <Button
              size="small"
              data-testid="fs-save-btn"
              loading={saveState === 'saving'}
              disabled={saveState === 'saving'}
              onClick={() => {
                const content = editorRef.current?.getValue() ?? file.data!.content ?? '';
                void handleSave(editingPath, content, editSha256);
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
            ) : file.data && file.data.kind === 'text' && file.data.content !== undefined && isMd && viewMode === 'preview' ? (
              // .md 预览:走 MarkdownText(对齐原 FilePreview 的 MD 分支);
              // Monaco 此时 hidden 仍 mounted,切回源码/编辑保留滚动位置与未保存编辑。
              <div data-testid="fs-md-preview" className="flex-1 min-h-0 overflow-auto rounded-md p-3">
                <MarkdownText text={file.data.content} />
              </div>
            ) : file.data && file.data.kind === 'html' && isHtml && viewMode === 'preview' ? (
              // .html 预览:FilePreview 现有 iframe 路径不变。
              <FilePreviewMemo file={file.data} htmlMode="preview" pendingLine={pendingLine} />
            ) : file.data && file.data.kind === 'text' && file.data.content !== undefined ? (
              // 其它 text(.md source/edit, 其它代码文件):统一走 Monaco,
              // editable 由 viewMode 决定(.md 'source' → readOnly, 'edit' → 可写)。
              <LazyMonacoCodeView
                content={file.data.content}
                documentKey={file.data.path}
                fileName={file.data.name ?? undefined}
                language={
                  isMd
                    ? 'markdown'
                    : file.data.name
                      ? extToLanguage(file.data.name) ?? undefined
                      : undefined
                }
                editable={editingPath === file.data.path}
                onReady={handleEditorReady}
                onChange={handleEditorChange}
              />
            ) : file.data && file.data.kind === 'html' && (viewMode === 'source' || viewMode === 'edit') ? (
              // .html 源码/编辑:与 .md 一样走 Monaco,language='html',
              // viewMode 决定 editable;切到 'preview' 才回 iframe。
              <LazyMonacoCodeView
                content={file.data.content}
                documentKey={file.data.path}
                fileName={file.data.name ?? undefined}
                language="html"
                editable={viewMode === 'edit'}
                onReady={handleEditorReady}
                onChange={handleEditorChange}
              />
            ) : file.data && file.data.kind === 'html' ? (
              <FilePreviewMemo file={file.data} htmlMode="preview" pendingLine={pendingLine} />
            ) : file.data && (file.data.kind === 'image' || isDocumentPreviewKind(file.data.kind)) ? (
              <FilePreviewMemo file={file.data} htmlMode="preview" pendingLine={pendingLine} />
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