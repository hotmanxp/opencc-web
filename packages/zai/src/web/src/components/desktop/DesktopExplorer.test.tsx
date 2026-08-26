// @vitest-environment happy-dom
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DesktopExplorer, { type ExplorerEntry } from './DesktopExplorer.js';
import { api } from '../../lib/api.js';
import '@testing-library/jest-dom';

vi.mock('../../lib/api.js', () => ({
  api: { get: vi.fn() },
}));

const mkList = (path: string, entries: ExplorerEntry[], parent: string | null = null) => ({
  ok: true, path, parent, entries,
});

describe('DesktopExplorer', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset();
  });

  test('挂载后 GET /desktop/fs/list 并渲染文件网格', async () => {
    vi.mocked(api.get).mockResolvedValueOnce(
      mkList('/Users/t/sandbox', [
        { name: 'docs', kind: 'dir', path: '/Users/t/sandbox/docs', size: 0, mtime: 1 },
        { name: 'a.md', kind: 'file', path: '/Users/t/sandbox/a.md', size: 12, mtime: 2 },
      ], '/Users/t'),
    );
    render(<DesktopExplorer cwd="/Users/t/sandbox" home="/Users/t" onOpenFile={() => {}} onDragFile={() => {}} />);
    await waitFor(() => expect(screen.getByText('a.md')).toBeInTheDocument());
    expect(screen.getByText('docs')).toBeInTheDocument();
  });

  test('双击目录 → 窗内导航:再次 GET 子目录并刷新网格', async () => {
    vi.mocked(api.get)
      .mockResolvedValueOnce(mkList('/Users/t', [{ name: 'docs', kind: 'dir', path: '/Users/t/docs', size: 0, mtime: 1 }], null))
      .mockResolvedValueOnce(mkList('/Users/t/docs', [{ name: 'inner.md', kind: 'file', path: '/Users/t/docs/inner.md', size: 1, mtime: 3 }], '/Users/t'));
    render(<DesktopExplorer cwd="/Users/t/sandbox" home="/Users/t" onOpenFile={() => {}} onDragFile={() => {}} />);
    await waitFor(() => screen.getByText('docs'));
    fireEvent.doubleClick(screen.getByText('docs'));
    await waitFor(() => expect(screen.getByText('inner.md')).toBeInTheDocument());
    const secondCall = vi.mocked(api.get).mock.calls[1]?.[0] as string;
    expect(secondCall).toContain(encodeURIComponent('/Users/t/docs'));
  });

  test('双击文件触发 onOpenFile', async () => {
    const onOpenFile = vi.fn();
    vi.mocked(api.get).mockResolvedValueOnce(
      mkList('/Users/t', [{ name: 'a.md', kind: 'file', path: '/Users/t/a.md', size: 1, mtime: 1 }], null),
    );
    render(<DesktopExplorer cwd="/Users/t/sandbox" home="/Users/t" onOpenFile={onOpenFile} onDragFile={() => {}} />);
    await waitFor(() => screen.getByText('a.md'));
    fireEvent.doubleClick(screen.getByText('a.md'));
    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ path: '/Users/t/a.md' }));
  });

  test('请求失败 → 窗内错误文案(ok:false)', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ ok: false, error: '无权限访问: /x' });
    render(<DesktopExplorer cwd="/Users/t/sandbox" home="/Users/t" onOpenFile={() => {}} onDragFile={() => {}} />);
    await waitFor(() => expect(screen.getByText(/无权限访问/)).toBeInTheDocument());
  });

  test('切到「线上」Tab 显示待接入空态', () => {
    vi.mocked(api.get).mockResolvedValueOnce(mkList('/Users/t', []));
    render(<DesktopExplorer cwd="/Users/t/sandbox" home="/Users/t" onOpenFile={() => {}} onDragFile={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: '线上' }));
    expect(screen.getByText(/待接入/)).toBeInTheDocument();
  });

  test('defaultPath prop → 首开 GET 携带 path 参数', async () => {
    vi.mocked(api.get).mockResolvedValueOnce(
      mkList('/Users/t/docs', [{ name: 'a.md', kind: 'file', path: '/Users/t/docs/a.md', size: 1, mtime: 1 }], '/Users/t'),
    );
    render(<DesktopExplorer cwd="/Users/t/sandbox" home="/Users/t" onOpenFile={() => {}} onDragFile={() => {}} defaultPath="/Users/t/docs" />);
    await waitFor(() => expect(screen.getByText('a.md')).toBeInTheDocument());
    const firstCall = vi.mocked(api.get).mock.calls[0]?.[0] as string;
    expect(firstCall).toContain(encodeURIComponent('/Users/t/docs'));
  });
});
