import { describe, expect, it } from 'vitest'
import { buildDefaultTools } from '../../../src/compat/tools/index.js'

describe('buildDefaultTools includes DisplayFiles', () => {
  it('contains the DisplayFiles tool', () => {
    const names = buildDefaultTools().map((t) => t.name)
    expect(names).toContain('DisplayFiles')
  })

  it('DisplayFiles tool has correct schema shape', () => {
    const tool = buildDefaultTools().find((t) => t.name === 'DisplayFiles')
    expect(tool).toBeDefined()
    expect(tool!.description).toContain('展示')
  })
})
