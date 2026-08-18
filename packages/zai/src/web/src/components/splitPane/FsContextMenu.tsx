import { Dropdown, Menu, message, Modal } from 'antd';
import React, { useMemo } from 'react';
import {
  AGENT_INPUT_INSERT_EVENT,
  type AgentInputInsertDetail,
} from '../../lib/agentInputEvents.js';

export interface FsContextMenuProps {
  /** Path relative to cwd (sent to server verbatim). */
  path: string;
  /** Absolute path (sent to clipboard for "Copy Absolute Path"). */
  absPath: string;
  cwd: string;
  /** Right-click screen coordinates. `null` keeps the menu closed. */
  position: { x: number; y: number } | null;
  onClose: () => void;
  /** Called after a file or directory is successfully deleted so the parent can refresh. */
  onDeleted?: () => void;
}

async function postFsCommand(endpoint: 'reveal' | 'open-terminal' | 'delete', path: string): Promise<void> {
  const res = await fetch(`/api/fs/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  const body = (await res.json().catch(() => ({ ok: false, error: 'parse' }))) as { ok: boolean; error?: string };
  if (!res.ok || !body.ok) {
    message.error(body.error ?? `${endpoint} 失败`);
    return;
  }
  if (endpoint === 'reveal') message.success('已在文件管理器中打开');
  else if (endpoint === 'open-terminal') message.success('已打开终端');
  else if (endpoint === 'delete') message.success('已删除');
}

async function copyToClipboard(text: string, successMsg: string, onClose: () => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    message.success(successMsg);
  } catch {
    message.warning('复制失败，请手动选中');
  } finally {
    onClose();
  }
}

export function FsContextMenu(props: FsContextMenuProps): JSX.Element | null {
  const { path, absPath, position, onClose, onDeleted } = props;

  const handleDelete = () => {
    Modal.confirm({
      title: '确认删除',
      content: (
        <span>
          确定要删除 <strong style={{ wordBreak: 'break-all' }}>{path}</strong> 吗？此操作不可撤销。
        </span>
      ),
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await postFsCommand('delete', path);
        onClose();
        onDeleted?.();
      },
    });
  };

  const menuItems = useMemo(() => [
    {
      key: 'insert',
      'data-testid': 'fs-cm-insert',
      label: '插入对话',
      onClick: () => {
        window.dispatchEvent(
          new CustomEvent<AgentInputInsertDetail>(AGENT_INPUT_INSERT_EVENT, {
            detail: { text: path },
          }),
        );
        onClose();
      },
    },
    {
      key: 'copy-rel',
      'data-testid': 'fs-cm-copy-rel',
      label: '复制相对路径',
      onClick: () => copyToClipboard(path, '已复制相对路径', onClose),
    },
    {
      key: 'copy-abs',
      'data-testid': 'fs-cm-copy-abs',
      label: '复制绝对路径',
      onClick: () => copyToClipboard(absPath, '已复制绝对路径', onClose),
    },
    { type: 'divider' as const },
    {
      key: 'reveal',
      'data-testid': 'fs-cm-reveal',
      label: '在文件管理器中显示',
      onClick: () => postFsCommand('reveal', path).then(onClose),
    },
    {
      key: 'open-terminal',
      'data-testid': 'fs-cm-open-terminal',
      label: '在终端中打开',
      onClick: () => postFsCommand('open-terminal', path).then(onClose),
    },
    { type: 'divider' as const },
    {
      key: 'delete',
      'data-testid': 'fs-cm-delete',
      label: '删除',
      danger: true,
      onClick: handleDelete,
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [path, absPath]);

  if (!position) return null;
  return (
    <Dropdown
      trigger={['click']}
      menu={{ items: menuItems }}
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
    >
      <span
        aria-hidden
        style={{
          position: 'fixed',
          left: position.x,
          top: position.y,
          width: 1,
          height: 1,
          pointerEvents: 'none',
        }}
      />
    </Dropdown>
  );
}
