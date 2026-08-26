import { useCallback, useEffect, useState } from 'react';
import { Input, Tabs, Alert, Empty, Spin } from 'antd';
import { ArrowUpOutlined } from '@ant-design/icons';
import { api } from '../../lib/api.js';
import type { DesktopFsList, DesktopFsEntry } from '../../../shared/desktopFs.js';
import { DirIcon, FileIcon } from '../splitPane/fileIcon.js';

export interface ExplorerEntry {
  name: string; kind: 'file' | 'dir'; path: string; size: number; mtime: number;
  /** 服务端白名单命中 → 双击走预览浮窗;否则调系统默认应用打开 */
  preview?: boolean;
}
interface DesktopExplorerProps {
  cwd: string;
  home: string;
  onOpenFile: (entry: ExplorerEntry) => void;
  onDragFile: (entry: ExplorerEntry) => void;
  defaultPath?: string;
}

async function loadList(path: string | null): Promise<DesktopFsList> {
  const q = path == null ? '' : `?path=${encodeURIComponent(path)}`;
  try {
    return await api.get<DesktopFsList>(`/desktop/fs/list${q}`);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export default function DesktopExplorer({ cwd, home, onOpenFile, onDragFile, defaultPath }: DesktopExplorerProps) {
  const [pathInput, setPathInput] = useState('');
  const [currentPath, setCurrentPath] = useState<string | null>(defaultPath ?? null);
  const [homePath, setHomePath] = useState(home || '');
  const [entries, setEntries] = useState<ExplorerEntry[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'local' | 'online'>('local');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const go = useCallback(async (path: string | null) => {
    setLoading(true); setError(null);
    const res = await loadList(path);
    setLoading(false);
    if (!res.ok) {
      if (res.error) setError(res.error);
      return; // 保持现有 entries
    }
    setCurrentPath(res.path ?? null);
    if (res.home) setHomePath(res.home);
    setParent(res.parent ?? null);
    setEntries((res.entries ?? []).map((e: DesktopFsEntry) => ({
      name: e.name, kind: e.kind,
      path: e.path,
      size: e.size, mtime: e.mtime,
      preview: e.preview,
    })));
    setSelectedPath(null);
  }, []);

  useEffect(() => { void go(currentPath ?? null); }, []); // 首挂载一次

  const openEntry = (e: ExplorerEntry) =>
    e.kind === 'dir' ? void go(e.path) : onOpenFile(e);

  const startDrag = (e: React.DragEvent, entry: ExplorerEntry) => {
    onDragFile(entry);
    e.dataTransfer.setData('application/x-zai-file', JSON.stringify({ path: entry.path, name: entry.name, kind: entry.kind }));
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Tabs size="small" activeKey={tab} onChange={(k) => setTab(k as 'local' | 'online')} items={[
        { key: 'local', label: '本地' },
        { key: 'online', label: '线上' },
      ]} />
      {tab === 'online' ? (
        <Empty description="线上资源 · 待接入" style={{ marginTop: 64 }} />
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px 6px' }}>
            <Input size="small" value={pathInput} placeholder={currentPath ?? homePath}
              onChange={(e) => setPathInput(e.target.value)}
              onPressEnter={() => void go(pathInput.trim() || null)} style={{ flex: 1 }} />
            <button aria-label="上级" title="上级目录" onClick={() => parent && void go(parent)}
              disabled={!parent} style={{ border: 0, background: 'transparent', cursor: parent ? 'pointer' : 'not-allowed' }}>
              <ArrowUpOutlined />
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, padding: '0 8px 6px', fontSize: 12 }}>
            <button aria-label="书签-主目录" onClick={() => void go(homePath)} style={{ border: 0, background: 'transparent', cursor: 'pointer' }}>主目录</button>
            {cwd && <button aria-label="书签-当前项目" onClick={() => void go(cwd)} style={{ border: 0, background: 'transparent', cursor: 'pointer' }}>当前项目</button>}
          </div>
          {error ? (
            <Alert type="error" message={error} showIcon style={{ margin: 8 }} />
          ) : loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spin size="small" /></div>
          ) : (
            <div style={{ flex: 1, overflow: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))', gap: 8, padding: 8, alignContent: 'start' }}>
              {entries.map((e) => (
                <div key={e.path}
                  onClick={() => setSelectedPath(e.path)}
                  onDoubleClick={() => openEntry(e)}
                  draggable // 文件与目录都可拖到附件区/桌面(路径引用, startDrag 已带 kind)
                  onDragStart={(ev) => startDrag(ev, e)}
                  data-testid={`entry-${e.name}`}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: 8, borderRadius: 8, cursor: 'pointer', background: selectedPath === e.path ? 'rgba(255,102,0,.12)' : 'transparent' }}>
                  {e.kind === 'dir' ? <DirIcon name={e.name} open={false} size={30} /> : <FileIcon name={e.name} size={30} />}
                  <span style={{ fontSize: 11, textAlign: 'center', wordBreak: 'break-all', maxWidth: '100%' }} title={e.name}>{e.name}</span>
                </div>
              ))}
              {entries.length === 0 && <Empty description="空目录" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
            </div>
          )}
        </>
      )}
    </div>
  );
}
