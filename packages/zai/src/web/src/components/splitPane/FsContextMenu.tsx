import { Dropdown, Menu, message, Modal, Input } from 'antd';
import React, { useEffect, useMemo, useRef } from 'react';
import {
  AGENT_INPUT_INSERT_EVENT,
  type AgentInputInsertDetail,
} from '../../lib/agentInputEvents.js';
import { useAgentStore } from '../../store/useAgentStore.js';
import { TEXT_EXTS } from '@shared/fileKind';

export interface FsContextMenuProps {
  /** Path relative to cwd (sent to server verbatim). */
  path: string;
  /** Absolute path (sent to clipboard for "Copy Absolute Path"). */
  absPath: string;
  cwd: string;
  /** Entry kind(目录/文件);「插入对话」据此把内容插入为对应类型的 @引用 chip。 */
  kind?: 'file' | 'dir';
  /** Right-click screen coordinates. `null` keeps the menu closed. */
  position: { x: number; y: number } | null;
  onClose: () => void;
  /** Called after a file or directory is successfully deleted so the parent can refresh. */
  onDeleted?: () => void;
  /** 用户点了「新建文件」/「新建文件夹」。弹窗由父级的 <FsCreateDialog> 负责,
   *  不能放在本组件里 —— 菜单关闭时本组件会被整体卸载。 */
  onRequestCreate?: (target: { type: 'file' | 'dir'; dir: string }) => void;
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

/**
 * 右键节点的**同级父目录**(相对 cwd,POSIX 分隔符;根返回 '')。
 * 「新建」落在这里:在目录上右键 → 建进它自己;在文件上右键 → 建进它旁边。
 *
 * 工具栏「新建」也复用它算「当前点击目录」——点目录落在目录自身,
 * 点文件落在它的父目录(见 FsTab 的 lastPickedDir)。
 */
export function parentDirOf(path: string, kind?: 'file' | 'dir'): string {
  if (kind === 'dir') return path;
  const idx = path.lastIndexOf('/');
  return idx < 0 ? '' : path.slice(0, idx);
}

/**
 * 这个文件名建出来之后**能不能在 zai 里编辑保存**。
 *
 * PUT /fs/file 有 TEXT_EXTS 白名单(见 server/routes/fs.ts),不在表里的
 * 文件能创建、能在树里看到,但点「编辑 → 保存」会拿到
 * 「不允许写入:扩展名 … 不在白名单」。与其建完再吃 400,不如先提示。
 *
 * 注意:这是**警告不是拦截** —— 用户可能只是想建个占位文件,或者打算
 * 自己往里写。dotfile(.gitignore 等)白名单也放行,保持与服务端口径一致。
 */
function isEditableName(name: string): boolean {
  const dot = name.lastIndexOf('.');
  // 无扩展名 / `.` 开头整名当扩展名(`.gitignore`)→ 服务端 isDotfile 放行
  if (dot <= 0) return name.startsWith('.');
  return TEXT_EXTS.has(name.slice(dot).toLowerCase());
}

/** POST /fs/create —— 返回 null 表示失败(已弹 message.error)。 */
async function createEntry(
  dir: string,
  name: string,
  type: 'file' | 'dir',
): Promise<{ path: string; name: string; type: 'file' | 'dir' } | null> {
  const res = await fetch('/api/fs/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir, name, type }),
  });
  const body = (await res.json().catch(() => ({ ok: false, error: 'parse' }))) as {
    ok: boolean;
    error?: string;
    path?: string;
  };
  if (!res.ok || !body.ok) {
    message.error(body.error ?? '新建失败');
    return null;
  }
  return { path: body.path ?? (dir ? `${dir}/${name}` : name), name, type };
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
  const { path, absPath, kind, position, onClose, onDeleted, onRequestCreate } = props;
  // path === '' 表示项目根(工具栏「新建」入口):没有可预览/复制/删除的
  // 具体条目,只保留「新建」两项。
  const isRoot = path === '';

  const handleDelete = () => {
    Modal.confirm({
      title: '确认删除',
      content: (
        <span>
          确定要删除 <strong className="break-all">{path}</strong> 吗？此操作不可撤销。
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

  // 「新建」只负责把意图抛给父级 —— 弹窗由 <FsCreateDialog> 渲染,它挂在
  // FsTab 层级而非菜单内部。菜单一点就随 antd Dropdown 关闭被父级卸载
  // (FsTab 的 `contextMenu && cwd && <FsContextMenu/>`),把弹窗放在这里
  // 会连同 creating 状态一起消失,弹窗从未渲染过(2026-10-11 浏览器实测)。
  const handleCreate = (type: 'file' | 'dir') => {
    onRequestCreate?.({ type, dir: parentDirOf(path, kind) });
    onClose();
  };

  const menuItems = useMemo(() => [
    {
      key: 'create-file',
      'data-testid': 'fs-cm-create-file',
      label: '新建文件',
      onClick: () => handleCreate('file'),
    },
    {
      key: 'create-dir',
      'data-testid': 'fs-cm-create-dir',
      label: '新建文件夹',
      onClick: () => handleCreate('dir'),
    },
    { type: 'divider' as const },
    // 根目录(工具栏「新建」)没有具体条目可操作,到此为止。
    ...(isRoot
      ? []
      : [
    // 「预览」仅对文件展示:调 FilePreviewDrawer(右侧抽屉,复用
    // useAgentStore.filePreviewPath → /api/fs/preview 现成管线)。
    // 目录不进抽屉(/fs/preview 对目录返回 EISDIR),故隐藏该项。
    ...(kind !== 'dir'
      ? [
          {
            key: 'preview',
            'data-testid': 'fs-cm-preview',
            label: '预览',
            onClick: () => {
              useAgentStore.getState().openFilePreview(absPath);
              onClose();
            },
          },
          { type: 'divider' as const },
        ]
      : []),
    {
      key: 'insert',
      'data-testid': 'fs-cm-insert',
      label: '插入对话',
      onClick: () => {
        window.dispatchEvent(
          new CustomEvent<AgentInputInsertDetail>(AGENT_INPUT_INSERT_EVENT, {
            detail: { text: path, ...(kind !== undefined ? { kind } : {}) },
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
        ]),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [path, absPath, kind, isRoot]);

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

// --- FsCreateDialog ------------------------------------------------------

export interface FsCreateDialogProps {
  /** null = 关闭。{type, dir} = 要在这个目录里建这个类型的东西。 */
  target: { type: 'file' | 'dir'; dir: string } | null;
  onClose: () => void;
  onCreated: (created: { path: string; name: string; type: 'file' | 'dir' }) => void;
}

/**
 * 新建条目弹窗。**必须挂在 FsTab 层级,不能放进 FsContextMenu** ——
 * 菜单被 antd Dropdown 关闭时会连带卸载,`target` 状态随之消失,
 * 弹窗连一帧都渲染不出来(2026-10-11 真实浏览器实测:silent fail,
 * 无 JS 报错、MutationObserver 记录 modalEverAppeared=false)。
 */
export function FsCreateDialog(props: FsCreateDialogProps): JSX.Element {
  const { target, onClose, onCreated } = props;
  // 输入值放 ref:受控 Modal 的 content 每次 setState 都会重建,
  // 受控 value 会把光标弹回末尾。ref 让 Input 保持内部状态。
  const nameRef = useRef<string>('');
  // target 切换时清掉上一次的残留名字。
  useEffect(() => {
    nameRef.current = '';
  }, [target]);

  const submit = async () => {
    if (!target) return;
    const name = nameRef.current.trim();
    if (!name) {
      message.warning('名称不能为空');
      return;
    }
    const created = await createEntry(target.dir, name, target.type);
    if (!created) return;
    message.success(target.type === 'dir' ? `已创建文件夹 ${name}` : `已创建文件 ${name}`);
    // 建得了但存不了:提前说清楚,免得用户编辑保存时才撞 400。
    if (target.type === 'file' && !isEditableName(name)) {
      message.warning(`${name} 的扩展名不在可编辑白名单里,可创建但无法在 zai 内编辑保存`);
    }
    onClose();
    onCreated(created);
  };

  return (
    <Modal
      open={target !== null}
      title={target?.type === 'dir' ? '新建文件夹' : '新建文件'}
      okText="创建"
      cancelText="取消"
      okButtonProps={{ 'data-testid': 'fs-create-ok' }}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnHidden
    >
      <Input
        data-testid="fs-create-name-input"
        autoFocus
        defaultValue=""
        placeholder={target?.type === 'dir' ? '文件夹名' : '文件名(如 notes.md)'}
        onChange={(e) => { nameRef.current = e.target.value; }}
        onPressEnter={() => void submit()}
      />
      {target && (
        <p className="mt-2 mb-0 text-xs" style={{ color: 'var(--text-dim-45)' }}>
          将创建于 <span className="font-mono">{target.dir || '项目根目录'}/</span>
        </p>
      )}
    </Modal>
  );
}
