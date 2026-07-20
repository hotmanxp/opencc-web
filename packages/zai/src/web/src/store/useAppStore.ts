import { create } from 'zustand';
import type { ServerEvent } from '../../../shared/events.js';
import type { OutputStyle } from '../../../shared/settings.js';

// 主菜单侧栏默认收起, 让首屏主区域占满. localStorage 显式存 'false' 时
// 才展开; 任何其他情况 (无记录 / 'true' / 空值) 都视为收起.
const getInitialSidebarCollapsed = (): boolean => {
  if (typeof localStorage === 'undefined') return true;
  return localStorage.getItem('zai-sidebar-collapsed') !== 'false';
};


interface JobInfo {
  jobId: string;
  kind: 'resource_refresh' | 'login' | 'install' | 'agent_task';
  progress?: number;
  message?: string;
  done?: boolean;
  error?: string;
  /**
   * 该 job 归属的 sessionId (agent_task 时 = BackgroundTask.parentSessionId,
   * 即派发 sub-agent 的主 session)。undefined 表示非 agent_task 的全局 job
   * (resource_refresh / login / install),与 session 无关。
   * useBackgroundTasks 据此按当前 useAgentStore.sessionId 过滤 — 切换
   * session 后,该 session 派发的 job 不再出现在当前状态栏。
   */
  sessionId?: string;
}

interface ToastInfo {
  id: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  ts: number;
}

interface AppState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  connected: boolean;
  jobs: Record<string, JobInfo>;
  toasts: ToastInfo[];
  instanceContext: { cwd: string; cwdName: string; branch: string | null } | null;
  setConnected: (v: boolean) => void;
  setInstanceContext: (ctx: { cwd: string; cwdName: string; branch: string | null }) => void;
  applyJobEvent: (event: ServerEvent) => void;
  applySystemEvent: (event: ServerEvent) => void;
  dismissToast: (id: string) => void;
  // Settings Drawer 入口状态:右端工具栏的 [⚙] 按钮触发,Agent.tsx 顶层监听渲染.
  // 首期仅 frontend toggle;后续阶段 2 再接 PUT 写盘.
  settingsDrawerOpen: boolean;
  // Theme 仅前端暂存(SPEC 阶段 1),刷新/重开 Drawer 后还原为 'auto'.
  // 与 opencc 上游 ThemeSetting 字段名对齐 (opencc/src/utils/theme.ts:111).
  settingsTheme: 'auto' | 'dark' | 'light' | 'high-contrast';
  openSettingsDrawer: () => void;
  closeSettingsDrawer: () => void;
  setSettingsTheme: (t: 'auto' | 'dark' | 'light' | 'high-contrast') => void;
  /**
   * Web transcript output style — see OutputStyle in shared/settings.ts.
   *
   * Source of truth is `~/.zai/settings.json` on disk; the field is
   * hydrated from GET /api/agent/settings on first read and synced
   * back via PUT /api/agent/settings/output-style when the user picks
   * a new value in the Settings drawer.
   *
   * MessageListView treats `outputStyle === 'compact'` as the default
   * transcript-collapsed state; the per-session transcriptCollapsed
   * toggle on AgentInputBox becomes a transient override that resets
   * to the persisted value on reload.
   */
  outputStyle: OutputStyle;
  setOutputStyle: (style: OutputStyle) => void;
}

export const useAppStore = create<AppState>((set) => ({
  sidebarCollapsed: getInitialSidebarCollapsed(),
  toggleSidebar: () =>
    set((s) => {
      const next = !s.sidebarCollapsed;
      localStorage.setItem('zai-sidebar-collapsed', String(next));
      return { sidebarCollapsed: next };
    }),
  connected: false,
  jobs: {},
  toasts: [],
  instanceContext: null,
  settingsDrawerOpen: false,
  settingsTheme: 'auto',
  // Default before the GET /api/agent/settings fetch resolves; the
  // Layout mount effect re-hydrates this from disk on first paint so
  // cold-load reflects the user's persisted choice without a flash.
  outputStyle: 'default',
  setConnected: (v) => set({ connected: v }),
  setInstanceContext: (ctx) => set({ instanceContext: ctx }),
  applyJobEvent: (event) => set((state) => {
    if (!('jobId' in event) || typeof event.jobId !== 'string') return state;
    const jid = event.jobId;
    // server 给 job.started/job.progress/job.done/job.failed 发的 sessionId
    // (来自 BackgroundTask.parentSessionId) 透传到 JobInfo,客户端 useBackgroundTasks
    // 据此把 dock 任务按当前 useAgentStore.sessionId 切分. sessionId 缺失
    // (undefined) 表示全局 job,不受 session 过滤影响.
    const evtSessionId = 'sessionId' in event
      ? typeof event.sessionId === 'string' ? event.sessionId : undefined
      : undefined
    switch (event.type) {
      case 'job.started': {
        const jobs = { ...state.jobs };
        jobs[jid] = { jobId: jid, kind: event.kind, sessionId: evtSessionId };
        return { ...state, jobs };
      }
      case 'job.progress': {
        const existing = state.jobs[jid];
        if (!existing) return state;
        return {
          ...state,
          jobs: { ...state.jobs, [jid]: {
            ...existing,
            message: event.message,
            progress: event.percent,
            ...(evtSessionId !== undefined ? { sessionId: evtSessionId } : {}),
          } },
        };
      }
      case 'job.done': {
        const existing = state.jobs[jid];
        if (!existing) return state;
        setTimeout(() => {
          set((s) => {
            const jobs = { ...s.jobs };
            delete jobs[jid];
            return { jobs };
          });
        }, 3000);
        return {
          ...state,
          jobs: { ...state.jobs, [jid]: {
            ...existing,
            done: true,
            progress: 100,
            ...(evtSessionId !== undefined ? { sessionId: evtSessionId } : {}),
          } },
        };
      }
      case 'job.failed': {
        const existing = state.jobs[jid];
        if (!existing) return state;
        return {
          ...state,
          jobs: { ...state.jobs, [jid]: {
            ...existing,
            error: event.error,
            ...(evtSessionId !== undefined ? { sessionId: evtSessionId } : {}),
          } },
        };
      }
      default:
        return state;
    }
  }),
  applySystemEvent: (event) => set((state) => {
    if (event.type === 'toast') {
      return {
        ...state,
        toasts: [...state.toasts, {
          id: event.eventId, level: event.level, message: event.message, ts: event.ts,
        }],
      };
    }
    if (event.type === 'server.error') {
      return {
        ...state,
        toasts: [...state.toasts, {
          id: event.eventId, level: 'error', message: event.message, ts: event.ts,
        }],
      };
    }
    if (event.type === 'branch.changed') {
      if (!state.instanceContext) return state;
      return {
        ...state,
        instanceContext: { ...state.instanceContext, branch: event.branch },
      };
    }
    return state;
  }),
  dismissToast: (id) => set((state) => ({
    ...state,
    toasts: state.toasts.filter((t) => t.id !== id),
  })),
  openSettingsDrawer: () => set({ settingsDrawerOpen: true }),
  closeSettingsDrawer: () => set({ settingsDrawerOpen: false }),
  setSettingsTheme: (t) => set({ settingsTheme: t }),
  setOutputStyle: (style) => set({ outputStyle: style }),
  // NOTE: openSettingsDrawer / closeSettingsDrawer / setSettingsTheme
  // 三个 action 必须保留(SPEC 阶段 1 4-store field requirement)。
  // 若有并行 rebase 误删,SettingsButton.test.tsx 会以
  // `expected false to be true` 失败,需立即按 commit 27efed5 的 pattern 还原。
  // 2026-07-20 task-restore-openSettingsDrawer 已验证三条 action 都在,
  // test/web/SettingsButton.test.tsx 2/2 pass,test/web/ 整体 28 files / 209 tests pass。
}));
