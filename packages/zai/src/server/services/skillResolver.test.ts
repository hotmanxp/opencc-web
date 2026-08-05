import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveSkillPrompt, listSkills } from './agentRuntime.js'

const origEnv = process.env.ZAI_SKILLS_DIRS

function makeSkillDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zai-skill-test-'))
  const skillDir = join(dir, 'ego-browser')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: ego-browser',
      'description: 用真实浏览器打开并测试网页',
      'arguments: url',
      '---',
      '',
      '你要用 ego-browser 打开 ${url} 并执行测试。$ARGUMENTS',
      '',
    ].join('\n'),
  )
  return dir
}

describe('skill resolver (slash-skill trigger path)', () => {
  let skillRoot: string

  beforeEach(() => {
    skillRoot = makeSkillDir()
    process.env.ZAI_SKILLS_DIRS = skillRoot
  })

  afterEach(() => {
    if (origEnv === undefined) delete process.env.ZAI_SKILLS_DIRS
    else process.env.ZAI_SKILLS_DIRS = origEnv
  })

  it('surfaces the skill in the autocomplete list', async () => {
    const list = await listSkills()
    const ego = list.find((s) => s.name === 'ego-browser')
    expect(ego!).toBeTruthy()
    expect(ego!.description).toEqual('用真实浏览器打开并测试网页')
  })

  it('renders the skill prompt with arg substitution', async () => {
    const rendered = await resolveSkillPrompt('ego-browser', '测试一下')
    expect(rendered).not.toBeNull()
    expect(rendered!).toContain('Base directory for this skill:')
    expect(rendered!).toContain('你要用 ego-browser 打开 测试一下 并执行测试。测试一下')
  })

  it('appends ARGUMENTS when the skill template has no placeholder', async () => {
    // 无占位符的 skill: opencc substituteArguments(appendIfNoPlaceholder) 会把
    // raw args 追加到末尾,否则模型看不到 /skill 后面的具体指令。
    const dir = mkdtempSync(join(tmpdir(), 'zai-skill-test-'))
    const skillDir = join(dir, 'no-args')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      ['---', 'name: no-args', 'description: 无占位符 skill', '---', '', '只是文档。', ''].join('\n'),
    )
    process.env.ZAI_SKILLS_DIRS = dir
    const rendered = await resolveSkillPrompt('no-args', '把登录页修一下')
    expect(rendered).toContain('只是文档。')
    expect(rendered).toContain('ARGUMENTS: 把登录页修一下')
  })

  it('returns null for an unknown skill name', async () => {
    expect(await resolveSkillPrompt('no-such-skill', 'x')).toBeNull()
  })
})