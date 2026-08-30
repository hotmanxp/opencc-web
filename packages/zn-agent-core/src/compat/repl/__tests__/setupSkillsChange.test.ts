// packages/zn-agent-core/src/compat/repl/__tests__/setupSkillsChange.test.ts
// @ts-nocheck
import { setupSkillsChange } from '../setup/setupSkillsChange.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('setupSkillsChange', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'repl-p1-skills-'))
  afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

  it('teardown stops chokidar cleanly', () => {
    const received: string[][] = []
    const handle = setupSkillsChange({
      cwd: tmpDir,
      onSkillsChanged: files => received.push(files),
    })
    handle.teardown()
    expect(received).toEqual([])
  })

  it('teardown is idempotent', () => {
    const handle = setupSkillsChange({
      cwd: tmpDir,
      onSkillsChanged: () => {},
    })
    handle.teardown()
    expect(() => handle.teardown()).not.toThrow()
  })

  it('triggerRefresh runs callback without errors', async () => {
    const calls: number[] = []
    const handle = setupSkillsChange({
      cwd: tmpDir,
      onSkillsChanged: () => calls.push(Date.now()),
    })
    await handle.triggerRefresh()
    expect(calls.length).toBeGreaterThanOrEqual(1)
    handle.teardown()
  })
})