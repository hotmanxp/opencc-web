import { create } from 'zustand';
import type { ServerEvent } from '../../../shared/events.js';
import type { OutputStyle } from '../../../shared/settings.js';

export type ServiceState = {
  phase: 'restarting';
  reason: 'user_action' | 'auto_recovery' | 'update';
  deadlineMs: number;
} | null;

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
  // host/port/ips 由后续 LAN-share 阶段注入;字段可选以保证 Layout / 测试
  // 等已有调用方 (只传 cwd/cwdName/branch) 仍能 typecheck.
  // isManagedChild/supervisorPid/instanceId 由 Layout 从 GET /api/system
  // hydrate 进来,SettingsDrawer 用 isManagedChild 条件渲染重启/关闭按钮,
  // Layout 用它决定"实例管理"菜单是否显示。
  instanceContext: {
    cwd: string;
    cwdName: string;
    branch: string | null;
    host?: string;
    port?: number;
    ips?: string[];
    isManagedChild?: boolean;
    supervisorPid?: number | null;
    instanceId?: string | null;
  } | null;
  setConnected: (v: boolean) => void;
  setInstanceContext: (ctx: {
    cwd: string;
    cwdName: string;
    branch: string | null;
    host?: string;
    port?: number;
    ips?: string[];
    isManagedChild?: boolean;
    supervisorPid?: number | null;
    instanceId?: string | null;
  }) => void;
  applyJobEvent: (event: ServerEvent) => void;
  applySystemEvent: (event: ServerEvent) => void;
  dismissToast: (id: string) => void;
  // Settings Drawer 入口状态:右端工具栏的 [⚙] 按钮触发,Agent.tsx 顶层监听渲染.
  // 首期仅 frontend toggle;后续阶段 2 再接 PUT 写盘.
  settingsDrawerOpen: boolean;
  /**
   * Web UI 主题偏好 — 持久化到 ~/.zai/settings.json(settings.theme).
   * Layout mount 时一次性 GET /api/agent/settings hydrate;SettingsDrawer 切主题
   * 时同步 PUT settings.json,失败 swallow(下次启动仍可重写).
   *
   * 默认 'dark';'auto' / 'high-contrast' 由 useEffectiveTheme() 解析为跟随系统
   * prefers-color-scheme,见 packages/zai/src/web/src/hooks/useEffectiveTheme.ts.
   *
   * 与 opencc 上游 ThemeSetting 字段名对齐 (opencc/src/utils/theme.ts:111).
   */
  settingsTheme: 'auto' | 'dark' | 'light' | 'high-contrast';
  openSettingsDrawer: () => void;
  closeSettingsDrawer: () => void;
  pluginModalOpen: boolean;
  openPluginModal: () => void;
  closePluginModal: () => void;
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
  /**
   * 主对话区最大渲染消息条数. 超过时 UI 折叠早期消息,顶部浮按钮一键还原.
   * 默认 20. Layout mount effect 用 GET /api/agent/settings 覆写.
   */
  maxVisibleMessages: number;
  setMaxVisibleMessages: (n: number) => void;
  /**
   * 桌面端打开 Agent 页面时是否默认启动右侧分屏. 持久化到
   * ~/.zai/settings.json(settings.defaultSplitScreen),Layout mount effect
   * 用 GET /api/agent/settings hydrate. 仅在 localStorage 无显式覆盖时生效,
   * SplitPane / Agent.tsx 在 first-run seed effect 里用它作为 localStorage
   * 缺失时的种子值 — 用户手动 toggle 的选择永远胜出.
   */
  defaultSplitScreen: boolean;
  setDefaultSplitScreen: (v: boolean) => void;
  /**
   * 是否启用动态工作流 (WorkflowTool — 多 agent 编排工具).
   * 持久化到 ~/.zai/settings.json(settings.enableDynamicWorkflow),
   * Layout mount effect 用 GET /api/agent/settings hydrate.
   *
   * 默认 false — 工作流一次会起几十个 sub-agent 烧大量 token,必须由
   * 用户在 SettingsDrawer 主动打开才暴露给 LLM。关闭时 vendor 的
   * `isWorkflowsDisabled()` 返回 true,WorkflowTool 从工具池里被过滤掉,
   * LLM 完全看不到这个工具 — 不只是"调用被拒绝",而是 schema 都不发。
   * 开启时 PUT handler 同步写 `process.env.OPENCC_ENABLE_WORKFLOWS=1`,
   * 下次 query() 触发的 getAllBaseTools() 调用就会把 WorkflowTool
   * 重新纳入。中途切换不需要重启。
   */
  enableDynamicWorkflow: boolean;
  setEnableDynamicWorkflow: (v: boolean) => void;
  /**
   * 是否移动端视口. 由 `useIsMobile()` hook 通过 matchMedia 维护, 任何组件
   * 直接读 store 即可, 无需 props 透传. 路由层 Layout/MobileLayout 也用
   * 这个值决定走哪一套布局 (Sider + SettingsDrawer vs. MobileHeader).
   */
  isMobile: boolean;
  setIsMobile: (v: boolean) => void;
  /**
   * MobileAgent「常用指令」Drawer 的开关. AgentInputBox 状态栏的 [⚡] 按钮
   * 置 true, MobileQuickDrawer 的 onClose 置 false. 仅 isMobile 时需要,
   * 桌面端不挂载触发按钮也不读这个字段.
   */
  quickDrawerOpen: boolean;
  setQuickDrawerOpen: (open: boolean) => void;
  serviceState: ServiceState;
  setServiceState: (s: ServiceState) => void;
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
  pluginModalOpen: false,
  settingsTheme: 'dark',
  // Default before the GET /api/agent/settings fetch resolves; the
  // Layout mount effect re-hydrates this from disk on first paint so
  // cold-load reflects the user's persisted choice without a flash.
  outputStyle: 'default',
  maxVisibleMessages: 20,
  defaultSplitScreen: false,
  enableDynamicWorkflow: false,
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
    if (event.type === 'system.restarting') {
      return {
        ...state,
        serviceState: {
          phase: 'restarting',
          reason: event.reason,
          deadlineMs: event.deadlineMs,
        },
      };
    }
    if (event.type === 'system.restart.canceled') {
      return { ...state, serviceState: null };
    }
    return state;
  }),
  dismissToast: (id) => set((state) => ({
    ...state,
    toasts: state.toasts.filter((t) => t.id !== id),
  })),
  openSettingsDrawer: () => set({ settingsDrawerOpen: true }),
  closeSettingsDrawer: () => set({ settingsDrawerOpen: false }),
  openPluginModal: () => set({ pluginModalOpen: true }),
  closePluginModal: () => set({ pluginModalOpen: false }),
  setSettingsTheme: (t) => set({ settingsTheme: t }),
  setOutputStyle: (style) => set({ outputStyle: style }),
  setMaxVisibleMessages: (n) => set({ maxVisibleMessages: n }),
  setDefaultSplitScreen: (v) => set({ defaultSplitScreen: v }),
  setEnableDynamicWorkflow: (v) => set({ enableDynamicWorkflow: v }),
  isMobile: false,
  setIsMobile: (v) => set({ isMobile: v }),
  quickDrawerOpen: false,
  setQuickDrawerOpen: (open) => set({ quickDrawerOpen: open }),
  serviceState: null,
  setServiceState: (s) => set({ serviceState: s }),
  // NOTE: openSettingsDrawer / closeSettingsDrawer / setSettingsTheme
  // 三个 action 必须保留(SPEC 阶段 1 4-store field requirement)。
  // 若有并行 rebase 误删,SettingsButton.test.tsx 会以
  // `expected false to be true` 失败,需立即按 commit 27efed5 的 pattern 还原。
  // 2026-07-20 task-restore-openSettingsDrawer 已验证三条 action 都在,
  // test/web/SettingsButton.test.tsx 2/2 pass,test/web/ 整体 28 files / 209 tests pass。
}));
