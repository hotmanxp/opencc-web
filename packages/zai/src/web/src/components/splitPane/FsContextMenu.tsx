import { Dropdown, Menu, message } from 'antd';
import React, { useMemo } from 'react';

export interface FsContextMenuProps {
  /** Path relative to cwd (sent to server verbatim). */
  path: string;
  /** Absolute path (sent to clipboard for "Copy Absolute Path"). */
  absPath: string;
  cwd: string;
  /** Right-click screen coordinates. `null` keeps the menu closed. */
  position: { x: number; y: number } | null;
  onClose: () => void;
}

async function postFsCommand(endpoint: 'reveal' | 'open-terminal', path: string): Promise<void> {
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
  message.success(endpoint === 'reveal' ? '已在文件管理器中打开' : '已打开终端');
}

export function FsContextMenu(props: FsContextMenuProps): JSX.Element | null {
  const { path, absPath, position, onClose } = props;

  const menuItems = useMemo(() => [
    {
      key: 'copy-rel',
      'data-testid': 'fs-cm-copy-rel',
      label: 'Copy Relative Path',
      onClick: () => copyToClipboard(path, '已复制相对路径', onClose),
    },
    {
      key: 'copy-abs',
      'data-testid': 'fs-cm-copy-abs',
      label: 'Copy Absolute Path',
      onClick: () => copyToClipboard(absPath, '已复制绝对路径', onClose),
    },
    { type: 'divider' as const },
    {
      key: 'reveal',
      'data-testid': 'fs-cm-reveal',
      label: 'Reveal in Finder',
      onClick: () => postFsCommand('reveal', path).then(onClose),
    },
    {
      key: 'open-terminal',
      'data-testid': 'fs-cm-open-terminal',
      label: 'Open in Integrated Terminal',
      onClick: () => postFsCommand('open-terminal', path).then(onClose),
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