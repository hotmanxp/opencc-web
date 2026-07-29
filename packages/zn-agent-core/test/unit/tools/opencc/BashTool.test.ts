import { describe, expect, it } from 'vitest'
import { wrapBashToolAsOpencc } from '../../../../src/compat/tools/opencc/BashTool.js'

describe('wrapBashToolAsOpencc', () => {
  it('returns tool with name Bash', () => {
    expect(wrapBashToolAsOpencc().name).toBe('Bash')
  })

  it('isDestructive returns true', () => {
    const wrapped = wrapBashToolAsOpencc() as any
    expect(wrapped.isDestructive({ command: 'rm -rf /' })).toBe(true)
    expect(wrapped.isDestructive({ command: 'ls' })).toBe(true)
  })

  it('call delegates to underlying bash tool', async () => {
    const wrapped = wrapBashToolAsOpencc()
    const result = await wrapped.call(
      { command: 'echo hello' },
      { cwd: '/tmp' } as any,
      {} as any,
      {} as any,
    )
    expect(result).toBeDefined()
    // zai's bashTool returns { output: string }
    expect((result as any).output).toBeDefined()
  })
})
