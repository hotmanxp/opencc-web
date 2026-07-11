import { describe, expect, test } from 'vitest'
import { pickEnv, isReadOnlyCommand, isDestructiveCommand } from '../../../src/tools/BashTool/sandbox.js'

describe('pickEnv', () => {
  // 默认 (无 allowlist) 透传 process.env 副本, 不锁定 PATH — 否则 sandbox 里
  // 任何外部命令 (bun / npm / git 等) 都 "command not found", sandbox 残废.
  // 沙箱调用方想要 deny 变量 (API key 等) 时显式传 envAllowlist, 不要靠默认值兜底.
  test('无 allowlist 返回完整 env 副本 (含 PATH)', () => {
    const out = pickEnv({ PATH: '/x', HOME: '/h' })
    expect(out).toEqual({ PATH: '/x', HOME: '/h' })
  })

  test('allowlist 过滤 env', () => {
    const out = pickEnv({ PATH: '/x', HOME: '/h', USER: 'u' }, ['PATH', 'USER'])
    expect(out).toEqual({ PATH: '/x', USER: 'u' })
  })

  test('缺失字段跳过', () => {
    const out = pickEnv({ PATH: '/x' }, ['PATH', 'NONEXISTENT'])
    expect(out).toEqual({ PATH: '/x' })
  })
})

describe('isReadOnlyCommand', () => {
  test('ls / cat / echo / pwd 视为 read-only', () => {
    for (const cmd of ['ls -la', 'cat /etc/hosts', 'echo hi', 'pwd', 'grep x /tmp/y']) {
      expect(isReadOnlyCommand(cmd)).toBe(true)
    }
  })

  test('rm / mv / kill 视为非 read-only', () => {
    for (const cmd of ['rm -rf /', 'mv a b', 'kill 1', '> /etc/passwd', '>> /etc/passwd']) {
      expect(isReadOnlyCommand(cmd)).toBe(false)
    }
  })
})

describe('isDestructiveCommand', () => {
  test('rm / mv / chmod / dd 视为 destructive', () => {
    for (const cmd of ['rm x', 'chmod 777 y', 'dd if=/dev/zero of=/dev/sda', '> /x']) {
      expect(isDestructiveCommand(cmd)).toBe(true)
    }
  })

  test('echo / ls 视为非 destructive', () => {
    for (const cmd of ['echo hi', 'ls', 'cat /etc/hosts']) {
      expect(isDestructiveCommand(cmd)).toBe(false)
    }
  })
})
