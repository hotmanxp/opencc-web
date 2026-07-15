import { describe, expect, it } from 'vitest'
import { compactCommand } from '../../../src/server/services/commands/builtin/compact.js'

describe('compactCommand (MVP stub)', () => {
  it('returns {kind:"error"} with explicit message', async () => {
    const result = await compactCommand.call('', { cwd: '/x', dataDir: '/d' })
    expect(result.kind).toBe('error')
    expect((result as { message: string }).message).toBe('/compact 暂未实现')
  })
})
