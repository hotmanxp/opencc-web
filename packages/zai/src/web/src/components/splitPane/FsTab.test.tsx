// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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
      data: { ok: false, error: '目录深度超过 3 层' },
      loading: false,
      error: '目录深度超过 3 层',
      refetch: vi.fn(),
    });
    mockFile.mockReturnValue({ data: null, loading: false, error: null });
    render(<FsTab cwd="/repo" />);
    expect(screen.getByText(/目录深度超过 3 层/)).toBeTruthy();
  });
});