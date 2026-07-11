import { create } from 'zustand';

interface AppState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  sidebarCollapsed: localStorage.getItem('zai-sidebar-collapsed') === 'true',
  toggleSidebar: () =>
    set((s) => {
      const next = !s.sidebarCollapsed;
      localStorage.setItem('zai-sidebar-collapsed', String(next));
      return { sidebarCollapsed: next };
    }),
}));
