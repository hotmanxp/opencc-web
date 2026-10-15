// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react';
import { message } from 'antd';

// Hand-rolled handle for Modal.confirm so tests can drive onOk only when
// they choose — happy-dom's AntD Modal rendering has been flaky in this
// repo. Each call to Modal.confirm stores its options under `lastConfirm`;
// tests await `lastConfirm.onOk()` to simulate the user clicking OK.
let lastConfirm: { onOk?: () => void | Promise<void> } | null = null;
vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd');
  const { createElement: e } = await import('react');
  const modalConfirm = vi.fn((opts: { onOk?: () => void | Promise<void> }) => {
    lastConfirm = opts;
  });
  // 新建弹窗用的是受控 <Modal>(不是 Modal.confirm),happy-dom 渲染真
  // antd Modal 不稳,这里换成朴素 stub:children 照常渲染,ok 按钮带
  // data-testid 供测试点击。confirm 静态方法保留给删除流程。
  const ModalStub = (props: {
    open?: boolean;
    title?: React.ReactNode;
    children?: React.ReactNode;
    onOk?: () => void;
    onCancel?: () => void;
    okText?: string;
  }) =>
    props.open
      ? e(
          'div',
          { 'data-testid': 'mock-modal' },
          e('div', { 'data-testid': 'mock-modal-title' }, props.title),
          props.children,
          e('button', { 'data-testid': 'fs-create-ok', onClick: props.onOk }, props.okText ?? '确定'),
          e('button', { 'data-testid': 'fs-create-cancel', onClick: props.onCancel }, '取消'),
        )
      : null;
  return {
    ...actual,
    message: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
    // 注意展开顺序:actual.Modal 的静态成员必须**先**铺,confirm spy 后铺 ——
    // 反过来会把 spy 覆盖回真函数,`expect(Modal.confirm)` 就不再是 spy。
    Modal: Object.assign(ModalStub, { ...(actual as any).Modal }, { confirm: modalConfirm }),
  };
});

import { FsContextMenu, FsCreateDialog } from './FsContextMenu.js';

const cwd = '/repo';
const path = 'src/index.ts';
const absPath = '/repo/src/index.ts';

// 回归测试要模拟 FsTab 的真实接线:菜单抛意图 → 父级 useState 存 target →
// 弹窗独立渲染。target 必须是真 state,否则菜单卸载时不会触发重渲染,
// 测出来的「弹窗还在」是假象。
function CreateHarness(props: { menuOpen: boolean }): JSX.Element {
  const [target, setTarget] = React.useState<{ type: 'file' | 'dir'; dir: string } | null>(null);
  return (
    <>
      {props.menuOpen ? (
        <FsContextMenu
          path={path}
          absPath={absPath}
          cwd={cwd}
          position={{ x: 0, y: 0 }}
          onClose={vi.fn()}
          onRequestCreate={setTarget}
        />
      ) : null}
      <FsCreateDialog target={target} onClose={() => setTarget(null)} onCreated={vi.fn()} />
    </>
  );
}

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

  // --- 新建入口(只负责抛意图,弹窗由 FsCreateDialog 渲染) ---------------

  it('create items ask the parent to open the dialog, targeting the sibling dir', async () => {
    const onRequestCreate = vi.fn();
    const onClose = vi.fn();
    render(
      <FsContextMenu path={path} absPath={absPath} cwd={cwd} position={{ x: 0, y: 0 }} onClose={onClose} onRequestCreate={onRequestCreate} />,
    );
    const item = await waitFor(() => document.querySelector('[data-testid="fs-cm-create-file"]') as HTMLElement);
    await act(async () => { fireEvent.click(item); });
    // 右键的是 src/index.ts(文件) → 建进它的父目录 src/
    expect(onRequestCreate).toHaveBeenCalledWith({ type: 'file', dir: 'src' });
    // 菜单随即关闭(antd Dropdown 行为),这也是弹窗不能挂在菜单里的原因。
    expect(onClose).toHaveBeenCalled();
  });

  it('create-dir targets the right-clicked directory itself', async () => {
    const onRequestCreate = vi.fn();
    render(
      <FsContextMenu path="src" absPath="/repo/src" cwd={cwd} kind="dir" position={{ x: 0, y: 0 }} onClose={vi.fn()} onRequestCreate={onRequestCreate} />,
    );
    const item = await waitFor(() => document.querySelector('[data-testid="fs-cm-create-dir"]') as HTMLElement);
    await act(async () => { fireEvent.click(item); });
    expect(onRequestCreate).toHaveBeenCalledWith({ type: 'dir', dir: 'src' });
  });

  it('root mode (path="") offers only create items', async () => {
    render(<FsContextMenu path="" absPath={cwd} cwd={cwd} kind="dir" position={{ x: 0, y: 0 }} onClose={vi.fn()} />);
    await waitFor(() => document.querySelector('[data-testid="fs-cm-create-file"]'));
    // 根没有可预览/复制/删除的具体条目。
    expect(document.querySelector('[data-testid="fs-cm-delete"]')).toBeNull();
    expect(document.querySelector('[data-testid="fs-cm-preview"]')).toBeNull();
    expect(document.querySelector('[data-testid="fs-cm-copy-rel"]')).toBeNull();
  });

  // 回归(2026-10-11 真实浏览器实测):菜单组件被卸载后,弹窗必须还在。
  // 之前 createTarget 存在 FsContextMenu 内部,antd Dropdown 关闭 → 父级
  // setContextMenu(null) → 整个组件卸载 → 弹窗一帧都没渲染过,且无 JS 报错。
  it('menu unmounting does not take the create dialog with it', async () => {
    const { rerender } = render(<CreateHarness menuOpen />);
    const item = await waitFor(() => document.querySelector('[data-testid="fs-cm-create-file"]') as HTMLElement);
    await act(async () => { fireEvent.click(item); });
    expect(document.querySelector('[data-testid="fs-create-name-input"]')).not.toBeNull();
    // 模拟父级把右键菜单关掉(contextMenu → null,FsContextMenu 整体卸载)。
    rerender(<CreateHarness menuOpen={false} />);
    expect(document.querySelector('[data-testid="fs-create-name-input"]')).not.toBeNull();
  });
});

describe('FsCreateDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    (globalThis.fetch as any) = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  });

  it('posts /fs/create and reports the created entry', async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<FsCreateDialog target={{ type: 'file', dir: 'src' }} onClose={onClose} onCreated={onCreated} />);
    const input = await waitFor(() => document.querySelector('[data-testid="fs-create-name-input"]') as HTMLInputElement);
    await act(async () => {
      fireEvent.change(input, { target: { value: 'new.ts' } });
      fireEvent.click(document.querySelector('[data-testid="fs-create-ok"]') as HTMLElement);
    });
    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/fs/create', expect.objectContaining({ method: 'POST' })),
    );
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body).toMatchObject({ dir: 'src', name: 'new.ts', type: 'file' });
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('creates a directory at the cwd root when dir is empty', async () => {
    render(<FsCreateDialog target={{ type: 'dir', dir: '' }} onClose={vi.fn()} onCreated={vi.fn()} />);
    const input = await waitFor(() => document.querySelector('[data-testid="fs-create-name-input"]') as HTMLInputElement);
    await act(async () => {
      fireEvent.change(input, { target: { value: 'components' } });
      fireEvent.click(document.querySelector('[data-testid="fs-create-ok"]') as HTMLElement);
    });
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body).toMatchObject({ dir: '', name: 'components', type: 'dir' });
  });

  it('warns and does not POST when the name is empty', async () => {
    render(<FsCreateDialog target={{ type: 'file', dir: '' }} onClose={vi.fn()} onCreated={vi.fn()} />);
    await waitFor(() => document.querySelector('[data-testid="fs-create-ok"]'));
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="fs-create-ok"]') as HTMLElement);
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect((message.warning as any)).toHaveBeenCalledWith('名称不能为空');
  });

  it('surfaces server error and does not call onCreated', async () => {
    (globalThis.fetch as any) = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ ok: false, error: '已存在同名文件或目录' }),
    });
    const onCreated = vi.fn();
    render(<FsCreateDialog target={{ type: 'file', dir: '' }} onClose={vi.fn()} onCreated={onCreated} />);
    const input = await waitFor(() => document.querySelector('[data-testid="fs-create-name-input"]') as HTMLInputElement);
    await act(async () => {
      fireEvent.change(input, { target: { value: 'dup.ts' } });
      fireEvent.click(document.querySelector('[data-testid="fs-create-ok"]') as HTMLElement);
    });
    await waitFor(() => expect((message.error as any)).toHaveBeenCalledWith('已存在同名文件或目录'));
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('warns that an extension-less file can be created but not edited', async () => {
    render(<FsCreateDialog target={{ type: 'file', dir: '' }} onClose={vi.fn()} onCreated={vi.fn()} />);
    const input = await waitFor(() => document.querySelector('[data-testid="fs-create-name-input"]') as HTMLInputElement);
    await act(async () => {
      fireEvent.change(input, { target: { value: 'NOTES' } });
      fireEvent.click(document.querySelector('[data-testid="fs-create-ok"]') as HTMLElement);
    });
    // 建成了,但要提醒存不了(PUT /fs/file 的 TEXT_EXTS 白名单会拒)。
    expect(globalThis.fetch).toHaveBeenCalled();
    await waitFor(() => expect((message.warning as any)).toHaveBeenCalledWith(expect.stringContaining('无法在 zai 内编辑保存')));
  });

  it('does not warn for a whitelisted extension', async () => {
    render(<FsCreateDialog target={{ type: 'file', dir: '' }} onClose={vi.fn()} onCreated={vi.fn()} />);
    const input = await waitFor(() => document.querySelector('[data-testid="fs-create-name-input"]') as HTMLInputElement);
    await act(async () => {
      fireEvent.change(input, { target: { value: 'notes.md' } });
      fireEvent.click(document.querySelector('[data-testid="fs-create-ok"]') as HTMLElement);
    });
    await waitFor(() => expect((message.success as any)).toHaveBeenCalled());
    expect((message.warning as any)).not.toHaveBeenCalled();
  });
});