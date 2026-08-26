import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Empty, Input, Segmented, Spin, Switch, Tree, message } from 'antd';
import { LockOutlined, ReloadOutlined, UnlockOutlined } from '@ant-design/icons';
import { FileIcon, DirIcon } from './fileIcon.js';
import type { DataNode } from 'antd/es/tree';
import { useFsList } from './useFsList.js';
import { useFsFile } from './useFsFile.js';
import { useFsSearch } from './useFsSearch.js';
import { useFsContentSearch } from './useFsContentSearch.js';
import { FsSearchList } from './FsSearchList.js';
import { FsContentSearchList } from './FsContentSearchList.js';
import type { FsFile } from '../../../shared/fs.js';
import { extToLanguage } from './extToLang.js';
import { MarkdownText } from '../markdown/MarkdownText.js';
import { FsContextMenu } from './FsContextMenu.js';
import { useFsWrite } from './useFsWrite.js';
import {
  DEFAULT_FS_TREE_WIDTH,
  FS_TREE_MAX_WIDTH,
  FS_TREE_MIN_WIDTH,
  STORAGE_KEYS,
  clampFsTreeWidth,
  useLocalStorageState,
} from './shared.js';

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
        style={{
          flex: 1,
          minHeight: 0,
          padding: 12,
          color: 'var(--text-dim-45)',
          fontSize: 12,
        }}
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
        style={{
          flex: 1,
          minHeight: 0,
          margin: 0,
          padding: 12,
          overflow: 'auto',
          background: 'var(--bg-faint-04)',
          color: 'var(--text-dim-85)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          borderRadius: 6,
          fontFamily: MONO,
          fontSize: 12,
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
      style={{
        flex: 1,
        minHeight: 0,
        width: '100%',
        border: 'none',
        borderRadius: 6,
        background: 'var(--bg-card)',
      }}
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
  // We use a state-driven async pattern instead of React.lazy +
  // <Suspense> because (a) Suspense + lazy in happy-dom test env
  // doesn't resolve, leaving the fallback forever and tripping our
  // FsTab tests, and (b) it lets us cache the SyntaxHighlighter
  // component once across renders, avoiding reimport on every file
  // click. HLC carries both the component and the oneDark style
  // sheet as separate fields, populated from the same module.
  const [hl, setHl] = useState<{
    SyntaxHighlighter: React.ComponentType<any>;
    oneDark: Record<string, React.CSSProperties>;
  } | null>(null);
  const lang = name ? extToLanguage(name) : null;
  useEffect(() => {
    if (!lang || hl) return;
    let cancelled = false;
    import('../markdown/syntaxHighlighter.js').then((m) => {
      if (!cancelled) setHl({ SyntaxHighlighter: m.SyntaxHighlighter, oneDark: m.oneDark });
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
    const containerStyle: React.CSSProperties = {
      flex: 1,
      minHeight: 0,
      overflow: 'auto',
      borderRadius: 6,
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'center',
      padding: 12,
      backgroundImage:
        'linear-gradient(45deg, var(--bg-faint-05) 25%, transparent 25%), linear-gradient(-45deg, var(--bg-faint-05) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--bg-faint-05) 75%), linear-gradient(-45deg, transparent 75%, var(--bg-faint-05) 75%)',
      backgroundSize: '16px 16px',
      backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
    };
    return (
      <div data-testid="fs-preview-image" style={containerStyle}>
        <img
          src={file.dataUrl}
          alt={name ?? ''}
          style={{
            maxWidth: '100%',
            height: 'auto',
            display: 'block',
          }}
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

  const containerStyle: React.CSSProperties = {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    borderRadius: 6,
  };

  // MD 分支: 在 lang 检查之前,先识别 .md / .markdown,走 MarkdownText。
  // 用 regex 而非 extToLanguage, 因为 extToLanguage 不把 MD 视为 code,
  // 返回 null, 会让 MD 落到 plain text 分支(就是现状的 bug)。
  if (name && /\.(md|markdown)$/i.test(name)) {
    return (
      <div ref={pendingRef} data-testid="fs-preview-md" style={containerStyle}>
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
        <div data-testid="fs-preview-code" style={containerStyle}>
          <pre
            data-testid="fs-preview-code-fallback"
            style={{
              margin: 0,
              padding: 12,
              background: 'var(--bg-faint-04)',
              color: 'var(--text-dim-85)',
              fontFamily: MONO,
              fontSize: 12,
              lineHeight: 1.55,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {content}
          </pre>
        </div>
      );
    }
    const { SyntaxHighlighter, oneDark } = hl;
    return (
      <div ref={pendingRef} data-testid="fs-preview-code" style={containerStyle}>
        <SyntaxHighlighter
          language={lang}
          style={oneDark}
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
    <div ref={pendingRef} data-testid="fs-preview-text" style={containerStyle}>
      <pre
        style={{
          margin: 0,
          padding: 12,
          background: 'var(--bg-faint-04)',
          color: 'var(--text-dim-85)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {content.split('\n').map((line, idx) => (
          <span key={idx} data-line={idx + 1} style={{ display: 'block' }}>
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

export function FsTab({ cwd }: { cwd: string | null }) {
  const root = useFsList(cwd, '');
  const [selected, setSelected] = useState<string | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  const [loaded, setLoaded] = useState<LoadedMap>({});
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
  // True only when the currently-selected file is an HTML preview.
  // Used to gate the Segmented control in the header so it doesn't
  // appear for unrelated file types.
  const showHtmlToggle =
    !!file.data && file.data.kind === 'html' && !!file.data.dataUrl;

  // Edit-mode state.
  const { save: saveFile, saving } = useFsWrite();
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set());

  // 文件树 ↔ 预览区 之间的宽度 (相对 FsTab 自身, 整数百分比).
  // 持久化到 localStorage, 跨刷新保留; 范围 15-85% 由 clampFsTreeWidth 守卫.
  // 拖动锁 (跟 SplitPane 一致): 默认锁定防误触, 点悬浮按钮解锁后才能拖动.
  const [widthStored, setWidthStored] = useLocalStorageState<number>(
    STORAGE_KEYS.fsTreeWidth,
    DEFAULT_FS_TREE_WIDTH,
  );
  const fsTreeWidth = clampFsTreeWidth(widthStored);
  const [lockedStored, setLockedStored] = useLocalStorageState<boolean>(
    STORAGE_KEYS.fsTreeLocked,
    true,
  );

  // Splitter drag state. widthStored 存的是百分比 (整数), 但 mouse 移动
  // 给出 px; 拖拽过程中实时把 px delta 折算成 pct delta:
  //   delta_pct = delta_px / startWPx * 100
  // 然后加到 startW (pct) 上, clamp 进 [MIN, MAX].
  //
  // 关键: 分母必须是 *拖动开始时* fs-tree 的 px 宽度 (startWPx), 而不是
  // 每次 move 时实时读 clientWidth. 因为 setWidthStored 会立即触发 React
  // re-render, fs-tree 的 width 变 → clientWidth 跟着变. 如果分母用变化的
  // clientWidth, delta_pct = delta_px / 变化的分母 → 鼠标移动距离和 fs-tree
  // 实际变化非线性 (用户感觉鼠标"飘"或"加速")。用 startWPx 锁定分母, 整个
  // 拖动过程 delta_pct 跟鼠标移动呈纯线性: 鼠标走 X px, fs-tree 增/减
  // X / startWPx * 100 %.
  const fsTreeContainerRef = useRef<HTMLDivElement | null>(null);
  // 拖拽时用「父容器宽度」作为 px→pct 换算分母. fs-tree 的 width 是百分比,
  // 相对的是父级 flex 容器 (FsTab.tsx 里 `display:flex` 那行), 不是 fs-tree
  // 自身. 若分母用 fs-tree 自身的 clientWidth (它总是 < 容器宽), delta_pct =
  // delta_px / fsTreePx * 100 会被放大成 delta_px / (W/100) — 文件树右边缘
  // 移动 `100/W` 倍于鼠标距离 (W=40 时是 2.5x), 就是用户感觉"拖拽距离和鼠标
  // 不一样、树飘过去"的根因. 分母锁在鼠标按下时的容器宽 (拖动期间不变),
  // 让 delta_pct 跟鼠标移动严格 1:1 线性.
  const dragRef = useRef<{ startX: number; startW: number; containerPx: number } | null>(null);
  const onFsHandleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // 防御性 bail: 锁定时不应触发拖动 (UI 上 drag surface 的 pointer-events
      // 已被设为 none, 但 hook 自身也短路避免任何 race 触发越权写入).
      if (lockedStored) return;
      const container = fsTreeContainerRef.current?.parentElement;
      const containerPx = container?.clientWidth || 0;
      // 拿不到父容器宽度 (如未挂载 / 隐藏) 就不启动拖动, 避免分母为 0 除零.
      if (!containerPx) return;
      dragRef.current = { startX: e.clientX, startW: fsTreeWidth, containerPx };
      const onMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        // Drag right → grow fs-tree (follow mouse direction); left → shrink.
        // 直觉: handle 在 fs-tree 的 right 边缘 (position: absolute, right: -6),
        // fs-tree 的 width 是 ${pct}%. 鼠标向右移动 X px:
        //   - delta_pct = delta_px / containerPx * 100 → fs-tree 右边缘恰好
        //     移动 delta_px px, handle (right: -6) 跟着 fs-tree 右边缘同步走
        //   - handle 在视觉上跟着鼠标走, fs-tree 也跟着鼠标走 → 1:1 一致
        // 分母锁在 mouseDown 时记录的 containerPx — 拖动期间不变 (delta_pct
        // 跟鼠标移动纯线性); 若用实时变化的 clientWidth (setWidthStored 触发
        // re-render 后 fs-tree / 容器宽度都会变), delta_pct 会非线性"飘".
        const deltaPx = ev.clientX - dragRef.current.startX;
        const deltaPct = (deltaPx / dragRef.current.containerPx) * 100;
        const next = dragRef.current.startW + deltaPct;
        setWidthStored(clampFsTreeWidth(next));
      };
      const onUp = () => {
        dragRef.current = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [fsTreeWidth, setWidthStored, lockedStored],
  );

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

  // Reset on cwd change.
  useEffect(() => {
    setSelected(null);
    setExpandedKeys([]);
    setLoaded({});
    setContextMenu(null);
    setDraft('');
    setSubmittedQuery('');
    setMode('name');
    setPendingLine(null);
    setEditingPath(null);
    setDirtyPaths(new Set());
  }, [cwd]);

  if (!cwd) {
    return (
      <div style={{ padding: 16 }}>
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
            style={{
              fontFamily: MONO,
              fontSize: 12,
              display: 'block',
              width: '100%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {isDirty && (
              <span
                data-testid={`fs-tree-dirty-${e.name}`}
                style={{
                  display: 'inline-block',
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: 'rgba(255,102,0,0.7)',
                  marginRight: 6,
                  verticalAlign: 'middle',
                }}
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
      icon={<ReloadOutlined />}
      loading={root.loading}
      onClick={refreshAll}
      title="刷新目录"
    >
      刷新
    </Button>
  );

  const treeData = root.data?.ok && root.data.entries ? renderTree(root.data.entries) : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        data-testid="fs-tab-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          borderBottom: '1px solid var(--border-light)',
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--text-dim-55)', whiteSpace: 'nowrap' }}>
          Files
        </span>
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
          style={{ flex: 1 }}
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
        {refreshBtn}
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div
          ref={fsTreeContainerRef}
          data-testid="fs-tree"
          style={{
            // 宽度用百分比 (相对 FsTab 容器), 持久化到 localStorage, 用户
            // 拖动调整; position:relative 让内部的 drag handle / lock 按钮
            // 用 absolute 锚定到 fs-tree 右边缘 (borderRight 视觉分割线).
            flex: '0 0 auto',
            width: `${fsTreeWidth}%`,
            minWidth: 0,
            position: 'relative',
            // 显式高度 (calc(100vh - 140px)) 让 fs-tree 在 flex 行里
            // 有确定的高度, antd Tree 自然渲染的内容超出时被父容器
            // overflow:auto 截断并显示原生滚动条; minHeight:0 防止
            // Tree 自然高度反向撑爆 calc.
            height: 'calc(100vh - 140px)',
            minHeight: 0,
            overflow: 'auto',
            borderRight: '1px solid var(--border-light)',
            padding: '4px 8px',
          }}
        >
          {submittedQuery.length > 0 ? (
            mode === 'content' ? (
              <FsContentSearchList
                entries={contentSearch.data?.entries ?? []}
                loading={contentSearch.loading}
                error={contentSearch.error}
                truncated={contentSearch.data?.truncated ?? false}
                query={submittedQuery}
                onSelect={(p, l) => { setSelected(p); setPendingLine(l); }}
                onItemContextMenu={openContextMenu}
              />
            ) : (
              <FsSearchList
                entries={search.data?.entries ?? []}
                loading={search.loading}
                error={search.error}
                truncated={search.data?.truncated ?? false}
                query={submittedQuery}
                onSelect={(p) => setSelected(p)}
                onItemContextMenu={openContextMenu}
              />
            )
          ) : root.error && !root.data?.ok ? (
            <Empty description={root.error} />
          ) : root.loading && treeData.length === 0 ? (
            <div style={{ padding: 16, textAlign: 'center' }}>
              <Spin />
            </div>
          ) : treeData.length === 0 ? (
            <div style={{ padding: 16, color: 'var(--text-dim-45)', fontSize: 12 }}>
              目录为空
            </div>
          ) : (
            <Tree
              treeData={treeData}
              showIcon
              loadData={handleLoadData}
              expandedKeys={expandedKeys}
              onExpand={(keys) => setExpandedKeys(keys)}
              onSelect={(_keys, info) => {
                // Files: preview their content.
                // Directories: toggle expand on click. Loading is lazy —
                // adding an unloaded dir to expandedKeys triggers loadData
                // since renderTree leaves `children` undefined until loaded.
                const key = String(info.node.key);
                if (info.node.isLeaf) {
                  setSelected(key);
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
          {/* Splitter drag surface — 锚定在 fs-tree 右边缘 (borderRight 视觉分割
              线位置, 文件树 ↔ 预览区 的分界). 锁定时整条 12px 宽 surface
              pointer-events: none, 误触不会拖动. 解锁后变 ew-resize cursor +
              半透明高亮, 鼠标按下开始拖动. 实现跟 SplitPane 完全一致. */}
          <div
            data-testid="fs-tree-drag-handle"
            onMouseDown={onFsHandleMouseDown}
            style={{
              position: 'absolute',
              top: 0,
              right: -6,
              width: 12,
              height: '100%',
              cursor: lockedStored ? 'default' : 'ew-resize',
              background: lockedStored
                ? 'transparent'
                : 'rgba(255,102,0,0.06)',
              pointerEvents: lockedStored ? 'none' : 'auto',
              zIndex: 5,
            }}
            onMouseEnter={(e) => {
              if (lockedStored) return;
              (e.currentTarget as HTMLDivElement).style.background =
                'rgba(255,102,0,0.18)';
            }}
            onMouseLeave={(e) => {
              if (lockedStored) return;
              (e.currentTarget as HTMLDivElement).style.background =
                'rgba(255,102,0,0.06)';
            }}
            title={
              lockedStored
                ? `文件树宽度已锁定 — 点击悬浮按钮解锁后拖动调整 (${FS_TREE_MIN_WIDTH}-${FS_TREE_MAX_WIDTH}%)`
                : `拖动以调整文件树宽度 (${FS_TREE_MIN_WIDTH}-${FS_TREE_MAX_WIDTH}%) — 点击悬浮按钮可锁定`
            }
          />
          {/* Splitter lock toggle — floating button 居中悬浮在分割线上.
              永远可点击 (zIndex > handle); 锁定时显示锁图标, 解锁时显示开锁
              图标 + ew-resize cursor (按钮自身也是拖动目标的一环).
              位置 right: -14 让按钮左右对称跨在 borderRight 这条线上. */}
          <button
            type="button"
            data-testid="fs-tree-lock-toggle"
            aria-label={lockedStored ? '解锁文件树宽度拖动' : '锁定文件树宽度拖动'}
            onClick={() => setLockedStored(!lockedStored)}
            style={{
              position: 'absolute',
              top: '50%',
              right: -14,
              transform: 'translateY(-50%)',
              width: 28,
              height: 28,
              padding: 0,
              borderRadius: 14,
              border: '1px solid var(--border-light)',
              background: lockedStored ? 'var(--bg-card)' : 'var(--accent-start)',
              color: lockedStored ? 'var(--text-secondary)' : '#fff',
              cursor: lockedStored ? 'pointer' : 'ew-resize',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 6,
              boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
              fontSize: 14,
            }}
            title={
              lockedStored
                ? '文件树宽度已锁定, 点击解锁后可拖动调整'
                : '文件树宽度可拖动调整, 点击锁定'
            }
          >
            {lockedStored ? <LockOutlined /> : <UnlockOutlined />}
          </button>
        </div>
        <div
          data-testid="fs-preview"
          style={{
            // fs-tree 用固定百分比 width 占左侧, fs-preview 用 flex:1 填
            // 剩余空间; minWidth:0 让预览区可以被 fs-tree 挤压 (而不是
            // 因 SyntaxHighlighter / <pre> 自然宽度反向撑爆 flex 行).
            flex: 1,
            minWidth: 0,
            height: 'calc(100vh - 140px)',
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            padding: 12,
            overflow: 'hidden',
            fontFamily: MONO,
            fontSize: 12,
          }}
        >
          {!selected ? (
            <Empty description="选择左侧文件查看内容" />
          ) : file.loading ? (
            <div style={{ textAlign: 'center', padding: 24 }}>
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
          ) : file.data && (file.data.content !== undefined || file.data.kind === 'image' || file.data.kind === 'html') ? (
            <FilePreviewMemo file={file.data} htmlMode={htmlMode} pendingLine={pendingLine} />
          ) : (
            <Empty description="没有内容" />
          )}
        </div>
      </div>
      {contextMenu && cwd && (
        <FsContextMenu
          path={contextMenu.path}
          absPath={contextMenu.absPath}
          cwd={cwd}
          kind={contextMenu.kind}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
          onDeleted={() => { setContextMenu(null); refreshAll(); }}
        />
      )}
    </div>
  );
}