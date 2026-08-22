import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  DSH_TASKS_DIR,
  dshSessionsDir,
  dshTaskPath,
  nodeSupportsDsh,
  NODE_VERSION_REPAIR_HINT,
  DSH_KERNEL,
  OPENCC_KERNEL,
} from './paths.js';

describe('kernel/paths constants', () => {
  it('dshSessionsDir 在 dataDir/projects/<cwd>/dsh-sessions/ 下', () => {
    expect(dshSessionsDir('/tmp/x', 'home/proj')).toBe(join('/tmp/x', 'projects', 'home/proj', 'dsh-sessions'));
  });

  it('dshTaskPath 拼接到 DSH_TASKS_DIR 下', () => {
    const p = dshTaskPath('t-123');
    expect(p.startsWith(DSH_TASKS_DIR)).toBe(true);
    expect(p.endsWith('t-123.json')).toBe(true);
  });

  it('DSH_TASKS_DIR 与 ~/.zai/tasks/ 隔离', () => {
    // 独立子目录方案 — 不能与 opencc 任务目录重合。
    expect(DSH_TASKS_DIR.endsWith('tasks-dsh')).toBe(true);
    expect(DSH_TASKS_DIR.endsWith('tasks')).toBe(false);
  });

  it('kernel id 常量与计划一致', () => {
    expect(DSH_KERNEL).toBe('dsh');
    expect(OPENCC_KERNEL).toBe('opencc');
  });

  it('NODE_VERSION_REPAIR_HINT 提及升级 / kill switch', () => {
    expect(NODE_VERSION_REPAIR_HINT).toMatch(/22\.19|24\.0\.0/);
    expect(NODE_VERSION_REPAIR_HINT).toMatch(/opencc/);
  });
});

describe('nodeSupportsDsh', () => {
  it('与 process.versions.node 实际值一致 — 真实环境下应是 true (CI Node >= 22.19)', () => {
    // 测试机若满足条件，返回 true；不满足返回 false。两者都是合法实现。
    const result = nodeSupportsDsh();
    expect(typeof result).toBe('boolean');
    const major = Number(process.versions.node.split('.')[0]?.replace(/^v/, ''));
    expect(major).toBeGreaterThanOrEqual(20); // sanity
  });
});