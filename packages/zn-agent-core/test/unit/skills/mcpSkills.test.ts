import { describe, expect, it } from 'vitest'
import { isSkillResource } from '../../../src/opencc-src/skills/mcpSkills.js'

/**
 * A `skill://` namespace carries both a skill entry point and the reference
 * docs shipped beside it. Only the entry may become a slash command / Skill
 * tool entry — the references are loaded on demand via ReadMcpResourceTool.
 *
 * The uri list below is the real `resources/list` payload from the cua-driver
 * MCP server (captured 2026-10-11), so a regression that re-admits the
 * reference docs fails here rather than silently repopulating the `/` menu.
 */
const CUA_DRIVER_URIS = [
  'skill://cua-driver/BROWSER.md',
  'skill://cua-driver/EMBEDDING.md',
  'skill://cua-driver/LINUX.md',
  'skill://cua-driver/MACOS.md',
  'skill://cua-driver/README.md',
  'skill://cua-driver/RECORDING.md',
  'skill://cua-driver/RUNTIME.md',
  'skill://cua-driver/SKILL.md',
  'skill://cua-driver/VISUAL.md',
  'skill://cua-driver/WORKFLOW.md',
  'skill://cua-driver/WINDOWS.md',
]

describe('isSkillResource', () => {
  it('admits only the SKILL.md entry from a real reference doc set', () => {
    const kept = CUA_DRIVER_URIS.filter(uri => isSkillResource({ uri }))
    expect(kept).toEqual(['skill://cua-driver/SKILL.md'])
  })

  it('rejects reference docs that sit beside the entry', () => {
    for (const uri of ['skill://cua-driver/BROWSER.md', 'skill://cua-driver/README.md']) {
      expect(isSkillResource({ uri })).toBe(false)
    }
  })

  it('is case-insensitive on the entry filename', () => {
    expect(isSkillResource({ uri: 'skill://cua-driver/skill.md' })).toBe(true)
  })

  it('admits an entry nested under a server or pack directory', () => {
    expect(isSkillResource({ uri: 'skill://srv/nested/dir/SKILL.md' })).toBe(true)
    expect(isSkillResource({ uri: 'skill://srv/my-skill/SKILL.md' })).toBe(true)
  })

  it('requires a filename boundary so lookalikes are rejected', () => {
    expect(isSkillResource({ uri: 'skill://cua-driver/MYSKILL.md' })).toBe(false)
    expect(isSkillResource({ uri: 'skill://cua-driver/SKILL.md.bak' })).toBe(false)
  })

  it('ignores non-skill schemes even when the path ends in SKILL.md', () => {
    expect(isSkillResource({ uri: 'file:///etc/SKILL.md' })).toBe(false)
  })
})