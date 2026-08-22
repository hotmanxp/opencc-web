import { describe, it, expect } from 'vitest';
import { DSH_VERSION, DSH_BRIDGE_VERSION, DSH_KERNEL, OPENCC_KERNEL } from '../src/index.js';

describe('dsh-bridge skeleton', () => {
  it('DSH_VERSION 与 dsh 包锁定版本一致', () => {
    expect(DSH_VERSION).toBe('0.1.0-rc.7');
    expect(DSH_BRIDGE_VERSION).toMatch(/^0\./);
  });

  it('kernel id 常量与计划 §4.1 一致', () => {
    expect(DSH_KERNEL).toBe('dsh');
    expect(OPENCC_KERNEL).toBe('opencc');
  });
});