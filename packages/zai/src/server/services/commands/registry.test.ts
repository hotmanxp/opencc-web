import { describe, it, expect } from 'vitest'
import { getCommandRegistry } from '@zn-ai/zn-agent-core'
import { registerBuiltinCommands } from './registry.js'

describe('command registry', () => {
  it('包含 handoff builtin 命令', () => {
    registerBuiltinCommands()
    const reg = getCommandRegistry()
    const all = reg.all()
    const handoff = all.find((c: any) => c.name === 'handoff')
    expect(handoff, 'registry 应包含 handoff 命令').toBeDefined()
    expect((handoff as any).type).toBe('prompt')
    expect((handoff as any).source).toBe('builtin')
    expect((handoff as any).description).toContain('交接')
    expect((handoff as any).argumentHint).toBe('[--pick <filename>]')
  })
})