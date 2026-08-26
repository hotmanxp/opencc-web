import { describe, expect, test } from 'vitest';
import { clampBounds, initWindows, toggleMaximized, AGENT_MIN_W } from './windowMath.js';

const V = { w: 1200, h: 800 };

describe('windowMath', () => {
  test('clampBounds 钳制尺寸不小于最小', () => {
    expect(clampBounds({ x: 0, y: 0, w: 100, h: 100 }, V, 'explorer').w).toBeGreaterThanOrEqual(320);
  });
  test('agent 最小宽 560', () => {
    expect(clampBounds({ x: 0, y: 0, w: 100, h: 100 }, V, 'agent').w).toBe(AGENT_MIN_W);
  });
  test('initWindows 两窗错开、z 递增', () => {
    const ws = initWindows(V);
    expect(ws.map((w) => w.id)).toEqual(['explorer', 'agent']);
    expect(ws[0]!.z).toBeLessThan(ws[1]!.z);
    expect(ws[0]!.x).toBeLessThan(ws[1]!.x);
  });
  test('toggleMaximized 翻转布尔', () => {
    const w = initWindows(V)[0]!;
    expect(toggleMaximized(w, V).maximized).toBe(true);
    expect(toggleMaximized({ ...w, maximized: true }, V).maximized).toBe(false);
  });
});
