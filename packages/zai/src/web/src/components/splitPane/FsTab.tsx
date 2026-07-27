import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Empty, Input, Segmented, Spin, Switch, Tree, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
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
  const [contextMenu, setContextMenu] = useState<{ path: string; absPath: string; x: number; y: number } | null>(null);
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

  const handleLoadData = (treeNode: DataNode): Promise<void> =>
    new Promise((resolve) => {
      const key = String(treeNode.key);
      if (loaded[key]) {
        resolve();
        return;
      }
      void fetch(`/api/fs/list?dir=${encodeURIComponent(key)}`)
        .then((r) => r.json())
        .then((j) => {
          if (j?.ok && Array.isArray(j.entries)) {
            setLoaded((cur) => ({ ...cur, [key]: j.entries }));
          } else {
            setLoaded((cur) => ({ ...cur, [key]: [] }));
          }
          resolve();
        })
        .catch(() => {
          setLoaded((cur) => ({ ...cur, [key]: [] }));
          resolve();
        });
    });

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
          <span style={{ fontFamily: MONO, fontSize: 12 }}>
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
      onClick={() => root.refetch()}
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
          data-testid="fs-tree"
          style={{
            flex: '0 0 40%',
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
              />
            ) : (
              <FsSearchList
                entries={search.data?.entries ?? []}
                loading={search.loading}
                error={search.error}
                truncated={search.data?.truncated ?? false}
                query={submittedQuery}
                onSelect={(p) => setSelected(p)}
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
                const relPath = String(node.key);
                const abs = buildAbsPath(cwd, relPath);
                setContextMenu({ path: relPath, absPath: abs, x: event.clientX, y: event.clientY });
                event.preventDefault();
              }}
            />
          )}
        </div>
        <div
          data-testid="fs-preview"
          style={{
            // 与 fs-tree 对齐的 calc 高度; minHeight:0 防止内层
            // SyntaxHighlighter / <pre> 自然高度撑爆 flex 行.
            flex: '0 0 60%',
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
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
          onDeleted={() => { setContextMenu(null); void root.refetch(); }}
        />
      )}
    </div>
  );
}