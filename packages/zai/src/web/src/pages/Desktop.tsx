import { useCallback, useEffect, useMemo, useState } from 'react';
import { Popover, Switch, message } from 'antd';
import {
  ArrowLeftOutlined,
  SettingOutlined,
  SunOutlined,
  MoonOutlined,
  PictureOutlined,
  FileOutlined,
  PaperClipOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  RobotFilled,
  FolderFilled,
  PictureFilled,
  CheckSquareFilled,
  CloseCircleFilled,
  EyeFilled,
  MessageOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import NotesIcon from '../components/desktop/NotesIcon.js';
import { useNavigate } from 'react-router-dom';
import AgentConversation from './AgentConversation.js';
import SettingsDrawer from '../components/SettingsDrawer.js';
import { useAppStore } from '../store/useAppStore.js';
import { useAgentStore } from '../store/useAgentStore.js';
import { useLocalStorageState } from '../components/splitPane/shared.js';
import { api } from '../lib/api.js';
import { AGENT_INPUT_INSERT_EVENT } from '../lib/agentInputEvents.js';
import { useEffectiveTheme } from '../hooks/useEffectiveTheme.js';
import { useThemeToggle } from '../hooks/useThemeToggle.js';
import { clampBounds, initWindows, initPreviewWindow, toggleMaximized, type DesktopWindowState } from '../components/desktop/windowMath.js';
import DesktopWindow from '../components/desktop/DesktopWindow.js';
import DesktopExplorer, { type ExplorerEntry } from '../components/desktop/DesktopExplorer.js';
import AttachmentZone, { DND_MIME, parseRefPayload, DEFAULT_MAX } from '../components/desktop/AttachmentZone.js';
import StickyNotes from '../components/desktop/StickyNotes.js';
import TodoPanel from '../components/desktop/TodoPanel.js';
import { gatherMentions } from '../components/desktop/gatherMentions.js';
import { useDesktopAttachmentStore } from '../store/desktopAttachmentStore.js';
import { LS_KEYS, newStickyNote, newTodoItem, type DesktopShortcut, type StickyNote, type TodoItem } from '../components/desktop/desktopStore.js';
import type { DesktopFsFile, DesktopOpen } from '../../../shared/desktopFs.js';
import WallpaperUploadField from '../components/desktop/WallpaperUploadField.js';
import { classifyKind } from '../../../shared/fileKind.js';
import { FilePreviewBody, decodeDataUrlUtf8 } from '../components/desktop/FilePreviewBody.js';

const PRESET_WALLPAPERS = ['preset:aurora', 'preset:ocean', 'preset:sunset'] as const;

const WALLPAPER_PRESET_BG: Record<string, string> = {
  'preset:aurora': 'linear-gradient(135deg,#1a1a2e,#16213e,#0f3460)',
  'preset:ocean': 'linear-gradient(160deg,#0f2027,#203a43,#2c5364)',
  'preset:sunset': 'linear-gradient(135deg,#ff7e5f,#feb47b,#ff9966)',
};

const WALLPAPER_LABEL: Record<string, string> = {
  'preset:aurora': '极光',
  'preset:ocean': '海洋',
  'preset:sunset': '日落',
};

type Preview = { name: string; path: string } | null;

export default function Desktop() {
  const navigate = useNavigate();
  const isMobile = useAppStore((s) => s.isMobile);
  const setWorkMode = useAppStore((s) => s.setWorkMode);
  const openSettingsDrawer = useAppStore((s) => s.openSettingsDrawer);
  const effectiveTheme = useEffectiveTheme();
  const instanceContext = useAppStore((s) => s.instanceContext);
  const cwd = instanceContext?.cwd ?? '';
  // home 由 DesktopExplorer 首 GET /desktop/fs/list 自愈(响应里 res.home),
  // 这里显式传 '' 让"主目录"书签在 explorer 完成首 GET 前对齐到空 → 触发
  // 服务端 home 解析(详见 DesktopExplorer.tsx go(null) 路径)。
  // useAppStore.instanceContext 仅有 cwd/cwdName,没有 home 字段。
  const home = '';

  // 视口
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const onR = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onR);
    return () => window.removeEventListener('resize', onR);
  }, []);

  // 窗口状态(localStorage 持久化;读取后通过 clampBounds 钳制,持久化值破坏时回退)
  const [storedWindows, setStoredWindows] = useLocalStorageState<DesktopWindowState[] | null>(LS_KEYS.windows, null);
  const windows: DesktopWindowState[] = useMemo(() => {
    if (storedWindows && Array.isArray(storedWindows) && storedWindows.length > 0) {
      return storedWindows.map((w) => {
        const clamped = clampBounds(w, vp, w.id);
        return { ...w, ...clamped };
      });
    }
    return initWindows(vp);
  }, [storedWindows, vp]);
  const setWindows = useCallback((next: DesktopWindowState[] | ((prev: DesktopWindowState[]) => DesktopWindowState[])) => {
    setStoredWindows((prev) => {
      const base: DesktopWindowState[] = (() => {
        if (Array.isArray(prev) && prev.length > 0) return prev;
        return initWindows(vp);
      })();
      const updated = typeof next === 'function' ? next(base) : next;
      return updated;
    });
  }, [setStoredWindows, vp]);

  // 预览窗口几何/状态:不持久化,双击文件时创建,关闭时清空。
// 必须在 activeId useMemo 之前声明(后者依赖它参与 z 比较)。
const [previewWindow, setPreviewWindow] = useState<DesktopWindowState | null>(null);

const activeId = useMemo(
    () => {
      // activeId:windows z 最大的那个;previewWindow 不进 windows 数组(临时窗口不持久化),
      // 但 z 同样参与比较 — 双击文件弹出预览时,预览窗口应当成为 active。
      let maxZ = -Infinity;
      let top: DesktopWindowState | null = null;
      for (const w of windows) {
        if (w.z > maxZ) { maxZ = w.z; top = w; }
      }
      if (previewWindow && previewWindow.z > maxZ) top = previewWindow;
      return top?.id ?? 'agent';
    },
    [windows, previewWindow],
  );

  // 附件区(跨组件共享:Desktop 展示/管理,AgentInputBox 发送时自动并入)
  // 附件区保留直到用户手动移除;同路径附件仅自动并入一次(见 store 注释)。
  const refs = useDesktopAttachmentStore((s) => s.refs);
  const onAddRef = useDesktopAttachmentStore((s) => s.addRef);
  const onRemoveRef = useDesktopAttachmentStore((s) => s.removeRef);
  const markAttachmentsMerged = useDesktopAttachmentStore((s) => s.markAllMerged);
  // 附件面板开合(Agent 窗口内的左侧可收缩列)— 默认收起
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  // 会话面板开合(Agent 窗口内的右侧可收缩列)— 默认收起
  const [sessionsOpen, setSessionsOpen] = useState(false);
  // 会话状态与操作复用 useAgentStore(与 /agent 路由 Sider 同一份 store)
  const sessions = useAgentStore((s) => s.sessions);
  const currentSessionId = useAgentStore((s) => s.sessionId);
  const agentStatus = useAgentStore((s) => s.status);
  const loadSessions = useAgentStore((s) => s.loadSessions);
  const setCurrentSession = useAgentStore((s) => s.setCurrentSession);
  const loadTranscript = useAgentStore((s) => s.loadTranscript);
  const createNewSession = useAgentStore((s) => s.createNewSession);
  // 对话进行中(streaming)禁用切换/新建 — 与 /agent Sider 行为一致
  const sessionBusy = agentStatus === 'streaming';

  // 进入桌面时初始化会话列表(与 /agent 页一致:空列表兜底新建一条会话),
  // 否则 agent 窗口会停在无会话空白态。
  useEffect(() => {
    (async () => {
      await loadSessions();
      if (useAgentStore.getState().sessions.length === 0) {
        await useAgentStore.getState().createNewSession();
      }
    })();
  }, [loadSessions]);
  // 快捷方式
  const [shortcuts, setShortcuts] = useLocalStorageState<DesktopShortcut[]>(LS_KEYS.shortcuts, []);
  const [wallpaper, setWallpaper] = useLocalStorageState<string>(LS_KEYS.wallpaper, 'preset:aurora');
  // 便签(localStorage 持久化;依赖 vp/notes 的更新走 setNotes 的函数型 updater 收敛避免陈旧闭包)
  const [notes, setNotes] = useLocalStorageState<StickyNote[]>(LS_KEYS.notes, []);
  // 待办(localStorage 持久化)与面板开合
  const [todos, setTodos] = useLocalStorageState<TodoItem[]>(LS_KEYS.todos, []);
  const [todoOpen, setTodoOpen] = useState(false);

  // 预览浮窗
  const [preview, setPreview] = useState<Preview>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewData, setPreviewData] = useState<
    | { kind: 'text' | 'image' | 'html' | 'binary'; path: string;
        mime?: string; content?: string; dataUrl?: string;
        size: number; mtime: number; ext?: string }
    | { error: string }
    | null
  >(null);

  // 资源管理器定位(快捷方式右键 → 在资源管理器定位)
  const [explorerTarget, setExplorerTarget] = useState<string | undefined>(undefined);

  // 快捷方式右键菜单
  const [ctx, setCtx] = useState<{ path: string; x: number; y: number } | null>(null);

  // 壁纸设置 Popover
  const [wallpaperOpen, setWallpaperOpen] = useState(false);

  // 时钟
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const clockText = useMemo(() => {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }, [now]);

  // ---------- 窗口操作 ----------
  const patchWindow = useCallback(
    (id: string, patch: Partial<DesktopWindowState>) =>
      setWindows((ws) => ws.map((w) => (w.id === id ? { ...w, ...patch } : w))),
    [setWindows],
  );
  const focusWindow = useCallback((id: string) => {
    setWindows((ws) => {
      // max 纳入便签 z;同时把其他窗口 z 降为 0(全局单焦点)。预览 z 也降为 0。
      const noteMax = Math.max(0, ...notes.map((n) => n.z ?? 0));
      const maxZ = Math.max(0, ...ws.map((w) => w.z), previewWindow?.z ?? 0, noteMax) + 1;
      return ws.map((w) => (w.id === id ? { ...w, z: maxZ, minimized: false } : { ...w, z: 0 }));
    });
    // 全局单焦点:便签 z 也要同步降为 0,否则便签 z 仍可能高于新窗口 z(虽然已 max+1 覆盖,
    // 但降级更彻底,避免下次再点便签时 z 累加爆炸)。
    setNotes((ns) => ns.map((n) => ({ ...n, z: 0 })));
    setPreviewWindow((p) => (p ? { ...p, z: 0, minimized: false } : p));
  }, [setWindows, setNotes, setPreviewWindow, previewWindow, notes]);
  const minimize = useCallback(
    (id: string) => {
      setWindows((ws) => {
        const target = ws.find((w) => w.id === id);
        if (!target) return ws;
        return ws.map((w) => (w.id === id ? { ...w, minimized: !w.minimized } : w));
      });
    },
    [setWindows],
  );
  const toggleMax = useCallback(
    (id: string) => setWindows((ws) => ws.map((w) => (w.id === id ? toggleMaximized(w, vp) : w))),
    [setWindows, vp],
  );
  // 关闭核心窗口:从数组中过滤掉,Dock 点击对应图标时由 restoreWindow 重新创建。
  // 持久化跟随 setWindows → 下次进入桌面 initWindows 重建默认布局。
  const closeWindow = useCallback(
    (id: string) => setWindows((ws) => ws.filter((w) => w.id !== id)),
    [setWindows],
  );
  // 重建被关闭的核心窗口(agent/explorer)沿用 initWindows 默认几何,
  // z 拉到当前最大之上确保置顶。preview 是临时窗口不走这条路径。
  const restoreWindow = useCallback(
    (id: 'agent' | 'explorer') => {
      setWindows((ws) => {
        if (ws.some((w) => w.id === id)) return ws;
        const defaults = initWindows(vp);
        const tpl = defaults.find((w) => w.id === id);
        if (!tpl) return ws;
        const maxZ = Math.max(0, ...ws.map((w) => w.z)) + 1;
        return [...ws, { ...tpl, z: maxZ }];
      });
    },
    [setWindows, vp],
  );

  // ---------- 预览窗口操作(临时窗口,不进 windows 数组、不持久化) ----------
  /** onChange:DesktopWindow 拖动 title 移动 / 右下角改大小 → setPreviewWindow({...patch}) */
  const patchPreviewWindow = useCallback(
    (patch: Partial<DesktopWindowState>) =>
      setPreviewWindow((w) => (w ? { ...w, ...patch } : w)),
    [],
  );
  /** onFocus:把 previewWindow 提到所有窗口最上层 — 用户点击预览窗口内部时调用。
   *  同步把所有 windows 的 z 降为 0,确保 preview 的新 maxZ 严格高于 windows,
   *  否则若 windows 此前 max 已经很高,新 preview z = max+1 仍可能被其他窗口追平,
   *  导致 activeId 一直指向 windows 而不是 preview。 */
  const focusPreviewWindow = useCallback(() => {
    setPreviewWindow((w) => {
      if (!w) return w;
      // 全局单焦点:max 纳入 windows + 便签;同时 windows 和 notes z 都降为 0。
      const noteMax = Math.max(0, ...notes.map((n) => n.z ?? 0));
      const maxZ = Math.max(0, ...windows.map((ww) => ww.z), w.z, noteMax) + 1;
      return { ...w, z: maxZ, minimized: false };
    });
    setWindows((ws) => ws.map((w) => ({ ...w, z: 0 })));
    setNotes((ns) => ns.map((n) => ({ ...n, z: 0 })));
  }, [windows, notes, setWindows, setNotes]);
  const minimizePreviewWindow = useCallback(() => {
    setPreviewWindow((w) => (w ? { ...w, minimized: !w.minimized } : w));
  }, []);
  const toggleMaxPreviewWindow = useCallback(() => {
    setPreviewWindow((w) => (w ? toggleMaximized(w, vp) : w));
  }, [vp]);

  // ---------- Office 作用域(进出桌面) ----------
  //
  // 原子性与生命周期不变量(代码评审固化):
  // 1. `await api.get(...)` 是本 effect 唯一的可挂起点。cleanup 把 `cancelled`
  //    置 true 后,下一条微任务判 `if (cancelled) return` 直接退出 —— 不会有
  //    "PUT 已发出但 snapshot 还没写" 的中间态。StrictMode 双挂载
  //    (setup → cleanup → setup)路径下,第一次 setup 因 cancelled 而早退,
  //    只有第二次 setup 完成 GET → snapshot → PUT。
  // 2. GET 解析后的整段(guard 检查 → setWorkMode → setItem → PUT fire)是
  //    同步微任务块,期间不再 `await`,因此 cleanup 无法在中间插入。
  // 3. 幂等重入(磁盘已是 office/office):仍写 snapshot `{workMode:'office',
  //    mainAgent:'office'}`。这是刻意的 —— 退出桌面时 restoreSettings 以
  //    `snap.workMode !== 'office'` / `snap.mainAgent !== 'office'` 为条件
  //    跳过 PUT,所以 office/office 快照是 no-op,clear snapshot 即可。
  //    不要"优化"成"只在实际切换时写快照":外部在桌面打开期间如果用户/其他
  //    标签页改了 ~/.zai/settings.json 的 workMode/mainAgent,持久化保存
  //    此刻进入的快照意味着退出时会把磁盘当下值写回去 —— 这是正确的语义。
  // 4. PUT 是 `void` fire-and-forget,与 snapshot 写在同一同步块内启动;
  //    即使 PUT 失败也不影响 snapshot / setWorkMode,UI 立刻反映。
  function restoreSettings(): void {
    const raw = localStorage.getItem(LS_KEYS.settingsSnapshot);
    if (!raw) return;
    let snap: { workMode?: string; mainAgent?: string };
    try {
      snap = JSON.parse(raw) as { workMode?: string; mainAgent?: string };
    } catch {
      localStorage.removeItem(LS_KEYS.settingsSnapshot);
      return;
    }
    localStorage.removeItem(LS_KEYS.settingsSnapshot);
    if (snap.workMode && snap.workMode !== 'office') {
      void api.put('/agent/settings/work-mode', { workMode: snap.workMode }).catch(() => undefined);
    }
    if (snap.mainAgent && snap.mainAgent !== 'office') {
      void api.put('/agent/settings/main-agent', { mainAgent: snap.mainAgent }).catch(() => undefined);
    }
    if (snap.workMode === 'code' || snap.workMode === 'office' || snap.workMode === 'general') {
      setWorkMode(snap.workMode);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cur = await api
        .get<{ workMode?: string; mainAgent?: string }>('/agent/settings')
        .catch(() => null);
      if (cancelled) return;
      const workMode = cur?.workMode ?? 'code';
      const mainAgent = cur?.mainAgent ?? 'default';
      // 先同步 store + 写 snapshot,PUT 是 fire-and-forget,等下个 tick 自然完成
      if (!cancelled) {
        setWorkMode('office');
        try {
          localStorage.setItem(LS_KEYS.settingsSnapshot, JSON.stringify({ workMode, mainAgent }));
        } catch {
          // quota / privacy mode — swallow
        }
      }
      if (workMode !== 'office') {
        void api.put('/agent/settings/work-mode', { workMode: 'office' }).catch(() => undefined);
      }
      if (mainAgent !== 'office') {
        void api.put('/agent/settings/main-agent', { mainAgent: 'office' }).catch(() => undefined);
      }
    })();
    return () => {
      cancelled = true;
      restoreSettings();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- 移动端重定向 ----------
  useEffect(() => {
    if (isMobile) navigate('/agent', { replace: true });
  }, [isMobile, navigate]);

  // ---------- 附件操作(store 托管,见 desktopAttachmentStore) ----------

  // 窗口级 drop:文件/目录拖到 Agent 窗任意位置(哪怕附件面板收起成窄条)都进附件区
  const handleAgentDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types?.includes(DND_MIME) !== true) return;
    if (refs.length >= DEFAULT_MAX) {
      void message.warning(`附件最多 ${DEFAULT_MAX} 个,请先移除`);
      return;
    }
    const parsed = parseRefPayload(e.dataTransfer.getData(DND_MIME));
    if (parsed) onAddRef(parsed);
  }, [refs.length, onAddRef]);

  // ---------- 发送(附件 → @mention 并入 prompt) ----------
  const insertMentions = useCallback(() => {
    if (refs.length === 0) return;
    const text = gatherMentions(refs, '');
    if (!text) {
      // 手动并入后 markAllMerged 已把附件标记为已并入;但 remove→重拖入会
      // 解除标记,此处再次 mark 保证「手动并入过」状态不再触发自动附带。
      markAttachmentsMerged();
      void message.info('附件已并入,无需重复');
      return;
    }
    window.dispatchEvent(
      new CustomEvent(AGENT_INPUT_INSERT_EVENT, {
        detail: { text: text.trim(), kind: 'file' },
      }),
    );
    // 手动路径已把引用带进输入框,标记全部已并入,发送时不重复自动附带
    markAttachmentsMerged();
    void message.success('文件引用已并入输入框,回车发送');
  }, [refs, markAttachmentsMerged]);

  // ---------- 资源管理器 → 桌面 拖拽(附件区 + 快捷方式) ----------
  const onDragFile = useCallback((entry: ExplorerEntry) => {
    // 给 AttachmentZone parseRefPayload 看到当前 entry — 不必记 state,AttachmentZone
    // 自行解析 drag payload。
    void entry;
  }, []);

  // ---------- 预览浮窗 ----------
  // 数据流:/api/desktop/fs/file 返回 base64 dataUrl(mime 已隐含在 dataUrl 前缀) +
  // 服务端白名单(toMime)保证 desktopFs 只接受 text/image 类扩展。前端按
  // shared/fileKind.classifyKind(path) 把扩展名归类为 text/image/html/binary,
  // 然后用 FilePreviewBody 渲染(MD/代码高亮/图片/iframe/binary fallback)。
  useEffect(() => {
    if (!preview) {
      setPreviewData(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    api
      .get<DesktopFsFile>(`/desktop/fs/file?path=${encodeURIComponent(preview.path)}`)
      .then((r) => {
        if (cancelled) return;
        if (!r.ok || !r.dataUrl) {
          const errMsg = r.error ?? '读取失败';
          setPreviewData({ error: errMsg });
          void message.error(errMsg);
          return;
        }
        const kind = classifyKind(preview.path);
        const meta = { size: 0, mtime: 0 }; // desktopFs 不返回 size/mtime,前端展示从简
        if (kind === 'image') {
          setPreviewData({
            kind: 'image', path: preview.path,
            mime: r.mime, dataUrl: r.dataUrl,
            ...meta,
          });
        } else if (kind === 'html') {
          // desktopFs 的 TEXT_EXTS 抽 HTML_EXTS 出来后,服务端 toMime 返回
          // 'text/html',dataUrl 是 base64(text/html;...) → 直接交给 iframe src=。
          setPreviewData({
            kind: 'html', path: preview.path,
            mime: r.mime ?? 'text/html', dataUrl: r.dataUrl,
            ...meta,
          });
        } else if (kind === 'text') {
          // mime 是 text/plain,dataUrl 是 base64(text/plain;...);还原 utf-8 后
          // 交给 FilePreviewBody,内部按 path 扩展名走 MarkdownText / CodeBlock。
          const utf8 = decodeDataUrlUtf8(r.dataUrl);
          setPreviewData({
            kind: 'text', path: preview.path,
            mime: r.mime ?? 'text/plain', content: utf8,
            ...meta,
          });
        } else {
          // binary — desktopFs 白名单未命中时不会到这里(toMime 直接 400),这里仅兜底。
          const ext = preview.path.toLowerCase().split('.').pop() ?? '';
          setPreviewData({
            kind: 'binary', path: preview.path,
            ext: ext ? `.${ext}` : undefined,
            ...meta,
          });
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const err = e instanceof Error ? e.message : '读取文件失败';
        setPreviewData({ error: err });
        void message.error(err);
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [preview]);

  const systemOpen = useCallback((entry: ExplorerEntry) => {
    api
      .post<DesktopOpen>('/desktop/open', { path: entry.path })
      .then((o) => {
        if (o.ok) void message.success(`已用系统默认应用打开: ${entry.name}`);
        else void message.error(o.error ?? '系统打开失败');
      })
      .catch((e: unknown) => void message.error(e instanceof Error ? e.message : '系统打开失败'));
  }, []);

  const openPreview = useCallback((entry: ExplorerEntry) => {
    if (entry.kind === 'dir') return;
    if (entry.preview) {
      // z 比当前所有窗口(包括 preview 自己)最大 z 还高 — 弹出预览即聚焦
      const maxExisting = Math.max(0, ...windows.map((w) => w.z), previewWindow?.z ?? 0);
      setPreview({ name: entry.name, path: entry.path });
      setPreviewWindow(initPreviewWindow(vp, entry.name, maxExisting + 1));
      return;
    }
    systemOpen(entry);
  }, [systemOpen, windows, previewWindow, vp]);
  const closePreview = useCallback(() => {
    setPreview(null);
    setPreviewWindow(null);
  }, []);

  // ---------- 壁纸层 ----------
  // wallpaper 取值三态:
  //   'preset:<name>'        → 内置渐变
  //   '/api/desktop/...'     → 用户上传后服务端返回的 URL(图片落 ~/.zai/desktop/wallpapers/)
  //   其它(历史 'data:...' )  → 旧版本把图片 base64 写进了 localStorage;体积可达数 MB,
  //                             易撞 quota 且拖慢读图,启动时迁移为默认预设。
  const wallpaperBg = useMemo(() => {
    if (wallpaper.startsWith('preset:')) {
      return WALLPAPER_PRESET_BG[wallpaper] ?? WALLPAPER_PRESET_BG['preset:aurora']!;
    }
    return `center/cover url(${wallpaper})`;
  }, [wallpaper]);

  // 历史 dataURL 壁纸一次性迁移(只在挂载时跑一次)
  useEffect(() => {
    if (wallpaper.startsWith('data:')) setWallpaper('preset:aurora');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 上传成功后只持久化服务端返回的 URL(图片文件在 ~/.zai/desktop/wallpapers/)。
  // 回调身份要稳定:setWallpaper 来自 useLocalStorageState 的 useCallback,本身稳定。
  const onWallpaperUploaded = useCallback((url: string) => setWallpaper(url), [setWallpaper]);

  // ---------- 快捷方式 ----------
  const handleIconDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const raw = e.dataTransfer.getData(DND_MIME);
      if (!raw) return;
      const parsed = parseRefPayload(raw);
      if (!parsed) return;
      setShortcuts((prev) => {
        if (prev.some((s) => s.id === parsed.id)) return prev;
        const sc: DesktopShortcut = { id: parsed.id, name: parsed.name, path: parsed.path, kind: parsed.kind };
        return [...prev, sc];
      });
    },
    [setShortcuts],
  );
  const removeShortcut = useCallback((path: string) => {
    setShortcuts((prev) => prev.filter((s) => s.path !== path));
    setCtx(null);
  }, [setShortcuts]);

  const locateInExplorer = useCallback((path: string) => {
    setExplorerTarget(path);
    setCtx(null);
  }, []);

  // 关闭右键菜单(全局 click)
  useEffect(() => {
    if (!ctx) return;
    const close = () => setCtx(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [ctx]);

  // ---------- Dock 操作 ----------
  // 新建便签(Dock「便签」):出生位置避让现有窗口(含 minimized 过滤), 避免被窗口层盖住不可交互
  const addNote = useCallback(() => {
    setNotes((ns) => [...ns, newStickyNote(vp, ns.length, windows)]);
  }, [setNotes, vp, windows]);
  // 便签聚焦:全局单焦点语义 — 把目标便签 z 拉到当前 max + 1,
  // 同时把其他窗口和预览窗口的 z 降为 0(失去焦点)。
  // 这样保证桌面任何时刻只有一个元素是 active,聚焦切换不会"叠加"。
  const focusStickyNote = useCallback((id: string) => {
    const maxZ = Math.max(
      0,
      ...windows.map((w) => w.z),
      ...notes.map((n) => n.z ?? 0),
      previewWindow?.z ?? 0,
    );
    setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, z: maxZ + 1 } : { ...n, z: 0 })));
    setWindows((ws) => ws.map((w) => ({ ...w, z: 0 })));
    setPreviewWindow((p) => (p ? { ...p, z: 0 } : p));
  }, [setNotes, setWindows, setPreviewWindow, windows, notes, previewWindow]);

  const dockClick = useCallback(
    (id: 'agent' | 'explorer' | 'wallpaper' | 'notes' | 'todo' | 'preview' | 'exit') => {
      if (id === 'exit') {
        navigate('/agent');
        return;
      }
      if (id === 'wallpaper') {
        setWallpaperOpen((v) => !v);
        return;
      }
      if (id === 'notes') {
        addNote();
        return;
      }
      if (id === 'preview') {
        // 已聚焦 → 关闭(预览窗口是临时窗口,无最小化概念,再点 dock = 关闭);
        // 否则 → 聚焦。
        if (!previewWindow) return;
        if (activeId === 'preview') closePreview();
        else focusPreviewWindow();
        return;
      }
      if (id === 'todo') {
        setTodoOpen((v) => !v);
        return;
      }
      const target = id;
      const found = windows.find((w) => w.id === target);
      if (!found) {
        // 窗口被关闭 → 重建(Dock 提供恢复入口,保证"关了还能再开")
        if (target === 'agent' || target === 'explorer') restoreWindow(target);
        return;
      }
      if (found.minimized) {
        focusWindow(target);
      } else if (activeId === target) {
        minimize(target);
      } else {
        focusWindow(target);
      }
    },
    [activeId, addNote, closePreview, focusPreviewWindow, focusWindow, minimize, navigate, previewWindow, restoreWindow, windows],
  );

  const isLight = effectiveTheme === 'light' || effectiveTheme === 'high-contrast';
  // 走与 SettingsDrawer / Layout 顶栏 Switch 完全一致的主题切换路径 ——
  // 见 packages/zai/src/web/src/hooks/useThemeToggle.ts (store + PUT 写盘)
  const toggleTheme = useThemeToggle();
  const handleToggleTheme = (checked: boolean) => {
    toggleTheme(checked ? 'light' : 'dark');
  };

  return (
    <div
      data-testid="desktop-root"
      style={{
        position: 'fixed',
        inset: 0,
        overflow: 'hidden',
        background: wallpaperBg,
        color: 'var(--text-primary, #eaeaea)',
        userSelect: 'none',
      }}
    >
      {/* 图标区(壁纸与窗口之间) */}
      <div
        data-testid="desktop-icons"
        onDragOver={(e) => {
          if (e.dataTransfer.types?.includes(DND_MIME)) e.preventDefault();
        }}
        onDrop={handleIconDrop}
        style={{
          position: 'absolute',
          left: 24,
          top: 56,
          bottom: 88,
          right: 'auto',
          width: 220,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, 84px)',
          gridAutoRows: '92px',
          gap: 6,
          alignContent: 'start',
          zIndex: 1,
        }}
      >
        {shortcuts.map((sc) => (
          <div
            key={sc.id}
            data-testid={`shortcut-${sc.name}`}
            onDoubleClick={() => {
              if (sc.kind === 'dir') {
                setExplorerTarget(sc.path);
                focusWindow('explorer');
              } else {
                // 桌面快捷方式双击:复用 openPreview 逻辑(创建预览窗口 + 聚焦)
                openPreview({ name: sc.name, path: sc.path, kind: 'file', size: 0, mtime: 0, preview: true });
                focusWindow('agent');
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtx({ path: sc.path, x: e.clientX, y: e.clientY });
            }}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 4,
              padding: 8,
              borderRadius: 8,
              cursor: 'pointer',
            }}
            title={sc.path}
          >
            {sc.kind === 'dir' ? (
              <FolderOutlined style={{ fontSize: 36, color: '#facc15' }} />
            ) : (
              <FileOutlined style={{ fontSize: 32, color: 'var(--desktop-icon-color, rgba(255,255,255,.85))' }} />
            )}
            <span
              style={{
                fontSize: 12,
                color: 'var(--desktop-label-color, rgba(255,255,255,.95))',
                textShadow: 'var(--desktop-label-shadow, 0 1px 3px rgba(0,0,0,.7))',
                textAlign: 'center',
                wordBreak: 'break-all',
                maxWidth: '100%',
              }}
            >
              {sc.name}
            </span>
          </div>
        ))}
      </div>

      {/* 便签层(壁纸层之上、图标区与窗口区之间的独立 zIndex 层) */}
      <StickyNotes
        notes={notes}
        onChange={(id, patch) => setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, ...patch } : n)))}
        onDelete={(id) => setNotes((ns) => ns.filter((n) => n.id !== id))}
        onFocus={focusStickyNote}
        viewport={vp}
      />

      {/* 窗口区(仅定位上下文:不可命中, 窗口自身 section 拦截点击;
          否则全屏容器会盖住其下方的便签层/图标区, 便签拖不动也点不到) */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none' }}>
        {windows.map((w) => (
          <DesktopWindow
            key={w.id}
            win={w}
            active={w.id === activeId}
            viewport={vp}
            onFocus={() => focusWindow(w.id)}
            onMinimize={() => minimize(w.id)}
            onToggleMax={() => toggleMax(w.id)}
            onClose={() => closeWindow(w.id)}
            onChange={(patch) => patchWindow(w.id, patch)}
            titleExtra={w.id === 'agent' ? (
              // 标题栏快捷新建:不用先展开右侧会话栏即可开新会话
              <button
                type="button"
                onClick={() => void createNewSession()}
                disabled={sessionBusy}
                aria-label="标题栏新建会话"
                data-testid="desktop-title-new-session"
                title={sessionBusy ? '对话进行中,请等待当前回复结束' : '新建会话'}
                style={{
                  border: 0,
                  background: 'transparent',
                  color: 'var(--text-secondary, #aaa)',
                  cursor: sessionBusy ? 'not-allowed' : 'pointer',
                  padding: '2px 6px',
                  borderRadius: 4,
                  display: 'inline-flex',
                  alignItems: 'center',
                  opacity: sessionBusy ? 0.5 : 1,
                }}
              >
                <PlusOutlined style={{ fontSize: 12 }} />
              </button>
            ) : undefined}
          >
            {w.id === 'agent' ? (
              <div
                style={{ display: 'flex', height: '100%' }}
                onDragOver={(e) => { if (e.dataTransfer.types?.includes(DND_MIME)) e.preventDefault(); }}
                onDrop={handleAgentDrop}
              >
                {attachmentsOpen ? (
                  <div
                    data-testid="agent-attachments-panel"
                    style={{
                      width: 220,
                      flexShrink: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      borderRight: '1px solid var(--border-subtle, rgba(128,128,128,.25))',
                      background: 'rgba(128,128,128,.04)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px 2px 10px' }}>
                      <span style={{ fontSize: 12, color: 'var(--text-secondary, #aaa)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <PaperClipOutlined style={{ fontSize: 12 }} /> 附件
                      </span>
                      <button
                        type="button"
                        onClick={() => setAttachmentsOpen(false)}
                        aria-label="收起附件区"
                        style={{ border: 0, background: 'transparent', color: 'var(--text-secondary, #aaa)', cursor: 'pointer', padding: 2, borderRadius: 4 }}
                      >
                        <MenuFoldOutlined style={{ fontSize: 11 }} />
                      </button>
                    </div>
                    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                      <AttachmentZone refs={refs} onAddRef={onAddRef} onRemoveRef={onRemoveRef} />
                    </div>
                    <div style={{ padding: 6 }}>
                      <button
                        type="button"
                        onClick={insertMentions}
                        disabled={refs.length === 0}
                        aria-label="并入输入框"
                        style={{
                          width: '100%',
                          border: '1px solid var(--border-subtle, rgba(128,128,128,.4))',
                          borderRadius: 6,
                          background: 'transparent',
                          color: 'var(--text-secondary, #aaa)',
                          cursor: refs.length === 0 ? 'not-allowed' : 'pointer',
                          padding: '4px 0',
                          fontSize: 12,
                        }}
                      >
                        并入输入框
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setAttachmentsOpen(true)}
                    aria-label="展开附件区"
                    data-testid="agent-attachments-collapsed"
                    style={{
                      width: 28,
                      flexShrink: 0,
                      border: 0,
                      borderRight: '1px solid var(--border-subtle, rgba(128,128,128,.25))',
                      background: 'rgba(128,128,128,.04)',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 4,
                      color: 'var(--text-secondary, #aaa)',
                    }}
                  >
                    <PaperClipOutlined style={{ fontSize: 13 }} />
                    <span style={{ writingMode: 'vertical-rl', fontSize: 10 }}>附件</span>
                  </button>
                )}
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <AgentConversation />
                </div>
                {sessionsOpen ? (
                  <div
                    data-testid="agent-sessions-panel"
                    style={{
                      width: 220,
                      flexShrink: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      borderLeft: '1px solid var(--border-subtle, rgba(128,128,128,.25))',
                      background: 'rgba(128,128,128,.04)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px 2px 10px' }}>
                      <span style={{ fontSize: 12, color: 'var(--text-secondary, #aaa)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <MessageOutlined style={{ fontSize: 12 }} /> 会话
                      </span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                        <button
                          type="button"
                          onClick={() => void createNewSession()}
                          disabled={sessionBusy}
                          aria-label="新建会话"
                          data-testid="desktop-new-session"
                          title={sessionBusy ? '对话进行中,请等待当前回复结束' : '新建会话'}
                          style={{
                            border: 0,
                            background: 'transparent',
                            color: 'var(--text-secondary, #aaa)',
                            cursor: sessionBusy ? 'not-allowed' : 'pointer',
                            padding: 2,
                            borderRadius: 4,
                            opacity: sessionBusy ? 0.5 : 1,
                          }}
                        >
                          <PlusOutlined style={{ fontSize: 11 }} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setSessionsOpen(false)}
                          aria-label="收起会话栏"
                          style={{ border: 0, background: 'transparent', color: 'var(--text-secondary, #aaa)', cursor: 'pointer', padding: 2, borderRadius: 4 }}
                        >
                          <MenuUnfoldOutlined style={{ fontSize: 11 }} />
                        </button>
                      </span>
                    </div>
                    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 6px' }}>
                      {sessions.length === 0 ? (
                        <div style={{ fontSize: 12, color: 'var(--text-secondary, #aaa)', padding: '8px 4px' }}>
                          暂无历史会话
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          {sessions.map((s) => {
                            const active = s.sessionId === currentSessionId;
                            return (
                              <div
                                key={s.sessionId}
                                data-testid={`desktop-session-${s.sessionId}`}
                                title={sessionBusy ? '对话进行中,请等待当前回复结束' : undefined}
                                onClick={() => {
                                  if (sessionBusy || active) return;
                                  setCurrentSession(s.sessionId);
                                  void loadTranscript(s.sessionId);
                                }}
                                style={{
                                  cursor: sessionBusy ? 'not-allowed' : 'pointer',
                                  padding: '6px 8px',
                                  borderRadius: 6,
                                  background: active ? 'rgba(255,102,0,0.10)' : 'transparent',
                                  opacity: sessionBusy ? 0.6 : 1,
                                }}
                              >
                                <div
                                  style={{
                                    fontSize: 13,
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    color: active ? '#ff6600' : 'var(--text-primary, #eaeaea)',
                                  }}
                                >
                                  {s.title || '新会话'}
                                </div>
                                <div style={{ fontSize: 11, color: 'var(--text-secondary, #aaa)' }}>
                                  {new Date(s.updatedAt).toLocaleString()}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setSessionsOpen(true)}
                    aria-label="展开会话栏"
                    data-testid="agent-sessions-collapsed"
                    style={{
                      width: 28,
                      flexShrink: 0,
                      border: 0,
                      borderLeft: '1px solid var(--border-subtle, rgba(128,128,128,.25))',
                      background: 'rgba(128,128,128,.04)',
                      cursor: 'pointer',
                      position: 'relative',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 4,
                      color: 'var(--text-secondary, #aaa)',
                    }}
                  >
                    <MessageOutlined style={{ fontSize: 13 }} />
                    <span style={{ writingMode: 'vertical-rl', fontSize: 10 }}>会话</span>
                    {currentSessionId && (
                      <span
                        aria-hidden
                        title="当前会话"
                        style={{
                          position: 'absolute',
                          top: 6,
                          right: 5,
                          width: 5,
                          height: 5,
                          borderRadius: '50%',
                          background: 'var(--accent-start, #ff6600)',
                        }}
                      />
                    )}
                  </button>
                )}
              </div>
            ) : (
              <DesktopExplorer
                key={`explorer-${explorerTarget ?? 'default'}`}
                cwd={cwd}
                home={home}
                defaultPath={explorerTarget}
                onOpenFile={openPreview}
                onDragFile={onDragFile}
              />
            )}
          </DesktopWindow>
        ))}
      </div>

      {/* 待办面板(顶栏之下、Dock 之上;zIndex 80 介于窗口层 2 与顶栏 100 之间) */}
      {todoOpen && (
        <TodoPanel
          todos={todos}
          onAdd={(text) => setTodos((ts) => [...ts, newTodoItem(text)])}
          onToggle={(id) => setTodos((ts) => ts.map((t) => (t.id === id ? { ...t, done: !t.done } : t)))}
          onDelete={(id) => setTodos((ts) => ts.filter((t) => t.id !== id))}
          onClose={() => setTodoOpen(false)}
        />
      )}

      {/* 预览窗口 — 用 DesktopWindow 实例化,自动获得拖动改大小/位置、最小化、最大化、
          z 提升等窗口能力。几何由 initPreviewWindow 给定:居中 + 2/3 桌面尺寸。 */}
      {previewWindow && preview && (
        <DesktopWindow
          win={previewWindow}
          active={activeId === 'preview'}
          viewport={vp}
          onFocus={focusPreviewWindow}
          onMinimize={minimizePreviewWindow}
          onToggleMax={toggleMaxPreviewWindow}
          onClose={closePreview}
          onChange={patchPreviewWindow}
        >
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '4px 10px',
                borderBottom: '1px solid var(--border-subtle, rgba(128,128,128,.25))',
                fontSize: 12,
                color: 'var(--text-secondary, #aaa)',
                gap: 8,
                flexShrink: 0,
              }}
            >
              <PictureOutlined />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={preview.path}>
                {preview.path}
              </span>
              <button
                type="button"
                onClick={closePreview}
                aria-label="关闭预览"
                style={{ border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: '0 4px' }}
              >
                ×
              </button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 8, display: 'flex', alignItems: 'stretch', justifyContent: 'center' }}>
              {previewLoading ? (
                <span style={{ color: 'var(--text-secondary, #aaa)', alignSelf: 'center' }}>加载中…</span>
              ) : previewData == null ? (
                <span style={{ color: 'var(--text-secondary, #aaa)', alignSelf: 'center' }}>无内容</span>
              ) : 'error' in previewData ? (
                <span style={{ color: 'var(--error, #ff7875)', alignSelf: 'center' }}>{previewData.error}</span>
              ) : (
                <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
                  <FilePreviewBody payload={previewData} />
                </div>
              )}
            </div>
          </div>
        </DesktopWindow>
      )}

      {/* 右键菜单 */}
      {ctx && (
        <div
          data-testid="shortcut-context-menu"
          style={{
            position: 'fixed',
            left: ctx.x,
            top: ctx.y,
            zIndex: 10000,
            background: 'var(--bg-elevated, #1c1c26)',
            border: '1px solid var(--border-subtle, rgba(128,128,128,.3))',
            borderRadius: 6,
            boxShadow: '0 6px 20px rgba(0,0,0,.4)',
            padding: '4px 0',
            minWidth: 140,
          }}
        >
          <button
            type="button"
            onClick={() => locateInExplorer(ctx.path)}
            style={ctxMenuBtn}
          >
            在资源管理器定位
          </button>
          <button
            type="button"
            onClick={() => removeShortcut(ctx.path)}
            style={ctxMenuBtn}
          >
            移除
          </button>
        </div>
      )}

      {/* 顶栏 */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 32,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 10px',
          background: 'var(--desktop-chrome-bg, rgba(0,0,0,.35))',
          backdropFilter: 'blur(8px)',
          zIndex: 100,
          color: 'var(--text-primary, #eaeaea)',
          fontSize: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            type="button"
            onClick={() => navigate('/agent')}
            aria-label="退出桌面"
            style={{
              border: 0,
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 6px',
              borderRadius: 4,
            }}
          >
            <ArrowLeftOutlined /> 退出桌面
          </button>
          <span aria-label="时钟" data-testid="desktop-clock" style={{ fontFamily: 'ui-monospace, monospace' }}>
            {clockText}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Switch
            size="small"
            checked={isLight}
            onChange={handleToggleTheme}
            checkedChildren={<SunOutlined />}
            unCheckedChildren={<MoonOutlined />}
            aria-label="切换主题"
          />
          <Popover
            trigger="click"
            open={wallpaperOpen}
            onOpenChange={setWallpaperOpen}
            placement="bottomRight"
            content={
              <div style={{ width: 220 }}>
                <div style={{ marginBottom: 6, fontSize: 12 }}>预设</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                  {PRESET_WALLPAPERS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => {
                        setWallpaper(p);
                        setWallpaperOpen(false);
                      }}
                      style={{
                        border: wallpaper === p ? '2px solid var(--accent-start, #ff6600)' : '1px solid rgba(128,128,128,.3)',
                        borderRadius: 6,
                        height: 36,
                        background: WALLPAPER_PRESET_BG[p],
                        color: '#fff',
                        cursor: 'pointer',
                        fontSize: 12,
                      }}
                    >
                      {WALLPAPER_LABEL[p] ?? p}
                    </button>
                  ))}
                </div>
                <div style={{ marginBottom: 6, fontSize: 12 }}>上传图片</div>
                {/* onUploaded 身份稳定 → 该子树在壁纸 state 更新时不会收到新 props,
                    避免 React commitUpdate 回写 file input value 抛 InvalidStateError
                    (见 WallpaperUploadField 头注) */}
                <WallpaperUploadField onUploaded={onWallpaperUploaded} />
              </div>
            }
          >
            <button
              type="button"
              aria-label="壁纸设置"
              style={{ border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: '2px 6px', borderRadius: 4 }}
            >
              <PictureOutlined /> 壁纸
            </button>
          </Popover>
          <button
            type="button"
            onClick={openSettingsDrawer}
            aria-label="设置"
            style={{ border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: '2px 6px', borderRadius: 4 }}
          >
            <SettingOutlined />
          </button>
        </div>
      </div>

      {/* Dock */}
      <div
        data-testid="desktop-dock"
        style={{
          position: 'absolute',
          left: '50%',
          bottom: 12,
          transform: 'translateX(-50%)',
          display: 'flex',
          gap: 10,
          padding: '8px 14px',
          borderRadius: 18,
          background: 'var(--desktop-chrome-bg-strong, rgba(0,0,0,.22))',
          backdropFilter: 'blur(18px) saturate(1.4)',
          zIndex: 100,
        }}
      >
        <DockButton label="Agent" active={activeId === 'agent'} onClick={() => dockClick('agent')} icon={<RobotFilled />} color="var(--accent-start, #ff6600)" />
        <DockButton label="资源管理器" active={activeId === 'explorer'} onClick={() => dockClick('explorer')} icon={<FolderFilled />} color="#faad14" />
        {/* 预览按钮:仅在预览窗口存在时显示;点聚焦/再点关闭(预览是临时窗口无最小化) */}
        {previewWindow && preview && (
          <DockButton
            label="预览"
            active={activeId === 'preview'}
            onClick={() => dockClick('preview')}
            icon={<EyeFilled />}
            color="#1677ff"
          />
        )}
        <DockButton label="壁纸设置" active={false} onClick={() => dockClick('wallpaper')} icon={<PictureFilled />} color="#13c2c2" />
        <DockButton label="便签" active={false} onClick={() => dockClick('notes')} icon={<NotesIcon />} color="#faad14" />
        <DockButton label="待办" active={todoOpen} onClick={() => dockClick('todo')} icon={<CheckSquareFilled />} color="#52c41a" />
        <DockButton label="退出桌面" active={false} onClick={() => dockClick('exit')} icon={<CloseCircleFilled />} color="#ff4d4f" />
      </div>

      {/* 全局 SettingsDrawer — 顶层 mount 让任意路由(/desktop 等)都能唤起 */}
      <SettingsDrawer />
    </div>
  );
}

const ctxMenuBtn: React.CSSProperties = {
  display: 'block',
  width: '100%',
  border: 0,
  background: 'transparent',
  color: 'inherit',
  textAlign: 'left',
  padding: '6px 12px',
  fontSize: 12,
  cursor: 'pointer',
};

function DockButton({ label, active, onClick, icon, color }: { label: string; active: boolean; onClick: () => void; icon: React.ReactNode; color: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      data-testid={`dock-${label}`}
      style={{
        position: 'relative',
        border: 0,
        background: 'transparent',
        color: 'var(--text-primary, #eaeaea)',
        cursor: 'pointer',
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 2,
        padding: '6px 10px',
        borderRadius: 8,
        transition: 'transform 120ms',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.transform = 'scale(1.15)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.transform = 'scale(1)';
      }}
    >
      <span style={{ fontSize: 18, lineHeight: 1, color }}>
        {icon}
      </span>
      <span style={{ fontSize: 11 }}>{label}</span>
      {active && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            top: 0,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 4,
            height: 4,
            borderRadius: '50%',
            background: 'var(--accent-start, #ff6600)',
          }}
        />
      )}
    </button>
  );
}
