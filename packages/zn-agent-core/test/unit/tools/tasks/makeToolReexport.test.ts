import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { makeTool } from '../../../../src/compat/tools/index.js'

describe('makeTool re-export from compat/tools/index', () => {
  it('can be imported and used to create a Tool', async () => {
    const tool = makeTool({
      name: 'ProbeReexport',
      description: 'probe',
      inputSchema: z.object({ x: z.string() }),
      executor: async () => ({ output: 'ok' }),
    })
    expect(tool.name).toBe('ProbeReexport')
    const result = await tool.call({ x: 'hello' }, { cwd: '/tmp' })
    expect(result).toEqual({ output: 'ok' })
  })
})
