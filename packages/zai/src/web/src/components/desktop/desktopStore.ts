import type { FileRef } from './gatherMentions.js';
import { TOPBAR_H, DOCK_GUARD } from './windowMath.js';

export interface DesktopShortcut { id: string; name: string; path: string; kind: 'file' | 'dir' }

export interface StickyNote { id: string; text: string; x: number; y: number; color: string; w?: number; h?: number; z?: number }

export interface TodoItem { id: string; text: string; done: boolean }

export const STICKY_COLORS = ['#ffd75e', '#c3e88d', '#9fd8ff', '#ff9e9e'] as const;

export const LS_KEYS = {
  windows: 'zai.desktop.windows',
  shortcuts: 'zai.desktop.shortcuts',
  wallpaper: 'zai.desktop.wallpaper',
  settingsSnapshot: 'zai.desktop.settings.snapshot',
  notes: 'zai.desktop.notes',
  todos: 'zai.desktop.todos',
} as const;

/** 从路径生成稳定 id(附件/快捷方式复用),key 用路径而非名(同名不同目录可区分) */
export function validRefFromPath(name: string, path: string, kind: 'file' | 'dir'): FileRef {
  return { id: `r-${path}`, path, name, kind };
}

/** 新建便签(默认 160x120 卡片, id = `n-${Date.now()}-${counter}` 前端唯一)。
 *
 * 出生位置避让现有窗口(obstacles):便签层 z=1 低于窗口层 z≥2,若与窗口重叠
 * 会被盖住,拖不动也点不到 textarea。先试"窗口默认区域下方的空白带"(顶栏之下、
 * Dock 之上,级联向右下偏移),与窗口重叠则整屏网格扫描首个不重叠位置 —— 保证
 * 新便签出生即可见可交互(窗口被用户拖到便签上仍可盖住,类 macOS 语义)。 */
export function newStickyNote(
  viewport: { w: number; h: number },
  count: number,
  obstacles: Array<{ x: number; y: number; w: number; h: number; minimized?: boolean }> = [],
): StickyNote {
  const W = 160, H = 120, HEADER = 26;
  const visible = obstacles.filter((o) => !o.minimized);
  const overlapOf = (x: number, y: number) =>
    visible.some((o) => x < o.x + o.w && o.x < x + W && y < o.y + o.h && o.y < y + H + HEADER);
  const maxY = Math.max(TOPBAR_H + 8, viewport.h - H - HEADER - DOCK_GUARD);
  const bornAt = (x: number, y: number): StickyNote => {
    const id = `n-${Date.now()}-${count}`;
    return { id, text: '', x, y, color: STICKY_COLORS[count % STICKY_COLORS.length]! };
  };
  // 1) 优先:窗口默认区域下方的空白带,级联向右下偏移(常用布局下位置稳定)
  const baseX = Math.max(8, Math.round(viewport.w * 0.3));
  const baseY = Math.max(TOPBAR_H + 8, Math.round(viewport.h * 0.68));
  const offset = count * 24;
  const prefX = Math.min(baseX + offset, viewport.w - W - 8);
  const prefY = Math.min(baseY + offset, maxY);
  if (!overlapOf(prefX, prefY)) return bornAt(prefX, prefY);
  // 2) 兜底:整屏网格扫描首个不重叠位置(处理用户拖过窗口的任意布局)
  for (let y = TOPBAR_H + 8; y + H + HEADER <= viewport.h - DOCK_GUARD; y += 24) {
    for (let x = 8; x + W <= viewport.w - 8; x += 170) {
      if (!overlapOf(x, y)) return bornAt(x, y);
    }
  }
  // 3) 全屏无空位(极端):回退首选点
  return bornAt(prefX, prefY);
}

let todoCounter = 0;

/** 新建待办(text 已 trim;id = `t-${Date.now()}-${counter}` 模块级递增保证同毫秒内唯一) */
export function newTodoItem(text: string): TodoItem {
  todoCounter += 1;
  return { id: `t-${Date.now()}-${todoCounter}`, text: text.trim(), done: false };
}
