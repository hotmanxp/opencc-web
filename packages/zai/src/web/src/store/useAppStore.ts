import { create } from 'zustand';
import type { ServerEvent } from '../../../shared/events.js';

const getInitialSidebarCollapsed = () =>
  typeof localStorage !== 'undefined'
    ? localStorage.getItem('zai-sidebar-collapsed') === 'true'
    : true

interface JobInfo {
  jobId: string;
  kind: 'resource_refresh' | 'login' | 'install' | 'agent_task';
  progress?: number;
  message?: string;
  done?: boolean;
  error?: string;
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
  setConnected: (v) => set({ connected: v }),
  setInstanceContext: (ctx) => set({ instanceContext: ctx }),
  applyJobEvent: (event) => set((state) => {
    if (!('jobId' in event) || typeof event.jobId !== 'string') return state;
    const jid = event.jobId;
    switch (event.type) {
      case 'job.started': {
        const jobs = { ...state.jobs };
        jobs[jid] = { jobId: jid, kind: event.kind };
        return { ...state, jobs };
      }
      case 'job.progress': {
        const existing = state.jobs[jid];
        if (!existing) return state;
        return {
          ...state,
          jobs: { ...state.jobs, [jid]: { ...existing, message: event.message, progress: event.percent } },
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
          jobs: { ...state.jobs, [jid]: { ...existing, done: true, progress: 100 } },
        };
      }
      case 'job.failed': {
        const existing = state.jobs[jid];
        if (!existing) return state;
        return {
          ...state,
          jobs: { ...state.jobs, [jid]: { ...existing, error: event.error } },
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
}));
