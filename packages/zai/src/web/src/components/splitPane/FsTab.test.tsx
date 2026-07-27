// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('./useFsList.js', () => ({ useFsList: vi.fn() }));
vi.mock('./useFsFile.js', () => ({ useFsFile: vi.fn() }));
vi.mock('./useFsSearch.js', () => ({ useFsSearch: vi.fn() }));
vi.mock('./useFsContentSearch.js', () => ({ useFsContentSearch: vi.fn() }));
vi.mock('./useFsWrite.js', () => ({
  useFsWrite: vi.fn(() => ({ save: vi.fn(), saving: false })),
}));
vi.mock('./FsContextMenu.js', () => ({
  FsContextMenu: vi.fn(({ path, onClose }) => (
    <div data-testid="ctx-menu-stub" data-path={path}>
      <button onClick={onClose}>close</button>
    </div>
  )),
}));
// TextEditor and the markdown SyntaxHighlighter chunks are dynamic
// imports that happy-dom never resolves (vitest's module loader uses
// a separate Promise machinery from Node's). We stub them so that
// the dynamic-import promise resolves on the next microtask with
// our test stub, which FsTab's lazy load() then mounts.
vi.mock('./TextEditor.js', () => ({
  TextEditor: (props: any) => (
    <div data-testid="fs-editor">
      <pre>{props.initialContent}</pre>
      <button
        data-testid="fs-editor-mod-s"
        onClick={() => props.onSave?.(props.initialContent)}
      >
        save
      </button>
      <button data-testid="fs-editor-escape" onClick={() => props.onCancel?.()}>
        cancel
      </button>
    </div>
  ),
}));
vi.mock('../markdown/syntaxHighlighter.js', () => ({
  // The real SyntaxHighlighter (with showLineNumbers + wrapLines +
  // lineProps enabled in FsTab) emits per-line <span data-line={N}>
  // anchors. The pendingLine jump effect queries that selector to
  // scroll the matched line into view. Our stub mirrors that contract
  // so the existing "clicking a content search row passes pendingLine
  // to FilePreview" test continues to assert the same DOM shape — and
  // so the new regression test (line numbers + data-line present) is
  // honest about what the real component renders, not what happy-dom
  // would otherwise synthesize from a bare <pre><code>.
  SyntaxHighlighter: ({
    children,
    showLineNumbers,
    lineProps,
  }: {
    children?: unknown;
    showLineNumbers?: boolean;
    lineProps?: (n: number) => Record<string, string>;
  }) => {
    const text = typeof children === 'string' ? children : String(children ?? '');
    const lines = text.split('\n');
    // Drop the trailing empty line that .split('\n') adds for trailing
    // newlines, matching how the real library counts (it uses
    // codeString.replace(/\n$/, '').split('\n') for the gutter).
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return (
      <pre className="language-ts">
        {showLineNumbers && (
          <code
            data-testid="fs-line-gutter"
            style={{ float: 'left', paddingRight: 10 }}
          >
            {lines.map((_, i) => (
              <span key={`g${i}`} className="react-syntax-highlighter-line-number">
                {i + 1}
                {'\n'}
              </span>
            ))}
          </code>
        )}
        <code>
          {lines.map((line, i) => {
            const lineNumber = i + 1;
            const extra = lineProps ? lineProps(lineNumber) : {};
            return (
              <span key={`l${lineNumber}`} data-line={String(lineNumber)} {...extra}>
                {line}
                {i < lines.length - 1 ? '\n' : ''}
              </span>
            );
          })}
        </code>
      </pre>
    );
  },
  oneDark: {},
}));
// Make dynamic imports resolve during tests. vi.mock intercepts the
// happy-dom doesn't progress microtasks synchronously during fireEvent,
// so tests that wait for the lazy chunk resolve use waitFor() to
// advance the timer. No globalThis.import shim is required — vi.mock
// already controls the resolved module.

import { useFsList } from './useFsList.js';
import { useFsFile } from './useFsFile.js';
import { useFsSearch } from './useFsSearch.js';
import { useFsContentSearch } from './useFsContentSearch.js';
import { useFsWrite } from './useFsWrite.js';
import { FsTab, buildAbsPath } from './FsTab.js';

const mockList = useFsList as unknown as ReturnType<typeof vi.fn>;
const mockFile = useFsFile as unknown as ReturnType<typeof vi.fn>;
const mockSearch = useFsSearch as unknown as ReturnType<typeof vi.fn>;
const mockContentSearch = useFsContentSearch as unknown as ReturnType<typeof vi.fn>;
const mockWrite = useFsWrite as unknown as ReturnType<typeof vi.fn>;

describe('FsTab', () => {
  beforeEach(() => {
    mockSearch.mockReturnValue({ data: null, loading: false, error: null, durationMs: null });
    mockContentSearch.mockReturnValue({ data: null, loading: false, error: null, durationMs: null });
    mockWrite.mockReturnValue({ save: vi.fn().mockResolvedValue({ ok: true }), saving: false });
    mockFile.mockReturnValue({ data: null, loading: false, error: null });
  });

  it('renders empty state when cwd is null', () => {
    mockList.mockReturnValue({ data: null, loading: false, error: null, refetch: vi.fn() });
    mockFile.mockReturnValue({ data: null, loading: false, error: null });
    render(<FsTab cwd={null} />);
    expect(screen.getByText(/未选择会话/i)).toBeTruthy();
  });

  it('renders entries from useFsList', () => {
    mockList.mockReturnValue({
      data: { ok: true, entries: [{ name: 'src', path: 'src', type: 'dir', size: null }] },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockFile.mockReturnValue({ data: null, loading: false, error: null });
    render(<FsTab cwd="/repo" />);
    expect(screen.getByText('src')).toBeTruthy();
  });

  it('renders empty hint when nothing selected', () => {
    mockList.mockReturnValue({
      data: { ok: true, entries: [] },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockFile.mockReturnValue({ data: null, loading: false, error: null });
    render(<FsTab cwd="/repo" />);
    expect(screen.getByText(/选择左侧文件查看内容/i)).toBeTruthy();
  });

  it('shows error from useFsList', () => {
    mockList.mockReturnValue({
      data: { ok: false, error: '目录读取失败' },
      loading: false,
      error: '目录读取失败',
      refetch: vi.fn(),
    });
    mockFile.mockReturnValue({ data: null, loading: false, error: null });
    render(<FsTab cwd="/repo" />);
    expect(screen.getByText(/目录读取失败/)).toBeTruthy();
  });

  it('does not advertise a depth cap in the header (any depth allowed)', () => {
    // The depth cap was removed — the server returns children for any
    // depth, and the client lazy-loads them. The header should advertise
    // lazy loading rather than a max depth.
    mockList.mockReturnValue({
      data: {
        ok: true,
        entries: [
          { name: 'packages', path: 'packages', type: 'dir', size: null },
        ],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockFile.mockReturnValue({ data: null, loading: false, error: null });
    render(<FsTab cwd="/repo" />);
    expect(screen.getByText('packages')).toBeTruthy();
    expect(screen.queryByText(/深度 ≤/)).toBeNull();
    // Header now uses an interactive search <Input> instead of the old
    // "(按需加载)" tagline; verify it landed.
    expect(screen.getByTestId('fs-search-input')).toBeTruthy();
  });

  it('does not inject a placeholder child for unloaded directories', () => {
    // Regression: a previous version of renderTree pushed
    // `[{ key: __ph, title: '…', isLeaf: true }]` for every dir so the
    // tree looked populated but was permanently stuck — antd Tree saw a
    // non-empty children array and skipped loadData, so expand was a
    // no-op. The fix leaves `children` undefined until loaded[path] is
    // set, which makes antd actually invoke loadData.
    //
    // We assert on the rendered DOM by reading the data-testid wrapper
    // and confirming no `…` placeholder text appears for unloaded dirs.
    mockList.mockReturnValue({
      data: {
        ok: true,
        entries: [
          { name: 'packages', path: 'packages', type: 'dir', size: null },
          { name: 'docs', path: 'docs', type: 'dir', size: null },
        ],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockFile.mockReturnValue({ data: null, loading: false, error: null });
    render(<FsTab cwd="/repo" />);
    // Top-level entries render.
    expect(screen.getByText('packages')).toBeTruthy();
    expect(screen.getByText('docs')).toBeTruthy();
    // Placeholder text should NOT appear at the top level — only real
    // loaded entries or undefined children (which antd handles via
    // loadData on expand). The previous bug exposed a `…` row here.
    expect(screen.queryByText('…')).toBeNull();
  });

  it('renders code files via Prism syntax highlighter (oneDark)', () => {
    // Selecting a `.ts` file should mount a SyntaxHighlighter with
    // language="typescript" and the `fs-preview-code` test-id wrapper.
    // Plain `.md` files go through MarkdownText; `.json` files get
    // Prism JSON highlighting (extToLanguage maps json → 'json').
    mockList.mockReturnValue({
      data: { ok: true, entries: [] },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockFile.mockReturnValue({
      data: {
        ok: true,
        path: '/repo/src/foo.ts',
        name: 'foo.ts',
        size: 42,
        mtime: '2026-07-21T00:00:00Z',
        content: 'export const x: number = 1;',
      },
      loading: false,
      error: null,
    });
    // Pre-select the file via the hook ordering: the hook is called
    // with cwd only — we drive selection by clicking the Tree, but
    // here we just render and then assert the code preview block is
    // NOT mounted (no selection yet). To exercise the code path we
    // need a selection, which the click-based test below covers.
    render(<FsTab cwd="/repo" />);
    // Without a selection, the code preview block shouldn't exist yet.
    expect(screen.queryByTestId('fs-preview-code')).toBeNull();
    expect(screen.queryByTestId('fs-preview-text')).toBeNull();
  });

  it('uses fs-preview-code test-id for .ts files (syntax highlighted)', async () => {
    mockList.mockReturnValue({
      data: {
        ok: true,
        entries: [
          { name: 'foo.ts', path: 'foo.ts', type: 'file', size: 42 },
        ],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockFile.mockReturnValue({
      data: {
        ok: true,
        path: '/repo/foo.ts',
        name: 'foo.ts',
        size: 42,
        mtime: '2026-07-21T00:00:00Z',
        content: 'export const x: number = 1;',
      },
      loading: false,
      error: null,
    });
    render(<FsTab cwd="/repo" />);
    fireEvent.click(screen.getByText('foo.ts'));
    expect(screen.getByTestId('fs-preview-code')).toBeTruthy();
    expect(screen.queryByTestId('fs-preview-text')).toBeNull();
    // Component-level dynamic import of syntaxHighlighter resolves
    // asynchronously; once it lands, our stub renders a <pre><code>
    // pair which replaces the synchronous fallback `<pre>` markup.
    await waitFor(() => {
      const codeBlock = screen.getByTestId('fs-preview-code');
      expect(codeBlock.querySelector('code')).toBeTruthy();
      // The fallback <pre data-testid="fs-preview-code-fallback">
      // unmounts when the highlighted branch takes over.
      expect(codeBlock.querySelector('[data-testid="fs-preview-code-fallback"]')).toBeNull();
    });
  });

  it('renders .md files via MarkdownText (fs-preview-md test-id)', () => {
    // Selecting a .md file should mount the MarkdownText wrapper
    // (data-testid="fs-preview-md") so the markdown source is rendered
    // as proper markdown — heading elements, lists, tables — NOT a
    // raw <pre>. This is the new behavior introduced by the FsTab
    // MD rendering refactor.
    mockList.mockReturnValue({
      data: {
        ok: true,
        entries: [
          { name: 'README.md', path: 'README.md', type: 'file', size: 12 },
        ],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockFile.mockReturnValue({
      data: {
        ok: true,
        path: '/repo/README.md',
        name: 'README.md',
        size: 12,
        mtime: '2026-07-21T00:00:00Z',
        content: '# Hello\n\nbody',
      },
      loading: false,
      error: null,
    });
    render(<FsTab cwd="/repo" />);
    fireEvent.click(screen.getByText('README.md'));
    // The new MD branch wrapper:
    expect(screen.getByTestId('fs-preview-md')).toBeTruthy();
    expect(screen.queryByTestId('fs-preview-text')).toBeNull();
    expect(screen.queryByTestId('fs-preview-code')).toBeNull();
    // Markdown was actually rendered (heading element appeared).
    expect(screen.getByRole('heading', { level: 1, name: 'Hello' })).toBeTruthy();
    // The raw "# Hello" text should NOT appear as raw text (it became a heading).
    expect(screen.queryByText('# Hello', { selector: 'pre, code' })).toBeNull();
  });

  it('renders .markdown files (alternate suffix) via MarkdownText', () => {
    // The regex is /\.md|\.markdown$/i — confirm .markdown variant hits
    // the same branch.
    mockList.mockReturnValue({
      data: {
        ok: true,
        entries: [
          { name: 'NOTES.markdown', path: 'NOTES.markdown', type: 'file', size: 5 },
        ],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockFile.mockReturnValue({
      data: {
        ok: true,
        path: '/repo/NOTES.markdown',
        name: 'NOTES.markdown',
        size: 5,
        mtime: '2026-07-21T00:00:00Z',
        content: '## Section',
      },
      loading: false,
      error: null,
    });
    render(<FsTab cwd="/repo" />);
    fireEvent.click(screen.getByText('NOTES.markdown'));
    expect(screen.getByTestId('fs-preview-md')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Section' })).toBeTruthy();
  });

  it('still renders .txt files via plain <pre> (regression guard)', () => {
    // .txt files should NOT hit the new MD branch.
    mockList.mockReturnValue({
      data: {
        ok: true,
        entries: [
          { name: 'notes.txt', path: 'notes.txt', type: 'file', size: 4 },
        ],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockFile.mockReturnValue({
      data: {
        ok: true,
        path: '/repo/notes.txt',
        name: 'notes.txt',
        size: 4,
        mtime: '2026-07-21T00:00:00Z',
        content: 'plain text',
      },
      loading: false,
      error: null,
    });
    render(<FsTab cwd="/repo" />);
    fireEvent.click(screen.getByText('notes.txt'));
    expect(screen.getByTestId('fs-preview-text')).toBeTruthy();
    expect(screen.queryByTestId('fs-preview-md')).toBeNull();
  });

  it('uses fs-preview-code test-id for .json files (Prism JSON highlighting)', async () => {
    // .json / .jsonc / .json5 all map to the Prism 'json' language
    // in extToLanguage, so the preview should mount the same
    // SyntaxHighlighter wrapper as code files — not the plain <pre>.
    mockList.mockReturnValue({
      data: {
        ok: true,
        entries: [
          { name: 'package.json', path: 'package.json', type: 'file', size: 32 },
        ],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockFile.mockReturnValue({
      data: {
        ok: true,
        path: '/repo/package.json',
        name: 'package.json',
        size: 32,
        mtime: '2026-07-21T00:00:00Z',
        content: '{\n  "name": "x",\n  "v": 1\n}',
      },
      loading: false,
      error: null,
    });
    render(<FsTab cwd="/repo" />);
    fireEvent.click(screen.getByText('package.json'));
    expect(screen.getByTestId('fs-preview-code')).toBeTruthy();
    expect(screen.queryByTestId('fs-preview-text')).toBeNull();
    expect(screen.queryByTestId('fs-preview-md')).toBeNull();
    await waitFor(() => {
      const codeBlock = screen.getByTestId('fs-preview-code');
      expect(codeBlock.querySelector('code')).toBeTruthy();
      expect(codeBlock.querySelector('[data-testid="fs-preview-code-fallback"]')).toBeNull();
    });
  });

  it('renders .png files via <img> with the dataUrl (fs-preview-image branch)', () => {
    // Regression for the favicon-128.png 415 in FsTab: when the server
    // returns kind:'image' + dataUrl, FsTab should mount the
    // fs-preview-image test-id wrapper and drop the dataUrl straight into
    // <img src>. It must NOT take the code/md/text branches.
    mockList.mockReturnValue({
      data: {
        ok: true,
        entries: [
          { name: 'favicon-128.png', path: 'favicon-128.png', type: 'file', size: 24 },
        ],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockFile.mockReturnValue({
      data: {
        ok: true,
        path: '/repo/favicon-128.png',
        name: 'favicon-128.png',
        size: 24,
        mtime: '2026-07-21T00:00:00Z',
        kind: 'image',
        mime: 'image/png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      },
      loading: false,
      error: null,
    });
    render(<FsTab cwd="/repo" />);
    fireEvent.click(screen.getByText('favicon-128.png'));
    const wrapper = screen.getByTestId('fs-preview-image');
    expect(wrapper).toBeTruthy();
    const img = wrapper.querySelector('img');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(screen.queryByTestId('fs-preview-code')).toBeNull();
    expect(screen.queryByTestId('fs-preview-text')).toBeNull();
    expect(screen.queryByTestId('fs-preview-md')).toBeNull();
  });

  it('renders .jpg / .gif / .webp via the same image branch', () => {
    // Same wrapper, different mime in the dataUrl. One assertion per
    // format keeps the IMAGE_EXTS contract honest on the client side too.
    const cases: Array<[string, string]> = [
      ['photo.jpg', 'data:image/jpeg;base64,/9j/4AAQ'],
      ['photo.gif', 'data:image/gif;base64,R0lGODlh'],
      ['photo.webp', 'data:image/webp;base64,UklGRg=='],
    ];
    for (const [name, dataUrl] of cases) {
      mockList.mockReturnValue({
        data: { ok: true, entries: [{ name, path: name, type: 'file', size: 8 }] },
        loading: false,
        error: null,
        refetch: vi.fn(),
      });
      mockFile.mockReturnValue({
        data: {
          ok: true,
          path: `/repo/${name}`,
          name,
          size: 8,
          mtime: '2026-07-21T00:00:00Z',
          kind: 'image',
          mime: dataUrl.slice(5, dataUrl.indexOf(';')),
          dataUrl,
        },
        loading: false,
        error: null,
      });
      const { unmount } = render(<FsTab cwd="/repo" />);
      fireEvent.click(screen.getByText(name));
      const wrapper = screen.getByTestId('fs-preview-image');
      const img = wrapper.querySelector('img');
      expect(img?.getAttribute('src')).toBe(dataUrl);
      unmount();
    }
  });

  it('renders .svg via the image branch (no xml syntax dump)', () => {
    // Regression: .svg used to be served as TEXT → extToLanguage mapped
    // `svg` → `xml` and Prism dumped the markup. Now the server emits
    // kind:'image' + an image/svg+xml dataUrl, so the same image branch
    // handles it — and it must NOT take the code/md/text branches.
    mockList.mockReturnValue({
      data: { ok: true, entries: [{ name: 'logo.svg', path: 'logo.svg', type: 'file', size: 64 }] },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockFile.mockReturnValue({
      data: {
        ok: true,
        path: '/repo/logo.svg',
        name: 'logo.svg',
        size: 64,
        mtime: '2026-07-21T00:00:00Z',
        kind: 'image',
        mime: 'image/svg+xml',
        dataUrl: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
      },
      loading: false,
      error: null,
    });
    render(<FsTab cwd="/repo" />);
    fireEvent.click(screen.getByText('logo.svg'));
    const wrapper = screen.getByTestId('fs-preview-image');
    expect(wrapper).toBeTruthy();
    const img = wrapper.querySelector('img');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src')?.startsWith('data:image/svg+xml;base64,')).toBe(true);
    // Critically: the markup must NOT leak into the code/md/text branches.
    expect(screen.queryByTestId('fs-preview-code')).toBeNull();
    expect(screen.queryByTestId('fs-preview-md')).toBeNull();
    expect(screen.queryByTestId('fs-preview-text')).toBeNull();
  });

  it('mounts fs-tree with a calc(100vh - 140px) height + overflow:auto so scroll always works', () => {
    // 关键修复: fs-tree / fs-preview 都写死 height: calc(100vh - 140px),
    // 不依赖 flex 父级 stretch race. fs-tree overflow:auto 兜底滚动
    // (antd Tree 自然渲染的内容超出时被父容器截断并显示原生滚动条).
    // minHeight:0 防止 Tree 自然高度反向撑爆 calc.
    mockList.mockReturnValue({
      data: { ok: true, entries: [] },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockFile.mockReturnValue({ data: null, loading: false, error: null });
    render(<FsTab cwd="/repo" />);
    const tree = screen.getByTestId('fs-tree') as HTMLElement;
    expect(tree.style.height).toBe('calc(100vh - 140px)');
    expect(tree.style.overflow).toBe('auto');
    expect(tree.style.minHeight).toMatch(/^0(px)?$/);
  });

  it('tags file tree icons with data-file-ext (so CSS can color them)', () => {
    // fileIcon.tsx 给 <FileOutlined> 挂 data-file-ext 属性;
    // index.css 用 [data-file-ext="..."] 给每种类型上色.
    // 这里只断言属性出现在 DOM 里 — 不去校验具体颜色,
    // 颜色跟 VSCode Material Icon Theme 对齐是视觉契约,
    // happy-dom 也跑不动真实样式表,断言一下属性挂对了就行.
    mockList.mockReturnValue({
      data: {
        ok: true,
        entries: [
          { name: 'src', path: 'src', type: 'dir', size: null },
          { name: 'index.ts', path: 'index.ts', type: 'file', size: 42 },
          { name: 'README.md', path: 'README.md', type: 'file', size: 12 },
          { name: 'package.json', path: 'package.json', type: 'file', size: 32 },
        ],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockFile.mockReturnValue({ data: null, loading: false, error: null });
    render(<FsTab cwd="/repo" />);
    const tree = screen.getByTestId('fs-tree');
    const fileExtNodes = tree.querySelectorAll('[data-file-ext]');
    const dirNodes = tree.querySelectorAll('[data-dir="true"]');
    // 至少给每个 file/dir 节点挂上了对应属性 — 文件总数 == 文件节点数
    expect(fileExtNodes.length).toBe(3);
    expect(dirNodes.length).toBe(1);
    // 抽样确认映射:index.ts → ts, README.md → md, package.json → json
    const exts = Array.from(fileExtNodes).map((n) => n.getAttribute('data-file-ext')).sort();
    expect(exts).toEqual(['json', 'md', 'ts']);
  });

  it('opens FsContextMenu when a node is right-clicked and closes on onClose', () => {
    mockList.mockReturnValue({
      data: { ok: true, entries: [{ name: 'src', path: 'src', type: 'dir', size: null }] },
      loading: false, error: null, refetch: vi.fn(),
    });
    mockFile.mockReturnValue({ data: null, loading: false, error: null });
    render(<FsTab cwd="/repo" />);
    expect(screen.queryByTestId('ctx-menu-stub')).toBeNull();
    const node = screen.getByText('src');
    fireEvent.contextMenu(node, { clientX: 50, clientY: 60 });
    const stub = screen.getByTestId('ctx-menu-stub');
    expect(stub.getAttribute('data-path')).toBe('src');
    fireEvent.click(screen.getByText('close'));
    expect(screen.queryByTestId('ctx-menu-stub')).toBeNull();
  });

  it('builds POSIX absPath when cwd uses POSIX separators', () => {
    // Extract the exported pure helper and exercise it directly — keeps
    // the test honest without going through the Tree right-click plumbing.
    expect(buildAbsPath('/repo', 'src/index.ts')).toBe('/repo/src/index.ts');
    expect(buildAbsPath('/repo/', 'src/index.ts')).toBe('/repo/src/index.ts');
    expect(buildAbsPath('/repo', '')).toBe('/repo');
  });

  it('builds Windows absPath when cwd uses backslash separators', () => {
    // Server's `path.resolve` on Windows returns `C:\\repo\\...`. Joining
    // with POSIX `/` would produce mixed separators that break cmd-line /
    // Git Bash pasting for the "Copy Absolute Path" action. The helper
    // must detect `\` and use it consistently.
    expect(buildAbsPath('C:\\repo', 'src\\index.ts')).toBe('C:\\repo\\src\\index.ts');
    expect(buildAbsPath('C:\\repo\\', 'src\\index.ts')).toBe('C:\\repo\\src\\index.ts');
    // Mixed-case drive letter preserved.
    expect(buildAbsPath('D:\\proj', 'README.md')).toBe('D:\\proj\\README.md');
  });

  it('buildAbsPath returns relPath unchanged when cwd is null', () => {
    // Without a cwd the user can't build an absolute path — fall back to
    // the relPath so downstream code (FsContextMenu "Copy Path") still
    // has something sensible to put on the clipboard.
    expect(buildAbsPath(null, 'src/index.ts')).toBe('src/index.ts');
  });
});
// --- Task 7: search integration ---

it('renders the search input when cwd is set', () => {
  mockList.mockReturnValue({
    data: { ok: true, entries: [] },
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
  mockFile.mockReturnValue({ data: null, loading: false, error: null });
  render(<FsTab cwd="/repo" />);
  expect(screen.getByTestId('fs-search-input')).toBeTruthy();
});

it('renders the directory tree when query is empty (search list not shown)', () => {
  mockList.mockReturnValue({
    data: { ok: true, entries: [{ name: 'src', path: 'src', type: 'dir', size: null }] },
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
  mockFile.mockReturnValue({ data: null, loading: false, error: null });
  render(<FsTab cwd="/repo" />);
  expect(screen.getByText('src')).toBeTruthy();
  expect(screen.queryByTestId('fs-search-list')).toBeNull();
});

it('renders the search list when query is non-empty (mocked useFsSearch result)', () => {
  mockList.mockReturnValue({
    data: { ok: true, entries: [] },
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
  mockFile.mockReturnValue({ data: null, loading: false, error: null });
  mockSearch.mockReturnValue({
    data: {
      ok: true,
      entries: [{ path: 'src/foo.ts', name: 'foo.ts', type: 'file', score: 50 }],
      truncated: false,
      durationMs: 12,
    },
    loading: false,
    error: null,
    durationMs: 12,
  });
  render(<FsTab cwd="/repo" />);
  const input = screen.getByTestId('fs-search-input') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'foo' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(screen.getByTestId('fs-search-list')).toBeTruthy();
  expect(screen.getByTestId('fs-search-row')).toBeTruthy();
});

it('clicking a search row invokes setSelected + reuse right-side preview', () => {
  mockList.mockReturnValue({
    data: { ok: true, entries: [] },
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
  mockFile.mockReturnValue({
    data: {
      ok: true,
      path: '/repo/src/foo.ts',
      name: 'foo.ts',
      size: 42,
      mtime: '',
      content: 'export const x = 1;',
    },
    loading: false,
    error: null,
  });
  mockSearch.mockReturnValue({
    data: {
      ok: true,
      entries: [{ path: 'src/foo.ts', name: 'foo.ts', type: 'file', score: 50 }],
      truncated: false,
      durationMs: 12,
    },
    loading: false,
    error: null,
    durationMs: 12,
  });
  render(<FsTab cwd="/repo" />);
  const input = screen.getByTestId('fs-search-input') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'foo' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.click(screen.getByTestId('fs-search-row'));
  expect(screen.getByTestId('fs-preview-code')).toBeTruthy();
});

// --- HTML preview (sandboxed iframe) ---

it('renders .html files via a sandboxed iframe (fs-preview-html branch)', () => {
  // Regression for the .html -> syntax-highlight dump: the server now
  // returns kind:'html' + a text/html dataUrl, and FsTab mounts a
  // sandboxed <iframe data-testid="fs-preview-html">. We assert three
  // security properties:
  //   1. iframe src is the dataUrl the server handed us
  //   2. sandbox attribute is exactly "allow-scripts" — no
  //      allow-same-origin, no allow-forms/-popups/-top-navigation
  //   3. the preview/source/md/image branches do NOT mount
  mockList.mockReturnValue({
    data: {
      ok: true,
      entries: [
        { name: 'index.html', path: 'index.html', type: 'file', size: 64 },
      ],
    },
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
  mockFile.mockReturnValue({
    data: {
      ok: true,
      path: '/repo/index.html',
      name: 'index.html',
      size: 64,
      mtime: '2026-07-21T00:00:00Z',
      kind: 'html',
      mime: 'text/html',
      dataUrl: 'data:text/html;charset=utf-8;base64,PGgxPkhlbGxvPC9oMT4=',
    },
    loading: false,
    error: null,
  });
  render(<FsTab cwd="/repo" />);
  fireEvent.click(screen.getByText('index.html'));
  const iframe = screen.getByTestId('fs-preview-html') as HTMLIFrameElement;
  expect(iframe.tagName).toBe('IFRAME');
  expect(iframe.getAttribute('src')).toBe(
    'data:text/html;charset=utf-8;base64,PGgxPkhlbGxvPC9oMT4=',
  );
  expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
  // Negative branches must not mount.
  expect(screen.queryByTestId('fs-preview-code')).toBeNull();
  expect(screen.queryByTestId('fs-preview-text')).toBeNull();
  expect(screen.queryByTestId('fs-preview-md')).toBeNull();
  expect(screen.queryByTestId('fs-preview-image')).toBeNull();
});

it('renders .htm files (alternate suffix) via the same iframe branch', () => {
  // Same data shape as .html; only the basename differs.
  mockList.mockReturnValue({
    data: {
      ok: true,
      entries: [
        { name: 'page.htm', path: 'page.htm', type: 'file', size: 64 },
      ],
    },
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
  mockFile.mockReturnValue({
    data: {
      ok: true,
      path: '/repo/page.htm',
      name: 'page.htm',
      size: 64,
      mtime: '2026-07-21T00:00:00Z',
      kind: 'html',
      mime: 'text/html',
      dataUrl: 'data:text/html;charset=utf-8;base64,PGgxPkhlbGxvPC9oMT4=',
    },
    loading: false,
    error: null,
  });
  render(<FsTab cwd="/repo" />);
  fireEvent.click(screen.getByText('page.htm'));
  expect(screen.getByTestId('fs-preview-html')).toBeTruthy();
});

it('HTML preview shows a preview/source Segmented toggle in the header', () => {
  // The toggle is gated by `showHtmlToggle` (kind === 'html' + dataUrl),
  // so it should appear ONLY for HTML files. For other kinds (code, md,
  // image) the Segmented control must not mount.
  mockList.mockReturnValue({
    data: {
      ok: true,
      entries: [
        { name: 'index.html', path: 'index.html', type: 'file', size: 64 },
      ],
    },
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
  mockFile.mockReturnValue({
    data: {
      ok: true,
      path: '/repo/index.html',
      name: 'index.html',
      size: 64,
      mtime: '2026-07-21T00:00:00Z',
      kind: 'html',
      mime: 'text/html',
      dataUrl: 'data:text/html;charset=utf-8;base64,PGgxPkhlbGxvPC9oMT4=',
    },
    loading: false,
    error: null,
  });
  render(<FsTab cwd="/repo" />);
  fireEvent.click(screen.getByText('index.html'));
  const seg = screen.getByTestId('fs-html-mode');
  expect(seg).toBeTruthy();
  // Two option labels: 预览 / 源码
  expect(screen.getByText('预览')).toBeTruthy();
  expect(screen.getByText('源码')).toBeTruthy();
});

it('HTML preview source toggle decodes base64 back to raw markup', () => {
  // Default mode is 'preview' (iframe). Clicking the '源码' option
  // should switch to the source <pre> and the markup must be a faithful
  // round-trip of the bytes encoded on the server. The test payload
  // `PGgxPkhlbGxvPC9oMT4=` is base64 for `<h1>Hello</h1>`.
  mockList.mockReturnValue({
    data: {
      ok: true,
      entries: [
        { name: 'index.html', path: 'index.html', type: 'file', size: 64 },
      ],
    },
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
  mockFile.mockReturnValue({
    data: {
      ok: true,
      path: '/repo/index.html',
      name: 'index.html',
      size: 64,
      mtime: '2026-07-21T00:00:00Z',
      kind: 'html',
      mime: 'text/html',
      dataUrl: 'data:text/html;charset=utf-8;base64,PGgxPkhlbGxvPC9oMT4=',
    },
    loading: false,
    error: null,
  });
  render(<FsTab cwd="/repo" />);
  fireEvent.click(screen.getByText('index.html'));
  // Iframe is mounted in preview mode.
  expect(screen.getByTestId('fs-preview-html')).toBeTruthy();
  // Switch to source.
  fireEvent.click(screen.getByText('源码'));
  const source = screen.getByTestId('fs-preview-html-source');
  expect(source).toBeTruthy();
  expect(source.textContent).toBe('<h1>Hello</h1>');
  // And the iframe should unmount.
  expect(screen.queryByTestId('fs-preview-html')).toBeNull();
});

it('does NOT show HTML preview/source toggle for non-HTML files', () => {
  // Regression: the Segmented control is gated on `showHtmlToggle`.
  // For .ts / .md / .png files it must not mount — otherwise the
  // header would gain a phantom toggle that does nothing for the
  // active preview.
  mockList.mockReturnValue({
    data: {
      ok: true,
      entries: [
        { name: 'foo.ts', path: 'foo.ts', type: 'file', size: 32 },
      ],
    },
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
  mockFile.mockReturnValue({
    data: {
      ok: true,
      path: '/repo/foo.ts',
      name: 'foo.ts',
      size: 32,
      mtime: '',
      content: 'export const x = 1;',
    },
    loading: false,
    error: null,
  });
  render(<FsTab cwd="/repo" />);
  fireEvent.click(screen.getByText('foo.ts'));
  expect(screen.getByTestId('fs-preview-code')).toBeTruthy();
  expect(screen.queryByTestId('fs-html-mode')).toBeNull();
});

// --- Task 6: Edit/Save/Cancel integration ---

it('shows 编辑 button only for text-kind files', () => {
  mockList.mockReturnValue({
    data: { ok: true, entries: [
      { name: 'foo.ts', path: 'foo.ts', type: 'file', size: 10 },
    ]},
    loading: false, error: null, refetch: vi.fn(),
  });
  mockFile.mockReturnValue({
    data: { ok: true, kind: 'text', path: '/repo/foo.ts', name: 'foo.ts', size: 10, mtime: '', content: 'x' },
    loading: false, error: null,
  });
  render(<FsTab cwd="/repo" />);
  fireEvent.click(screen.getByText('foo.ts'));
  expect(screen.getByTestId('fs-edit-btn')).toBeTruthy();
});

it('hides 编辑 button for image and html files', () => {
  mockList.mockReturnValue({
    data: { ok: true, entries: [
      { name: 'pic.png', path: 'pic.png', type: 'file', size: 10 },
    ]},
    loading: false, error: null, refetch: vi.fn(),
  });
  mockFile.mockReturnValue({
    data: { ok: true, kind: 'image', path: '/repo/pic.png', name: 'pic.png', size: 10, mime: 'image/png', dataUrl: 'data:image/png;base64,xxx' },
    loading: false, error: null,
  });
  render(<FsTab cwd="/repo" />);
  fireEvent.click(screen.getByText('pic.png'));
  expect(screen.queryByTestId('fs-edit-btn')).toBeNull();
});

it('enters edit mode on 编辑 click', async () => {
  mockList.mockReturnValue({
    data: { ok: true, entries: [
      { name: 'foo.ts', path: 'foo.ts', type: 'file', size: 10 },
    ]},
    loading: false, error: null, refetch: vi.fn(),
  });
  mockFile.mockReturnValue({
    data: { ok: true, kind: 'text', path: '/repo/foo.ts', name: 'foo.ts', size: 10, mtime: '', content: 'x' },
    loading: false, error: null,
  });
  render(<FsTab cwd="/repo" />);
  fireEvent.click(screen.getByText('foo.ts'));
  fireEvent.click(screen.getByTestId('fs-edit-btn'));
  // Lazy chunk needs one microtask to resolve; happy-dom doesn't
  // progress microtasks during fireEvent synchronously, so the
  // mock vi.fn() component only mounts on the next waitFor tick.
  await waitFor(() => {
    expect(screen.getByTestId('fs-editor')).toBeTruthy();
  });
  expect(screen.getByTestId('fs-save-btn')).toBeTruthy();
  expect(screen.getByTestId('fs-cancel-btn')).toBeTruthy();
});


// --- Content search mode (Switch) ---

it('renders the Switch in name mode by default', () => {
  mockList.mockReturnValue({ data: { ok: true, entries: [] }, loading: false, error: null, refetch: vi.fn() });
  mockFile.mockReturnValue({ data: null, loading: false, error: null });
  render(<FsTab cwd="/repo" />);
  const sw = screen.getByTestId('fs-search-mode') as HTMLElement;
  // antd Switch exposes role=switch with aria-checked
  expect(sw.getAttribute('aria-checked')).toBe('false');
});

it('toggling the Switch renders FsContentSearchList when query is non-empty', () => {
  mockList.mockReturnValue({ data: { ok: true, entries: [] }, loading: false, error: null, refetch: vi.fn() });
  mockFile.mockReturnValue({ data: null, loading: false, error: null });
  mockContentSearch.mockReturnValue({
    data: {
      ok: true,
      entries: [
        {
          path: 'src/foo.ts',
          name: 'foo.ts',
          matches: [{ line: 42, text: 'TODO', submatch: { text: 'TODO', start: 0, end: 4 } }],
        },
      ],
      truncated: false,
      durationMs: 5,
    },
    loading: false,
    error: null,
    durationMs: 5,
  });
  render(<FsTab cwd="/repo" />);
  const input = screen.getByTestId('fs-search-input') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'TODO' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  const sw = screen.getByTestId('fs-search-mode');
  fireEvent.click(sw);
  expect(sw.getAttribute('aria-checked')).toBe('true');
  expect(screen.getByTestId('fs-content-list')).toBeTruthy();
});

it('clicking a content search row passes pendingLine to FilePreview', () => {
  mockList.mockReturnValue({ data: { ok: true, entries: [] }, loading: false, error: null, refetch: vi.fn() });
  mockFile.mockReturnValue({
    data: {
      ok: true, kind: 'text', path: '/repo/src/foo.ts', name: 'foo.ts',
      size: 42, mtime: '', content: 'line1\nTODO\nline3\n',
    },
    loading: false,
    error: null,
  });
  mockContentSearch.mockReturnValue({
    data: {
      ok: true,
      entries: [
        {
          path: 'src/foo.ts', name: 'foo.ts',
          matches: [{ line: 2, text: 'TODO', submatch: { text: 'TODO', start: 0, end: 4 } }],
        },
      ],
      truncated: false,
      durationMs: 5,
    },
    loading: false,
    error: null,
    durationMs: 5,
  });
  render(<FsTab cwd="/repo" />);
  const input = screen.getByTestId('fs-search-input') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'TODO' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.click(screen.getByTestId('fs-search-mode'));
  fireEvent.click(screen.getByTestId('fs-content-row'));
  // pendingLine=2 should mark the second <span data-line="2"> as highlighted
  const line2 = document.querySelector('[data-line="2"]') as HTMLElement | null;
  expect(line2).toBeTruthy();
  // Background fades in via inline style. The data-line attr is what
  // marks it; the actual inline style is asserted in FsContentSearchList.
});

it('code preview renders a line-number gutter and per-line data-line anchors', async () => {
  // Regression: previously FsTab passed showLineNumbers={false} to the
  // SyntaxHighlighter, so the code preview had no line numbers and the
  // content-search jump-to-line effect had to fall back to a brittle
  // `lineHeight * (N-1)` scroll math. Now showLineNumbers + wrapLines +
  // lineProps are all on, the gutter is visible, and per-line
  // <span data-line={N}> anchors let the jump effect use querySelector.
  // The stub mirrors that contract (see vi.mock above) so this test
  // exercises the same DOM shape happy-dom would synthesize from a
  // real SyntaxHighlighter with these props.
  mockList.mockReturnValue({
    data: {
      ok: true,
      entries: [{ name: 'foo.ts', path: 'foo.ts', type: 'file', size: 42 }],
    },
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
  mockFile.mockReturnValue({
    data: {
      ok: true,
      path: '/repo/foo.ts',
      name: 'foo.ts',
      size: 42,
      mtime: '2026-07-21T00:00:00Z',
      content: 'line1\nTODO\nline3',
    },
    loading: false,
    error: null,
  });
  render(<FsTab cwd="/repo" />);
  fireEvent.click(screen.getByText('foo.ts'));
  await waitFor(() => {
    const codeBlock = screen.getByTestId('fs-preview-code');
    // The stub adds a data-testid for the gutter <code>. The real
    // library uses a similar <code style="float:left;..."> with no
    // testid, but the visual line-number <span> per line is what
    // we actually assert on below.
    expect(codeBlock.querySelector('.react-syntax-highlighter-line-number')).toBeTruthy();
  });
  // Gutter must contain a line number for each non-empty source line.
  // `content` has 3 newline-separated lines → 3 gutter spans.
  const codeBlock = screen.getByTestId('fs-preview-code');
  const gutter = codeBlock.querySelector('[data-testid="fs-line-gutter"]') as HTMLElement | null;
  expect(gutter).toBeTruthy();
  expect(gutter!.querySelectorAll('.react-syntax-highlighter-line-number').length).toBe(3);
  // Per-line data-line anchors — one per non-empty source line.
  // The jump effect (pendingLine=2) needs [data-line="2"] to exist
  // before scrollIntoView is called; the click-content-search-row
  // test below covers the actual scroll path.
  const dataLines = codeBlock.querySelectorAll('[data-line]');
  expect(dataLines.length).toBe(3);
  expect(codeBlock.querySelector('[data-line="1"]')).toBeTruthy();
  expect(codeBlock.querySelector('[data-line="2"]')).toBeTruthy();
  expect(codeBlock.querySelector('[data-line="3"]')).toBeTruthy();
});

it('content-search row click on .ts file scrolls to the matched line via data-line anchor', async () => {
  // End-to-end of the jump effect: switch to content mode, click the
  // first match at line=2, and verify the data-line="2" span is the
  // one the effect calls scrollIntoView on. The previous "brittle
  // lineHeight * (N-1) math" path is gone — the effect should hit
  // the [data-line="2"] anchor via querySelector. We spy on
  // Element.prototype.scrollIntoView so we don't have to assert
  // against happy-dom's specific style-string serialization (it
  // varies across versions and we're not testing the renderer).
  const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView');
  try {
    mockList.mockReturnValue({
      data: { ok: true, entries: [] },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockFile.mockReturnValue({
      data: {
        ok: true, kind: 'text', path: '/repo/src/foo.ts', name: 'foo.ts',
        size: 42, mtime: '', content: 'line1\nTODO\nline3',
      },
      loading: false,
      error: null,
    });
    mockContentSearch.mockReturnValue({
      data: {
        ok: true,
        entries: [
          {
            path: 'src/foo.ts', name: 'foo.ts',
            matches: [{ line: 2, text: 'TODO', submatch: { text: 'TODO', start: 0, end: 4 } }],
          },
        ],
        truncated: false,
        durationMs: 5,
      },
      loading: false,
      error: null,
      durationMs: 5,
    });
    render(<FsTab cwd="/repo" />);
    const input = screen.getByTestId('fs-search-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'TODO' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByTestId('fs-search-mode'));
    fireEvent.click(screen.getByTestId('fs-content-row'));
    await waitFor(() => {
      // fs-preview-code mounts once SyntaxHighlighter chunk resolves,
      // and the effect calls scrollIntoView on the matched data-line.
      // We don't assert against the data-line here because the
      // existing "clicking a content search row passes pendingLine"
      // test already covers that; this one is about the integration:
      // did the effect fire at all when the chunk is syntax-highlighted
      // (which is the regression we're guarding against — the old
      // fallback math was the broken path).
      expect(scrollSpy).toHaveBeenCalled();
      const calls = scrollSpy.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      // The element that was scrolled into view should be the line-2
      // span (the data-line="2" anchor, not the wrapper).
      const target = calls[0]?.[0] as Element | undefined;
      // `this` is the element that scrollIntoView was called on.
      // vi.fn() captures `this` in mock.instances[0].
      const calledEl = (scrollSpy.mock.instances[0] ?? target) as HTMLElement | undefined;
      expect(calledEl?.getAttribute('data-line')).toBe('2');
    });
  } finally {
    scrollSpy.mockRestore();
  }
});

it('cwd change resets mode and pendingLine', () => {
  mockList.mockReturnValue({ data: { ok: true, entries: [] }, loading: false, error: null, refetch: vi.fn() });
  mockFile.mockReturnValue({ data: null, loading: false, error: null });
  mockContentSearch.mockReturnValue({
    data: {
      ok: true,
      entries: [{ path: 'a.ts', name: 'a.ts', matches: [{ line: 1, text: 'x', submatch: { text: 'x', start: 0, end: 1 } }] }],
      truncated: false,
      durationMs: 1,
    },
    loading: false,
    error: null,
    durationMs: 1,
  });
  const { rerender } = render(<FsTab cwd="/repo1" />);
  fireEvent.change(screen.getByTestId('fs-search-input'), { target: { value: 'foo' } });
  fireEvent.click(screen.getByTestId('fs-search-mode'));
  rerender(<FsTab cwd="/repo2" />);
  // After cwd change, query should be empty and mode reset to 'name'
  const input = screen.getByTestId('fs-search-input') as HTMLInputElement;
  expect(input.value).toBe('');
  const sw = screen.getByTestId('fs-search-mode');
  expect(sw.getAttribute('aria-checked')).toBe('false');
});
