export interface WindowBounds { x: number; y: number; w: number; h: number }
export interface DesktopWindowState extends WindowBounds {
  id: 'agent' | 'explorer' | 'preview'; title: string; z: number;
  minimized: boolean; maximized: boolean;
}
export const MIN_W = 320, MIN_H = 200, AGENT_MIN_W = 560, AGENT_MIN_H = 420;
/** 顶栏(退出桌面/时钟/壁纸)高度 — 最大化时窗口从顶栏之下开始, 避免标题栏被遮挡无法还原 */
export const TOPBAR_H = 32;
/** Dock 区高度预留 — 最大化时不与底部 Dock(z 100 浮层)重叠 */
export const DOCK_GUARD = 80;

const minFor = (id: 'agent' | 'explorer' | 'preview') =>
  id === 'agent' ? { w: AGENT_MIN_W, h: AGENT_MIN_H } : { w: MIN_W, h: MIN_H };

export function clampBounds(b: WindowBounds, vp: { w: number; h: number }, id: 'agent' | 'explorer' | 'preview'): WindowBounds {
  const mn = minFor(id);
  const w = Math.min(vp.w, Math.max(mn.w, Math.round(b.w)));
  const h = Math.min(vp.h, Math.max(mn.h, Math.round(b.h)));
  const x = Math.min(Math.max(0, Math.round(b.x)), Math.max(0, vp.w - 60)); // 标题栏至少留 60px 可抓
  const y = Math.min(Math.max(0, Math.round(b.y)), Math.max(0, vp.h - 40));
  return { x, y, w, h };
}

export function initWindows(vp: { w: number; h: number }): DesktopWindowState[] {
  const hh = Math.round(vp.h * 0.6);
  return [
    { id: 'explorer', title: '资源管理器', x: 24, y: 24, w: 420, h: hh, z: 1, minimized: false, maximized: false },
    { id: 'agent', title: 'Agent · Office', x: Math.round(vp.w * 0.4), y: 24, w: Math.max(AGENT_MIN_W, vp.w - Math.round(vp.w * 0.4) - 24), h: hh, z: 2, minimized: false, maximized: false },
  ];
}

/**
 * 预览窗口初始几何:居中 + 大小 = 桌面尺寸的 2/3。
 * 不持久化(每次双击新建临时窗口,关闭即丢)。
 */
export function initPreviewWindow(
  vp: { w: number; h: number },
  title: string,
  z: number,
): DesktopWindowState {
  const w = Math.round(vp.w * (2 / 3));
  const h = Math.round(vp.h * (2 / 3));
  // 居中:y 从顶栏之下开始,避免标题栏被遮
  const x = Math.round((vp.w - w) / 2);
  const y = TOPBAR_H + Math.round((vp.h - TOPBAR_H - DOCK_GUARD - h) / 2);
  return { id: 'preview', title, x, y, w, h, z, minimized: false, maximized: false };
}

export function toggleMaximized(w: DesktopWindowState, _vp: { w: number; h: number }): DesktopWindowState {
  return { ...w, maximized: !w.maximized };
}

/** 最大化几何:铺满 顶栏之下到 Dock 之上的可用区, 标题栏保持可见可操作(双击/还原按钮皆可退出) */
export function maximizedBounds(vp: { w: number; h: number }): WindowBounds {
  return { x: 0, y: TOPBAR_H, w: vp.w, h: Math.max(MIN_H, vp.h - TOPBAR_H - DOCK_GUARD) };
}
