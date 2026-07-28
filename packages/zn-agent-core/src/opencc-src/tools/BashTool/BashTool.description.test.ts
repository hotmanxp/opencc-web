import { describe, expect, test } from 'bun:test'
import { BashTool } from './BashTool.js'

// T2 prompt sync (2026-06-14): upstream 2.1.177 uses
//   "Executes a given bash command and returns its output."
// OpenCC keeps the sandbox concept (run_in_background, dangerouslyDisableSandbox,
// SandboxManager) and adopts UP's "Executes..." framing. The OC-specific bits
// (sandbox, working directory persistence, ctrl-c interrupt) must remain in
// the description because they document behavior UP does not have.

describe('BashTool description (T2 prompt sync)', () => {
  test('default description mentions sandbox and working-directory persistence', async () => {
    const desc = await BashTool.description({ command: 'ls' })
    expect(desc).toContain('sandbox')
    expect(desc).toContain('working directory persists')
  })

  test('default description does not use the legacy "Run shell command" one-liner', async () => {
    const desc = await BashTool.description({ command: 'ls' })
    expect(desc).not.toBe('Run shell command')
  })

  test('explicit description argument still wins (back-compat)', async () => {
    const desc = await BashTool.description({ command: 'ls', description: 'list src' })
    expect(desc).toBe('list src')
  })
})
