import { describe, expect, test } from 'vitest'
import { BashInputSchema } from '../../../src/tools/BashTool/schema.js'

describe('BashInputSchema', () => {
  test('最小可用: command only', () => {
    const r = BashInputSchema.safeParse({ command: 'ls' })
    expect(r.success).toBe(true)
  })

  test('缺 command fail', () => {
    const r = BashInputSchema.safeParse({})
    expect(r.success).toBe(false)
  })

  test('空 command fail', () => {
    const r = BashInputSchema.safeParse({ command: '' })
    expect(r.success).toBe(false)
  })

  test('timeout 上限 600_000', () => {
    const r = BashInputSchema.safeParse({ command: 'ls', timeout: 700_000 })
    expect(r.success).toBe(false)
  })

  test('run_in_background 可选 boolean', () => {
    const r = BashInputSchema.safeParse({ command: 'ls', run_in_background: true })
    expect(r.success).toBe(true)
  })
})
