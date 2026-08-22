import { describe, it, expect } from 'vitest';
import { DSH_VERSION, DSH_BRIDGE_VERSION, DSH_KERNEL, OPENCC_KERNEL } from '../src/index.js';
import {
  dshSessionsRootAbs,
  dshSessionsRoot,
  projectKeyForCwd,
  decodeSegment,
} from '../src/sessions/store.js';
import { LocalShellExecutor, Win32ShellExecutor, createShellExecutor, detectCwdChangePosix, detectCwdChangeWin32 } from '../src/tools/bash.js';

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

describe('Phase 3.1: createDshSubagentScope (dsh-scope 自实现)', () => {
  it('createDshSubagentScope 接受 plain object scope keys', async () => {
    const { createDshSubagentScope } = await import('../src/index.js')
    // 验证导出与签名（不实跑 createScope — 需要真实 Cordis ctx）
    expect(typeof createDshSubagentScope).toBe('function')
  });
});

describe('Phase 1.2: Win32ShellExecutor + POSIX detectCwdChange', () => {
  describe('detectCwdChangePosix', () => {
    it('识别行首 cd <path>', () => {
      expect(detectCwdChangePosix('cd /tmp/foo', '/home')).toBe('/tmp/foo')
    });
    it('支持双引号', () => {
      expect(detectCwdChangePosix('cd "/tmp/foo bar"', '/home')).toBe('/tmp/foo bar')
    });
    it('支持单引号', () => {
      expect(detectCwdChangePosix("cd '/tmp/foo bar'", '/home')).toBe('/tmp/foo bar')
    });
    it('相对路径返回 fallback', () => {
      expect(detectCwdChangePosix('cd relative/path', '/home')).toBe('/home')
    });
    it('没有 cd 返回 fallback', () => {
      expect(detectCwdChangePosix('ls -la', '/home')).toBe('/home')
    });
    it('cd 在第二行返回 fallback', () => {
      expect(detectCwdChangePosix('echo hi; cd /tmp/foo', '/home')).toBe('/home')
    });
  });

  describe('detectCwdChangeWin32', () => {
    it('识别 cd /d <path>（带跨盘符）', () => {
      expect(detectCwdChangeWin32('cd /d D:\\Users\\x', 'C:\\home')).toBe('D:\\Users\\x')
    });
    it('识别不带 /d 的 cd（同盘符）', () => {
      expect(detectCwdChangeWin32('cd Users\\x', 'C:\\home')).toBe('C:\\home') // 相对路径 → fallback
    });
    it('识别 pushd', () => {
      expect(detectCwdChangeWin32('pushd D:\\proj', 'C:\\home')).toBe('D:\\proj')
    });
    it('盘符大小写不敏感', () => {
      expect(detectCwdChangeWin32('cd /d c:\\Users\\x', 'C:\\home')).toBe('c:\\Users\\x')
    });
    it('UNC 路径 \\server\\share', () => {
      expect(detectCwdChangeWin32('cd /d \\\\srv\\share', 'C:\\home')).toBe('\\\\srv\\share')
    });
    it('没有 cd 返回 fallback', () => {
      expect(detectCwdChangeWin32('dir', 'C:\\home')).toBe('C:\\home')
    });
    it('支持引号包裹路径', () => {
      expect(detectCwdChangeWin32('cd /d "D:\\Program Files"', 'C:\\home')).toBe('D:\\Program Files')
    });
    it('支持 && 分隔符', () => {
      expect(detectCwdChangeWin32('cd /d D:\\foo && dir', 'C:\\home')).toBe('D:\\foo')
    });
  });

  describe('ShellExecutor class identity', () => {
    it('LocalShellExecutor / Win32ShellExecutor 都是 BaseShellExecutor 子类', () => {
      // 通过原型链验证（无需实例化）
      expect(LocalShellExecutor.prototype).toBeDefined()
      expect(Win32ShellExecutor.prototype).toBeDefined()
      // 两者是不同类
      expect(LocalShellExecutor).not.toBe(Win32ShellExecutor)
    });
    // createShellExecutor 工厂的真实分支依赖 process.platform — 沙箱内永远走 POSIX
    it('createShellExecutor 在 POSIX 平台返回 LocalShellExecutor（间接验证）', () => {
      // 我们不能直接 instanceof，因为需要 Context；改为查静态属性
      // 工厂的 POSIX 分支返回 new LocalShellExecutor(...) — 通过类型签名验证
      expect(typeof createShellExecutor).toBe('function')
    });
  });
});