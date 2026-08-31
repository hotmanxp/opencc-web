import { useCallback, useEffect, useState } from 'react';
import { Input, Tabs, Alert, Empty, Spin, Segmented } from 'antd';
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

// 起始目录切换键:工作目录 (process.cwd, 服务端 instanceContext.cwd)
// vs 用户主目录 (~, 服务端 /desktop/fs/list 响应里的 res.home).
// 持久化到 localStorage,关闭重开桌面仍记住上次选择.
const START_ROOT_KEY = 'zai:desktop:explorer:startRoot';
type StartRoot = 'cwd' | 'home';

function readStartRoot(): StartRoot {
  try {
    return localStorage.getItem(START_ROOT_KEY) === 'home' ? 'home' : 'cwd';
  } catch {
    return 'cwd';
  }
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
  // currentPath 只在 defaultPath (快捷方式双击定位) 时显式初始化;否则交给下面
  // 的 effect 在 cwd hydrate 后再决定起点 — 避免首挂载时 cwd='' (instanceContext
  // 还在等 /system 异步返回) 把 currentPath 锁死成 null → 服务端兜底解析 home,
  // 之后 cwd 真值回来也无法再触发导航.
  const [currentPath, setCurrentPath] = useState<string | null>(defaultPath ?? null);
  const [homePath, setHomePath] = useState(home || '');
  const [entries, setEntries] = useState<ExplorerEntry[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'local' | 'online'>('local');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // 起始目录:工作目录 (cwd) vs 用户主目录 (home),持久化到 localStorage
  const [startRoot, setStartRoot] = useState<StartRoot>(readStartRoot);

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

  // 起始目录解析(单一 effect,state-driven):
  //   - defaultPath (定位模式,快捷方式"在资源管理器定位") → 走 defaultPath
  //   - startRoot='cwd' 且 cwd 已 hydrate → go(cwd)
  //   - startRoot='home' → go(null) 让服务端兜底解析 ~ (自愈 homePath)
  //   - 兜底 → go(null) (用户首次进入且 cwd 还没 hydrate 时,不要一直空白,
  //     让服务端先把 home 列出来,等 cwd hydrate 进来 race effect 再覆盖)
  // cwd race 由 effect 的 [cwd] deps 自然处理:instanceContext.cwd 从 '' 变
  // 成真值时 effect 重跑,触发 go(cwd) 跳到工作目录.
  // 不再用 `currentPath != null` 守卫 — 那个守卫会让"用户手动导航过 / 当前
  // 在子目录、切回工作目录"被吞掉 (currentPath 已非 null 时不再覆盖).
  useEffect(() => {
    if (defaultPath) {
      void go(defaultPath);
      return;
    }
    if (startRoot === 'cwd' && cwd) {
      void go(cwd);
      return;
    }
    if (startRoot === 'home') {
      void go(homePath || null);
      return;
    }
    // cwd 还没 hydrate (startRoot='cwd' && cwd=''):兜底列 home,避免空白闪烁
    void go(null);
  }, [defaultPath, startRoot, cwd, homePath, go]);
  // 起始目录切换持久化
  useEffect(() => {
    try {
      localStorage.setItem(START_ROOT_KEY, startRoot);
    } catch {
      /* quota / privacy mode — swallow */
    }
  }, [startRoot]);

  const openEntry = (e: ExplorerEntry) =>
    e.kind === 'dir' ? void go(e.path) : onOpenFile(e);

  const startDrag = (e: React.DragEvent, entry: ExplorerEntry) => {
    onDragFile(entry);
    e.dataTransfer.setData('application/x-zai-file', JSON.stringify({ path: entry.path, name: entry.name, kind: entry.kind }));
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Tabs size="small" activeKey={tab} onChange={(k) => setTab(k as 'local' | 'online')} style={{ paddingLeft: 20 }} items={[
        { key: 'local', label: '本地文件' },
        { key: 'online', label: '线上知识' },
      ]} />
      {tab === 'online' ? (
        <Empty description="线上知识 · 待接入" style={{ marginTop: 64 }} />
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
          <div style={{ padding: '0 20px 6px' }}>
            <Segmented
              size="small"
              value={startRoot}
              onChange={(v) => setStartRoot(v as StartRoot)}
              options={[
                { label: '工作目录', value: 'cwd' },
                { label: '用户目录', value: 'home' },
              ]}
            />
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
