// @ts-nocheck — uses bun runtime extensions (import.meta.dir, Bun.file) that
// the project's TypeScript config doesn't model. Other tests in this dir
// (providerCounts.test.ts, etc.) follow the same pattern.
import { describe, test, expect } from 'bun:test'
import { resolve } from 'path'

const SRC = resolve(import.meta.dir, '..')
const file = (relative: string) => Bun.file(resolve(SRC, relative))

describe('process.title', () => {
  test('should be set to opencc in main.tsx', async () => {
    const mainSource = await file('main.tsx').text()
    expect(mainSource).toContain("process.title = 'opencc'")
    // Avoid the bare 'claude' string at the assignment site (defensive:
    // there's a Windows-on-conhost comment above that mentions 'process.title',
    // and an unrelated use-terminal-title.ts that also touches process.title).
    // The precise check is that the assignment uses 'opencc'.
    const assignmentLine = mainSource
      .split('\n')
      .find(l => l.includes('process.title =') && !l.trim().startsWith('//'))
    expect(assignmentLine).toBeDefined()
    expect(assignmentLine).toContain("'opencc'")
  })
})
