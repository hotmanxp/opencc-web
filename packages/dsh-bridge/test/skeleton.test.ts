import { describe, it, expect } from 'vitest';
import { DSH_VERSION, DSH_BRIDGE_VERSION, createDshRuntime, NotImplementedError } from '../src/index.js';

describe('dsh-bridge skeleton', () => {
  it('DSH_VERSION 与 dsh 包锁定版本一致', () => {
    expect(DSH_VERSION).toBe('0.1.0-rc.7');
    expect(DSH_BRIDGE_VERSION).toMatch(/^0\./);
  });

  it('createDshRuntime 抛 NotImplementedError（B0 预期失败）', async () => {
    await expect(
      createDshRuntime({
        dataDir: '/tmp/x',
        runtimeId: 'rt-1',
        defaultCwd: '/tmp',
        defaultModel: 'MiniMax-M3',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('NotImplementedError 含修复指引文本', () => {
    const err = new NotImplementedError('foo');
    expect(err.message).toMatch(/未实现|B0/);
    expect(err.message).toMatch(/dsh-kernel-main-plan|kernel/);
  });
});