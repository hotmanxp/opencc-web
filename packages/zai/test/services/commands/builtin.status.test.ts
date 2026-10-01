import { describe, expect, it, vi } from 'vitest'

// vi.mock 会被提升到模块顶层执行, 必须写在顶层(不能包在 beforeEach 里,
// vitest 5 起会直接报 "defined outside of the module's top level scope")。
vi.mock('../../../src/server/services/agentRuntime.js', () => ({
  getCurrentSessionId: () => 'sess-abc',
}))

describe('statusCommand', () => {
  it('payload includes cwdName derived from cwd', async () => {
    const { statusCommand } = await import('../../../src/server/services/commands/builtin/status.js')
    const result = await statusCommand.call('', { cwd: '/Users/x/project', dataDir: '/d', model: 'claude-3-5-sonnet' })
    expect(result.kind).toBe('status')
    const payload = (result as { payload: any }).payload
    expect(payload.cwd).toBe('/Users/x/project')
    expect(payload.cwdName).toBe('project')
    expect(payload.model).toBe('claude-3-5-sonnet')
    expect(payload.sessionId).toBe('sess-abc')
  })
})
