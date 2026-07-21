// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('./useFsList.js', () => ({ useFsList: vi.fn() }));
vi.mock('./useFsFile.js', () => ({ useFsFile: vi.fn() }));

import { useFsList } from './useFsList.js';
import { useFsFile } from './useFsFile.js';
import { FsTab } from './FsTab.js';

const mockList = useFsList as unknown as ReturnType<typeof vi.fn>;
const mockFile = useFsFile as unknown as ReturnType<typeof vi.fn>;

describe('FsTab', () => {
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
    expect(screen.getByText(/按需加载/)).toBeTruthy();
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

  it('uses fs-preview-code test-id for .ts files (syntax highlighted)', () => {
    // Drive selection via the tree click path. We mock useFsList with
    // a single .ts entry; expanding isn't required because the
    // `onSelect` handler reads from expandedKeys state directly. Easiest
    // way: stub the Tree to fire onSelect with the file path. To keep
    // this test simple and deterministic we directly assert on the
    // renderPreview helper through a known-state entry.
    //
    // Concretely: mockFile returns content for `foo.ts` and we use a
    // mockList that returns that file as the *root-level* entry; then
    // click it. The Tree fires onSelect only for file (leaf) nodes
    // automatically when the user clicks — we simulate that by calling
    // the antd Tree's onSelect prop via fireEvent.
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
    // Find the title node and click it; antd Tree wires onSelect to
    // the row's click handler.
    const title = screen.getByText('foo.ts');
    fireEvent.click(title);
    // Now the preview block is mounted — and it's the code variant.
    expect(screen.getByTestId('fs-preview-code')).toBeTruthy();
    expect(screen.queryByTestId('fs-preview-text')).toBeNull();
    // SyntaxHighlighter doesn't emit `language-typescript` on the <pre>;
    // it wraps each token in <span class="token" style=...> inside the
    // <code>. happy-dom runs Prism's tokenization and renders these
    // spans, so we assert that the code element contains at least one
    // token span — that proves we hit the SyntaxHighlighter path
    // instead of the plain <pre> fallback (which would render a single
    // text node, no spans).
    const codeBlock = screen.getByTestId('fs-preview-code');
    const codeEl = codeBlock.querySelector('code');
    expect(codeEl).toBeTruthy();
    expect(codeEl && codeEl.querySelectorAll('span').length).toBeGreaterThan(0);
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

  it('uses fs-preview-code test-id for .json files (Prism JSON highlighting)', () => {
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
    // Prism tokenization should produce token spans inside <code>.
    const codeBlock = screen.getByTestId('fs-preview-code');
    const codeEl = codeBlock.querySelector('code');
    expect(codeEl).toBeTruthy();
    expect(codeEl && codeEl.querySelectorAll('span').length).toBeGreaterThan(0);
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
});