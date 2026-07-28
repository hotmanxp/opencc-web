import { describe, expect, test } from 'vitest'
import { existsSync } from 'fs'

const SCRIPT = 'scripts/sync-from-opencc.ts'

describe('sync-from-opencc', () => {
  test('script file exists', () => {
    expect(existsSync(SCRIPT)).toBe(true)
  })
})
