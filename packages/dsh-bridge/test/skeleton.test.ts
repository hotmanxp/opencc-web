import { describe, it, expect } from 'vitest';
import { DSH_VERSION, DSH_BRIDGE_VERSION, DSH_KERNEL, OPENCC_KERNEL } from '../src/index.js';
import {
  dshSessionsRootAbs,
  dshSessionsRoot,
  projectKeyForCwd,
  decodeSegment,
} from '../src/sessions/store.js';

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

describe('Phase 1.1: dsh-sessions root path helpers', () => {
  it('dshSessionsRootAbs 返回绝对路径，与 opencc jsonl 隔离', () => {
    const root = dshSessionsRootAbs('/Users/x/.zai')
    expect(root.endsWith('/dsh-sessions')).toBe(true)
    expect(root.startsWith('/')).toBe(true)
  });

  it('dshSessionsRootAbs 接受相对路径并 resolve 为绝对', () => {
    const root = dshSessionsRootAbs('relative/path')
    expect(root.startsWith('/')).toBe(true)
  });

  it('projectKeyForCwd 把 cwd 编码为 path-safe 片段（与 dsh-side projectKey 一致）', () => {
    expect(projectKeyForCwd('/tmp/dsh-final')).toBe('--tmp-dsh-final--')
    expect(projectKeyForCwd('/Users/x/y')).toBe('--Users-x-y--')
    expect(projectKeyForCwd('plain')).toBe('--plain--')
  });

  it('projectKeyForCwd 合并连续分隔符', () => {
    expect(projectKeyForCwd('//tmp//dsh')).toBe('--tmp-dsh--')
    expect(projectKeyForCwd('a\\b:c')).toBe('--a-b-c--')
  });

  it('projectKeyForCwd 对非安全字符做 ~XXXX 转义', () => {
    // 空格 → ~0020
    expect(projectKeyForCwd('hello world')).toBe('--hello~0020world--')
    // 中文 → 多字节 UTF-16 code unit 各转义
    expect(projectKeyForCwd('中文')).toBe('--~4E2D~6587--')
  });

  it('projectKeyForCwd 抛错当 cwd 为空', () => {
    expect(() => projectKeyForCwd('')).toThrow(/empty/)
  });

  it('decodeSegment 反向解码 ~XXXX 转义', () => {
    expect(decodeSegment('~0020')).toBe(' ')
    expect(decodeSegment('~4E2D')).toBe('中')
  });

  it('decodeSegment 保留 safe 字符原样', () => {
    expect(decodeSegment('plain')).toBe('plain')
    expect(decodeSegment('sess-1234567-abc')).toBe('sess-1234567-abc')
  });

  it('decodeSegment 解码 . 与 .. 特例', () => {
    expect(decodeSegment('~002E')).toBe('.')
    expect(decodeSegment('~002E~002E')).toBe('..')
  });

  it('dshSessionsRoot（deprecated）= dshSessionsRootAbs + projectKeyForCwd', () => {
    const cwd = '/tmp/dsh-final'
    const root = dshSessionsRootAbs('/Users/x/.zai')
    expect(dshSessionsRoot('/Users/x/.zai', cwd)).toBe(`${root}/${projectKeyForCwd(cwd)}`)
  });
});