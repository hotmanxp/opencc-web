import { describe, expect, test } from 'vitest'
import { SkillTool } from '../../src/tools/SkillTool/SkillTool.js'
import type { LoadedSkill } from '../../src/runtime/skills/types.js'
import type { ToolContext } from '../../src/tools/Tool.js'

function makeCtx(skills: LoadedSkill[], state: Record<string, unknown> = {}, parentSessionId?: string): ToolContext {
  return {
    cwd: '/tmp',
    env: {},
    abortSignal: new AbortController().signal,
    dataDir: '/tmp',
    canUseTool: async () => ({ behavior: 'allow' as const }),
    emitEvent: () => {},
    state: { __zaiSkills: skills, ...state },
    ...(parentSessionId !== undefined ? { parentSessionId } : {}),
  } as ToolContext
}

const sampleSkill: LoadedSkill = {
  name: 'pdf',
  baseDir: '/skills/pdf',
  filePath: '/skills/pdf/SKILL.md',
  frontmatter: { description: 'Read PDFs', arguments: ['FILE'] },
  markdown: 'Read $FILE as PDF.',
  sourceIndex: 0,
}

describe('SkillTool', () => {
  test('name = Skill', () => {
    expect(SkillTool.name).toBe('Skill')
  })

  test('找不到 skill → 返回 isError=true + 列表', async () => {
    const ctx = makeCtx([sampleSkill])
    const out = await SkillTool.call({ name: 'nope' }, ctx)
    expect(out.isError).toBe(true)
    expect(out.output).toContain("'nope'")
    expect(out.output).toContain('pdf')
  })

  test('替换 ${CLAUDE_SKILL_DIR}', async () => {
    const ctx = makeCtx([sampleSkill], {}, 'sess-abc')
    await SkillTool.call({ name: 'pdf' }, ctx)
    const pending = ctx.state.__pendingSkillInjection as { content: string }
    expect(pending.content).toBe('Read /skills/pdf as PDF.')
  })

  test('替换 ${CLAUDE_SESSION_ID}', async () => {
    const skill: LoadedSkill = {
      ...sampleSkill,
      markdown: 'session: ${CLAUDE_SESSION_ID}',
    }
    const ctx = makeCtx([skill], {}, 'sess-xyz')
    await SkillTool.call({ name: 'pdf' }, ctx)
    const pending = ctx.state.__pendingSkillInjection as { content: string }
    expect(pending.content).toBe('session: sess-xyz')
  })

  test('args 替换：$1 $NAME', async () => {
    const ctx = makeCtx([sampleSkill])
    await SkillTool.call({ name: 'pdf', args: 'report.pdf' }, ctx)
    const pending = ctx.state.__pendingSkillInjection as { content: string }
    expect(pending.content).toBe('Read report.pdf as PDF.')
  })

  test('tool result 包裹 <skill_invocation>', async () => {
    const ctx = makeCtx([sampleSkill])
    const out = await SkillTool.call({ name: 'pdf', args: 'doc.pdf' }, ctx)
    expect(out.output).toContain('<skill_invocation name="pdf">')
    expect(out.output).toContain('Read doc.pdf as PDF.')
    expect(out.output).toContain('</skill_invocation>')
    expect(out.isError).toBe(false)
  })

  test('ctx.state 无 __zaiSkills 时不抛错', async () => {
    const ctx: ToolContext = {
      cwd: '/tmp',
      env: {},
      abortSignal: new AbortController().signal,
      dataDir: '/tmp',
      canUseTool: async () => ({ behavior: 'allow' as const }),
      emitEvent: () => {},
      state: {},
    }
    const out = await SkillTool.call({ name: 'pdf' }, ctx)
    expect(out.isError).toBe(true)
    expect(out.output).toContain('not found')
  })
})
