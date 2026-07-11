import { describe, expect, test } from 'vitest'
import { execSync } from 'child_process'

const SCRIPT = 'scripts/sync-from-opencc.ts'

describe('sync-from-opencc', () => {
  test('--dry-run exits without error', () => {
    const output = execSync(`npx tsx ${SCRIPT} --dry-run`, { encoding: 'utf-8' })
    expect(output).toContain('dry-run')
  })

  test('script file exists', () => {
    const { existsSync } = require('fs')
    expect(existsSync(SCRIPT)).toBe(true)
  })
})
