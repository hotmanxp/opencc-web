import { describe, expect, test } from 'vitest'
import { defaultCanUseToolFactory } from '../../src/runtime/canUseTool.js'

describe('defaultCanUseToolFactory', () => {
  test('Bash 无 sandbox 时 deny', async () => {
    const f = defaultCanUseToolFactory(undefined)
    const r = await f('Bash', { command: 'ls' })
    expect(r.behavior).toBe('deny')
  })

  test('Bash command 匹配 denylist 时 deny', async () => {
    const f = defaultCanUseToolFactory({
      executor: 'child_process', workdir: '/tmp', commandDenylist: [/^rm\b/],
    })
    const r = await f('Bash', { command: 'rm -rf /' })
    expect(r.behavior).toBe('deny')
    if (r.behavior === 'deny') expect(r.reason).toMatch(/denylist/)
  })

  test('Bash command 不在 allowlist 时 deny', async () => {
    const f = defaultCanUseToolFactory({
      executor: 'child_process', workdir: '/tmp', commandAllowlist: [/^ls\b/],
    })
    const r = await f('Bash', { command: 'cat /etc/passwd' })
    expect(r.behavior).toBe('deny')
  })

  test('Bash command 在 allowlist 内 allow', async () => {
    const f = defaultCanUseToolFactory({
      executor: 'child_process', workdir: '/tmp', commandAllowlist: [/^ls\b/],
    })
    const r = await f('Bash', { command: 'ls /tmp' })
    expect(r.behavior).toBe('allow')
  })

  test('Bash 无白/黑名单 + 有 sandbox 时 allow', async () => {
    const f = defaultCanUseToolFactory({ executor: 'child_process', workdir: '/tmp' })
    const r = await f('Bash', { command: 'echo hi' })
    expect(r.behavior).toBe('allow')
  })

  test('Agent 全 allow (用户选全开放)', async () => {
    const f = defaultCanUseToolFactory(undefined)
    const r = await f('Agent', { prompt: 'sub', subagent_type: 'general-purpose' })
    expect(r.behavior).toBe('allow')
  })

  test('其他工具全 allow', async () => {
    const f = defaultCanUseToolFactory(undefined)
    const r = await f('Read', { file_path: '/x' })
    expect(r.behavior).toBe('allow')
  })
})
