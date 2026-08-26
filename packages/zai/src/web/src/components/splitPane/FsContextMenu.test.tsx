// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, act } from '@testing-library/react';
import { message } from 'antd';

// Hand-rolled handle for Modal.confirm so tests can drive onOk only when
// they choose — happy-dom's AntD Modal rendering has been flaky in this
// repo. Each call to Modal.confirm stores its options under `lastConfirm`;
// tests await `lastConfirm.onOk()` to simulate the user clicking OK.
let lastConfirm: { onOk?: () => void | Promise<void> } | null = null;
vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd');
  const modalConfirm = vi.fn((opts: { onOk?: () => void | Promise<void> }) => {
    lastConfirm = opts;
  });
  return {
    ...actual,
    message: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
    Modal: { ...actual.Modal, confirm: modalConfirm },
  };
});

import { FsContextMenu } from './FsContextMenu.js';

const cwd = '/repo';
const path = 'src/index.ts';
const absPath = '/repo/src/index.ts';

describe('FsContextMenu', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    lastConfirm = null;
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

  it('dispatches agent-input-insert with relative path and closes menu', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    const onClose = vi.fn();
    render(<FsContextMenu path={path} absPath={absPath} cwd={cwd} position={{ x: 0, y: 0 }} onClose={onClose} />);
    const item = await waitFor(() => document.querySelector('[data-testid="fs-cm-insert"]') as HTMLElement);
    await act(async () => { fireEvent.click(item); });
    const insertEvent = dispatchSpy.mock.calls
      .map((c) => c[0] as CustomEvent<{ text: string }>)
      .find((ev) => ev.type === 'agent-input-insert');
    expect(insertEvent?.detail).toEqual({ text: path });
    expect(onClose).toHaveBeenCalled();
  });

  it('dispatches agent-input-insert with kind=dir when opened on a directory', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    render(<FsContextMenu path="src" absPath="/repo/src" cwd={cwd} kind="dir" position={{ x: 0, y: 0 }} onClose={vi.fn()} />);
    const item = await waitFor(() => document.querySelector('[data-testid="fs-cm-insert"]') as HTMLElement);
    await act(async () => { fireEvent.click(item); });
    const insertEvent = dispatchSpy.mock.calls
      .map((c) => c[0] as CustomEvent<{ text: string; kind?: string }>)
      .find((ev) => ev.type === 'agent-input-insert');
    expect(insertEvent?.detail).toEqual({ text: 'src', kind: 'dir' });
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

  it('shows confirmation dialog before deleting and posts /fs/delete on confirm', async () => {
    const { Modal } = await import('antd');
    const onDeleted = vi.fn();
    render(
      <FsContextMenu
        path={path}
        absPath={absPath}
        cwd={cwd}
        position={{ x: 0, y: 0 }}
        onClose={vi.fn()}
        onDeleted={onDeleted}
      />,
    );
    const item = await waitFor(() => document.querySelector('[data-testid="fs-cm-delete"]') as HTMLElement);
    await act(async () => { fireEvent.click(item); });
    // Modal.confirm must be invoked; before the user confirms we must
    // NOT have hit the network.
    expect(Modal.confirm).toHaveBeenCalled();
    expect(lastConfirm).not.toBeNull();
    expect((globalThis.fetch as any)).not.toHaveBeenCalled();
    // Simulate the user clicking OK in the confirm dialog.
    await act(async () => {
      await lastConfirm!.onOk?.();
    });
    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/fs/delete', expect.objectContaining({ method: 'POST' })),
    );
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  });
});
