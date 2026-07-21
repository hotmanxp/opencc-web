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
    // Plain `.md` / `.json` files fall through to the unstyled `<pre>`.
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

  it('mounts fs-tree as a fixed-height column with overflow:auto so scroll always works', () => {
    // antd Tree uses rc-virtual-list internally; rc-virtual-list only
    // sets its own maxHeight + overflowY when given a numeric height prop.
    // The column needs minHeight:0 (so flexbox doesn't expand it past
    // the panel).
    //
    // overflow:auto (not hidden) is the safe default: when the inner
    // <Tree height={treeHeight}> successfully enables rc-virtual-list,
    // the inner holder owns the scrollbar and the outer auto just stays
    // inert. But if `treeHeight` is 0 — e.g. the rAF re-measure in
    // useElementHeight hasn't fired yet, or the parent flex column
    // genuinely has 0 height — the Tree falls back to natural height
    // and the outer overflow:auto keeps the content scrollable instead
    // of silently clipping it off-panel. The previous `hidden` was a
    // hard cut that left users with no way to reach the rest of the tree.
    mockList.mockReturnValue({
      data: { ok: true, entries: [] },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockFile.mockReturnValue({ data: null, loading: false, error: null });
    render(<FsTab cwd="/repo" />);
    const tree = screen.getByTestId('fs-tree') as HTMLElement;
    expect(tree.style.overflow).toBe('auto');
    expect(tree.style.minHeight).toMatch(/^0(px)?$/);
  });
});