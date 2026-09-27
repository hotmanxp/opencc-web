/**
 * MonacoCodeView — 移植自 Agents Anywhere (AA) 的 `monaco-code-view.tsx`。
 *
 * 关键设计模式(与 AA 一致):
 *  - lazy `import('monaco-editor')` + 26 种 basic-languages + 4 类 language worker
 *  - API surface: getValue / focus / openSearch / revealPosition / destroy(经 ref)
 *  - readOnly toggle:content / editable 变化走同一 EditorView 实例,只调
 *    `updateOptions({ readOnly })`,不卸载重挂(对比 zai 旧的 TextEditor 整块挂载)
 *  - wheel containment:capture-phase wheel 监听,在 scrollTop 触顶/触底时
 *    preventDefault,避免滚轮穿透到外层 split pane
 *  - cancel-safe dispose:卸载时 `disposed=true` + safeDispose 吞掉 Canceled 错误
 *  - 主题跟随 `<html data-theme>`(对齐 zai `useCodeThemeMode` 约定;AA 是 class 监听)
 *
 * 命名空间:主题名 `zai-monaco-light/dark`(`aa-preview-*` 不污染 zai 全局)。
 *
 * 与 zai 现有 TextEditor 的差异:
 *  - 不再依赖 DOM CustomEvent(`fs-editor-get-doc`)拿当前内容,直接 editor.getValue()
 *  - editable 翻转不卸载 DOM,切换瞬时且不丢失滚动位置
 *  - 暴露 openSearch 用于全局 Cmd/Ctrl+F(对齐 AA file-preview-page line 492-497)
 */
import { useEffect, useRef, useState } from 'react';

export type MonacoCodeViewApi = {
  getValue: () => string
  focus: () => void
  openSearch: () => void
  revealPosition: (position: { lineNumber: number; column: number }) => void
  destroy: () => void
}

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker: (workerId: string, label: string) => Worker
    }
  }
}

type MonacoCodeViewProps = {
  className?: string
  content: string
  documentKey?: string
  editable?: boolean
  fileName?: string
  language?: string
  onChange?: (value: string) => void
  onReady?: (api: MonacoCodeViewApi) => void
  options?: import('monaco-editor').editor.IStandaloneEditorConstructionOptions
  style?: React.CSSProperties
  'data-testid'?: string
}

export function MonacoCodeView({
  className,
  content,
  documentKey,
  editable = false,
  fileName,
  language,
  onChange,
  onReady,
  options,
  style,
  'data-testid': testId,
}: MonacoCodeViewProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const latest = useRef({ content, documentKey, editable, fileName, language, options, onChange, onReady });
  latest.current = { content, documentKey, editable, fileName, language, options, onChange, onReady };
  const syncRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let cleanup = (): void => {};
    void (async (): Promise<void> => {
      const monaco = await import('monaco-editor');
      await loadMonacoLanguages();
      if (cancelled) return;
      configureMonacoEnvironment();
      defineMonacoThemes(monaco);
      const editor = monaco.editor.create(host, {
        model: null,
        automaticLayout: true,
        contextmenu: true,
        lineNumbers: 'on',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        theme: currentMonacoTheme(),
        wordWrap: 'off',
        ...latest.current.options,
        readOnly: !latest.current.editable,
      });
      let previous: typeof latest.current | null = null;
      let switchingModel = false;
      let disposed = false;
      const api: MonacoCodeViewApi = {
        getValue: () => editor.getValue(),
        focus: () => editor.focus(),
        openSearch: () => { void editor.getAction('actions.find')?.run() },
        revealPosition: (position) => {
          const target = editor.getModel()?.validatePosition(position);
          if (!target) return;
          editor.setPosition(target);
          editor.revealPositionInCenter(target, monaco.editor.ScrollType.Immediate);
        },
        destroy: () => cleanup(),
      };
      syncRef.current = (): void => {
        if (disposed) return;
        const next = latest.current;
        const changed = !previous || previous.documentKey !== next.documentKey
          || previous.content !== next.content || previous.fileName !== next.fileName || previous.language !== next.language;
        if (changed) {
          const oldModel = editor.getModel();
          const model = monaco.editor.createModel(
            next.content,
            monacoLanguageForName(next.language) ?? monacoLanguageForFile(next.fileName ?? ''),
          );
          switchingModel = true;
          editor.setModel(model);
          switchingModel = false;
          oldModel?.dispose();
        }
        editor.updateOptions({ ...next.options, readOnly: !next.editable });
        if (changed) next.onReady?.(api);
        if (next.editable && !previous?.editable) editor.focus();
        previous = next;
      };
      const wheelCleanup = containMonacoWheel(host, editor);
      const themeObserver = new MutationObserver(() => monaco.editor.setTheme(currentMonacoTheme()));
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      const changeDisposable = editor.onDidChangeModelContent(() => {
        if (!switchingModel) latest.current.onChange?.(editor.getValue());
      });
      cleanup = (): void => {
        if (disposed) return;
        disposed = true;
        syncRef.current = null;
        safeDispose(() => changeDisposable.dispose());
        safeDispose(wheelCleanup);
        themeObserver.disconnect();
        safeDispose(() => editor.getModel()?.dispose());
        safeDispose(() => editor.dispose());
      };
      syncRef.current();
    })().catch((err) => {
      // monaco-editor 的 lazy import / worker 注册失败:不抛给 React,仅记日志,
      // 组件卸载时 cleanup 仍会执行(disposed 守卫)。
      console.error('[MonacoCodeView] init failed:', err);
    });
    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);

  useEffect(() => { syncRef.current?.() }, [content, documentKey, editable, fileName, language, options]);

  return (
    <div
      ref={hostRef}
      data-testid={testId ?? 'monaco-code-view'}
      // h-full w-full 是 Monaco host 必须的:Monaco 用 `automaticLayout:true`
      // 通过 ResizeObserver 跟 host 的尺寸。host 没有显式高度时,block 元素
      // 高度收缩为 0,编辑器看不见。className 仍可由调用方叠加(flex-1 /
      // min-h-0 / overflow-hidden 等),但默认 h-full w-full 必须兜底。
      className={`zai-monaco-code-view overscroll-contain h-full w-full ${className ?? ''}`}
      style={style}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LazyMonacoCodeView — 共享的懒加载壳。
//
// 2026-09-27:从 FsTab 提到此处,让 Config.tsx(JsonFileEditor)/ 其他需要代码编辑
// 的页面复用同一套缓存。monaco chunk (~3MB gzip)只在该组件第一次挂载时才
// 下载;模块级 `cachedMonacoCodeView` 保证后续 mount 直接拿到组件引用,不走
// Suspense(happy-dom 无法 resolve Suspense)。
//
// 与 React.lazy + Suspense 不同:lazy 的 chunk 永远是异步 resolve,happy-dom
// 测不出来;此处的 loadPromise + cachedMonacoCodeView 把"加载"折叠成同步
// 状态(挂载前 cached=undefined,第一次 import 后 cached 立即可读)。
// ─────────────────────────────────────────────────────────────────────────────
let cachedMonacoCodeView: typeof MonacoCodeView | null = null;
function loadMonacoCodeView(): Promise<typeof MonacoCodeView> {
  if (cachedMonacoCodeView) return Promise.resolve(cachedMonacoCodeView);
  // monaco 实际入口就是本模块的 MonacoCodeView 命名导出,import meta 用于 chunk
  // 边界识别;首次访问会触发 vite 的 monaco-* chunk 下载。
  return import('./MonacoCodeView.js').then((m) => {
    cachedMonacoCodeView = m.MonacoCodeView;
    return cachedMonacoCodeView;
  });
}

export type LazyMonacoCodeViewProps = MonacoCodeViewProps;

export function LazyMonacoCodeView(props: LazyMonacoCodeViewProps): JSX.Element {
  const [Editor, setEditor] = useState<typeof MonacoCodeView | null>(cachedMonacoCodeView);
  useEffect(() => {
    if (Editor) return;
    let cancelled = false;
    loadMonacoCodeView().then((m) => {
      if (!cancelled) setEditor(() => m);
    });
    return () => {
      cancelled = true;
    };
  }, [Editor]);
  if (!Editor) {
    return (
      <div
        data-testid="monaco-code-view-loading"
        className="flex-1 min-h-0 p-3 text-[color:var(--text-dim-45)] text-xs"
      >
        正在加载编辑器…
      </div>
    );
  }
  return <Editor {...props} />;
}

function safeDispose(dispose: () => void): void {
  try {
    dispose();
  } catch (error) {
    if (isMonacoCanceledError(error)) return;
    throw error;
  }
}

function isMonacoCanceledError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message === 'Canceled' || error.name === 'Canceled' || error.name === 'CanceledError';
}

function containMonacoWheel(host: HTMLElement, editor: import('monaco-editor').editor.IStandaloneCodeEditor): () => void {
  const handleWheel = (event: WheelEvent): void => {
    const layout = editor.getLayoutInfo();
    const scrollTop = editor.getScrollTop();
    const maxScrollTop = Math.max(0, editor.getScrollHeight() - layout.height);
    const hasVerticalScroll = maxScrollTop > 1;
    if (!hasVerticalScroll || event.deltaY === 0) return;

    const atTop = scrollTop <= 0;
    const atBottom = scrollTop >= maxScrollTop - 1;
    const scrollingPastTop = event.deltaY < 0 && atTop;
    const scrollingPastBottom = event.deltaY > 0 && atBottom;
    if (!scrollingPastTop && !scrollingPastBottom) return;

    event.preventDefault();
    event.stopPropagation();
  };

  host.addEventListener('wheel', handleWheel, { capture: true, passive: false });
  return () => host.removeEventListener('wheel', handleWheel, { capture: true });
}

let monacoEnvironmentConfigured = false;
let monacoThemesDefined = false;
let monacoLanguagesLoaded: Promise<void> | null = null;

function loadMonacoLanguages(): Promise<void> {
  monacoLanguagesLoaded ??= Promise.all([
    import('monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js'),
    import('monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution.js'),
    import('monaco-editor/esm/vs/basic-languages/css/css.contribution.js'),
    import('monaco-editor/esm/vs/basic-languages/dart/dart.contribution.js'),
    import('monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution.js'),
    import('monaco-editor/esm/vs/basic-languages/go/go.contribution.js'),
    import('monaco-editor/esm/vs/basic-languages/graphql/graphql.contribution.js'),
    import('monaco-editor/esm/vs/basic-languages/ini/ini.contribution.js'),
    import('monaco-editor/esm/vs/basic-languages/java/java.contribution.js'),
    import('monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js'),
    import('monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution.js'),
    import('monaco-editor/esm/vs/basic-languages/lua/lua.contribution.js'),
    import('monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js'),
    import('monaco-editor/esm/vs/basic-languages/php/php.contribution.js'),
    import('monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution.js'),
    import('monaco-editor/esm/vs/basic-languages/python/python.contribution.js'),
    import('monaco-editor/esm/vs/basic-languages/r/r.contribution.js'),
    import('monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution.js'),
    import('monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js'),
    import('monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js'),
    import('monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js'),
    import('monaco-editor/esm/vs/basic-languages/swift/swift.contribution.js'),
    import('monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js'),
    import('monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js'),
    import('monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js'),
  ]).then(() => undefined);
  return monacoLanguagesLoaded;
}

function configureMonacoEnvironment(): void {
  if (monacoEnvironmentConfigured) return;
  monacoEnvironmentConfigured = true;
  window.MonacoEnvironment = {
    getWorker: (_workerId: string, label: string): Worker => {
      if (label === 'json') {
        return new Worker(new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url), { type: 'module' });
      }
      if (label === 'css' || label === 'scss' || label === 'less') {
        return new Worker(new URL('monaco-editor/esm/vs/language/css/css.worker.js', import.meta.url), { type: 'module' });
      }
      if (label === 'html' || label === 'handlebars' || label === 'razor') {
        return new Worker(new URL('monaco-editor/esm/vs/language/html/html.worker.js', import.meta.url), { type: 'module' });
      }
      if (label === 'typescript' || label === 'javascript') {
        return new Worker(new URL('monaco-editor/esm/vs/language/typescript/ts.worker.js', import.meta.url), { type: 'module' });
      }
      return new Worker(new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url), { type: 'module' });
    },
  };
}

function defineMonacoThemes(monaco: typeof import('monaco-editor')): void {
  if (monacoThemesDefined) return;
  monacoThemesDefined = true;
  registerDiffLanguage(monaco);
  monaco.editor.defineTheme('zai-monaco-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'diff.header', foreground: '6e7781' },
      { token: 'diff.hunk', foreground: '8250df', fontStyle: 'bold' },
      { token: 'diff.addition', foreground: '1a7f37' },
      { token: 'diff.deletion', foreground: 'cf222e' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#1f2328',
      'editor.lineHighlightBackground': '#f6f8fa',
      'editorLineNumber.foreground': '#6e7781',
      'editorLineNumber.activeForeground': '#1f2328',
      'editorGutter.background': '#ffffff',
      'editorWidget.background': '#ffffff',
      'editorWidget.border': '#d0d7de',
      'input.background': '#ffffff',
      'input.border': '#d0d7de',
    },
  });
  monaco.editor.defineTheme('zai-monaco-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'diff.header', foreground: 'a1a1aa' },
      { token: 'diff.hunk', foreground: 'c084fc', fontStyle: 'bold' },
      { token: 'diff.addition', foreground: '86efac' },
      { token: 'diff.deletion', foreground: 'fca5a5' },
    ],
    colors: {
      // 对齐 zai TextEditor.tsx:155-187 的暗色风格(#0d0d0d 背景)
      'editor.background': '#0d0d0d',
      'editor.foreground': '#e4e4e7',
      'editor.lineHighlightBackground': '#18181b',
      'editorLineNumber.foreground': '#71717a',
      'editorLineNumber.activeForeground': '#e4e4e7',
      'editorGutter.background': '#0d0d0d',
      'editorWidget.background': '#18181b',
      'editorWidget.border': '#3f3f46',
      'input.background': '#09090b',
      'input.border': '#3f3f46',
    },
  });
}

function registerDiffLanguage(monaco: typeof import('monaco-editor')): void {
  if (!monaco.languages.getLanguages().some((language) => language.id === 'diff')) {
    monaco.languages.register({ id: 'diff' });
  }
  monaco.languages.setMonarchTokensProvider('diff', {
    tokenizer: {
      root: [
        [/^@@.*@@.*$/, 'diff.hunk'],
        [/^(diff --git|index |--- |\+\+\+ ).*$/, 'diff.header'],
        [/^\+.*/, 'diff.addition'],
        [/^-.*/, 'diff.deletion'],
      ],
    },
  });
}

function currentMonacoTheme(): 'zai-monaco-light' | 'zai-monaco-dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'zai-monaco-dark' : 'zai-monaco-light';
}

export function monacoLanguageForFile(filename: string): string {
  const lower = filename.toLowerCase();
  const basename = lower.split(/[\\/]/).pop() ?? lower;
  const ext = basename.split('.').pop() ?? '';
  if (['ts', 'tsx'].includes(ext)) return 'typescript';
  if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'javascript';
  if (['json', 'jsonc'].includes(ext) || basename.endsWith('.json')) return 'json';
  if (['md', 'markdown', 'mdx'].includes(ext)) return 'markdown';
  if (['py', 'pyi'].includes(ext)) return 'python';
  if (['html', 'htm', 'xhtml'].includes(ext)) return 'html';
  if (['css', 'scss', 'sass', 'less'].includes(ext)) return 'css';
  if (['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'ino'].includes(ext)) return 'cpp';
  if (ext === 'java') return 'java';
  if (['sql', 'mysql', 'pgsql', 'psql', 'sqlite'].includes(ext)) return 'sql';
  if (['xml', 'svg', 'rss', 'atom', 'plist'].includes(ext)) return 'xml';
  if (['yaml', 'yml'].includes(ext) || basename === 'docker-compose.yml' || basename === 'docker-compose.yaml') return 'yaml';
  if (['php', 'phtml'].includes(ext)) return 'php';
  if (['sh', 'bash', 'zsh'].includes(ext)) return 'shell';
  if (['toml', 'ini', 'env'].includes(ext) || basename.startsWith('.env') || ['.npmrc', '.yarnrc'].includes(basename)) return 'ini';
  if (basename === 'dockerfile' || basename.endsWith('.dockerfile')) return 'dockerfile';
  if (['makefile', 'gnumakefile'].includes(basename) || ext === 'mk') return 'makefile';
  if (['go', 'rb', 'swift', 'kt', 'kts', 'cs', 'dart', 'lua', 'r'].includes(ext)) return ext;
  if (ext === 'rs') return 'rust';
  if (['gql', 'graphql'].includes(ext)) return 'graphql';
  if (['ps1', 'psm1', 'psd1'].includes(ext)) return 'powershell';
  return 'plaintext';
}

function monacoLanguageForName(language: string | undefined): string | null {
  if (!language) return null;
  const key = language.trim().toLowerCase();
  const aliases: Record<string, string> = {
    bash: 'shell',
    c: 'cpp',
    cc: 'cpp',
    cjs: 'javascript',
    cs: 'csharp',
    csx: 'csharp',
    docker: 'dockerfile',
    h: 'cpp',
    hpp: 'cpp',
    js: 'javascript',
    jsx: 'javascript',
    kt: 'kotlin',
    kts: 'kotlin',
    md: 'markdown',
    mjs: 'javascript',
    ps1: 'powershell',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    sh: 'shell',
    text: 'plaintext',
    txt: 'plaintext',
    ts: 'typescript',
    tsx: 'typescript',
    yml: 'yaml',
    zsh: 'shell',
  };
  return aliases[key] ?? key;
}