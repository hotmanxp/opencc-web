// packages/zn-agent-core/src/compat/repl/__tests__/setupSkillsChange.chokidar.test.ts
// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P3, Task 4): chokidar integration test
 * for setupSkillsChange. Path uses `${cwd}/.agents/skills/` per user
 * clarification (vendored `.zai/skills/` is INTERNAL-only); chokidar
 * reports add/change/unlink within 3s of file change.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setupSkillsChange } from '../setup/setupSkillsChange.js'

describe('setupSkillsChange chokidar integration', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'repl-p3-skl-'))
  afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

  it('emits onSkillsChanged within 3s of new file add', async () => {
    const skillsDir = join(tmpDir, '.agents', 'skills')
    mkdirSync(skillsDir, { recursive: true })

    const calls: string[][] = []
    const handle = setupSkillsChange({
      cwd: tmpDir,
      onSkillsChanged: files => calls.push(files),
    })

    // Wait for chokidar to initialize (initial scan + ready)
    await new Promise(resolve => setTimeout(resolve, 500))

    // Add a new skill file
    writeFileSync(join(skillsDir, 'new-skill.md'), '# new skill')

    // Wait up to 3s for notification
    const start = Date.now()
    while (calls.length === 0 && Date.now() - start < 3000) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(calls.length).toBeGreaterThanOrEqual(1)
    handle.teardown()
  })

  it('emits onSkillsChanged within 3s of file modification', async () => {
    const skillsDir = join(tmpDir, '.agents', 'skills')
    mkdirSync(skillsDir, { recursive: true })
    const existing = join(skillsDir, 'existing.md')
    writeFileSync(existing, '# existing v1')

    const calls: string[][] = []
    const handle = setupSkillsChange({
      cwd: tmpDir,
      onSkillsChanged: files => calls.push(files),
    })

    await new Promise(resolve => setTimeout(resolve, 500))
    writeFileSync(existing, '# existing v2')

    const start = Date.now()
    while (calls.length === 0 && Date.now() - start < 3000) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(calls.length).toBeGreaterThanOrEqual(1)
    handle.teardown()
  })
})