// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, act } from '@testing-library/react';
import { message } from 'antd';

vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd');
  return { ...actual, message: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } };
});

import { FsContextMenu } from './FsContextMenu.js';

const cwd = '/repo';
const path = 'src/index.ts';
const absPath = '/repo/src/index.ts';

describe('FsContextMenu', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // happy-dom defines navigator.clipboard with a getter; redefine via defineProperty
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    (globalThis.fetch as any) = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  });

  it('copies relative path to clipboard', async () => {
    render(<FsContextMenu path={path} absPath={absPath} cwd={cwd} position={{ x: 0, y: 0 }} onClose={vi.fn()} />);
    const item = await waitFor(() => document.querySelector('[data-testid="fs-cm-copy-rel"]') as HTMLElement);
    await act(async () => { fireEvent.click(item); });
    expect((navigator.clipboard.writeText as any)).toHaveBeenCalledWith(path);
  });

  it('copies absolute path to clipboard', async () => {
    render(<FsContextMenu path={path} absPath={absPath} cwd={cwd} position={{ x: 0, y: 0 }} onClose={vi.fn()} />);
    const item = await waitFor(() => document.querySelector('[data-testid="fs-cm-copy-abs"]') as HTMLElement);
    await act(async () => { fireEvent.click(item); });
    expect((navigator.clipboard.writeText as any)).toHaveBeenCalledWith(absPath);
  });

  it('calls /fs/reveal when Reveal in Finder clicked', async () => {
    render(<FsContextMenu path={path} absPath={absPath} cwd={cwd} position={{ x: 0, y: 0 }} onClose={vi.fn()} />);
    const item = await waitFor(() => document.querySelector('[data-testid="fs-cm-reveal"]') as HTMLElement);
    await act(async () => { fireEvent.click(item); });
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/fs/reveal', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.path).toBe(path);
  });

  it('calls /fs/open-terminal when Open Terminal clicked', async () => {
    render(<FsContextMenu path={path} absPath={absPath} cwd={cwd} position={{ x: 0, y: 0 }} onClose={vi.fn()} />);
    const item = await waitFor(() => document.querySelector('[data-testid="fs-cm-open-terminal"]') as HTMLElement);
    await act(async () => { fireEvent.click(item); });
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/fs/open-terminal', expect.objectContaining({ method: 'POST' }));
  });

  it('surfaces server error via message.error', async () => {
    (globalThis.fetch as any) = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ ok: false, error: 'fail' }) });
    render(<FsContextMenu path={path} absPath={absPath} cwd={cwd} position={{ x: 0, y: 0 }} onClose={vi.fn()} />);
    const item = await waitFor(() => document.querySelector('[data-testid="fs-cm-reveal"]') as HTMLElement);
    await act(async () => { fireEvent.click(item); });
    await waitFor(() => expect((message.error as any)).toHaveBeenCalled());
  });

  it('calls onClose after any action', async () => {
    const onClose = vi.fn();
    render(<FsContextMenu path={path} absPath={absPath} cwd={cwd} position={{ x: 0, y: 0 }} onClose={onClose} />);
    const item = await waitFor(() => document.querySelector('[data-testid="fs-cm-copy-rel"]') as HTMLElement);
    await act(async () => { fireEvent.click(item); });
    expect(onClose).toHaveBeenCalled();
  });
});