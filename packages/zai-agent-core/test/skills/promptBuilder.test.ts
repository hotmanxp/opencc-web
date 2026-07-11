import { describe, expect, test } from 'vitest'
import { buildSkillsSystemPrompt } from '../../src/runtime/skills/promptBuilder.js'
import type { LoadedSkill } from '../../src/runtime/skills/types.js'

function skill(name: string, fm: Partial<LoadedSkill['frontmatter']>, markdown = 'full body here'): LoadedSkill {
  return {
    name,
    baseDir: `/skills/${name.replace(':', '/')}`,
    filePath: `/skills/${name.replace(':', '/')}/SKILL.md`,
    frontmatter: { description: 'desc', ...fm },
    markdown,
    sourceIndex: 0,
  }
}

describe('buildSkillsSystemPrompt', () => {
  test('空数组 → null', () => {
    expect(buildSkillsSystemPrompt([])).toBeNull()
  })

  test('单 skill 输出含 name / description / when_to_use', () => {
    const out = buildSkillsSystemPrompt([
      skill('pdf', { description: 'Read PDFs', when_to_use: 'On PDF input' }),
    ])
    expect(out).toContain('<name>pdf</name>')
    expect(out).toContain('<description>Read PDFs</description>')
    expect(out).toContain('<when_to_use>On PDF input</when_to_use>')
  })

  test('不暴露 markdown body（节省 token）', () => {
    const out = buildSkillsSystemPrompt([skill('pdf', {}, 'SHOULD NOT APPEAR')])
    expect(out).not.toContain('SHOULD NOT APPEAR')
  })

  test('多 skill 按顺序输出', () => {
    const out = buildSkillsSystemPrompt([
      skill('alpha', { description: 'A' }),
      skill('beta', { description: 'B' }),
    ])
    const aIdx = out!.indexOf('<name>alpha</name>')
    const bIdx = out!.indexOf('<name>beta</name>')
    expect(aIdx).toBeGreaterThan(-1)
    expect(bIdx).toBeGreaterThan(aIdx)
  })

  test('when_to_use 缺失时不输出该标签', () => {
    const out = buildSkillsSystemPrompt([skill('pdf', { description: 'X' })])
    expect(out).not.toContain('<when_to_use>')
  })
})
