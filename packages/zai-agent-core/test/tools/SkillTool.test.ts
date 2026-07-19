import { describe, expect, test } from 'vitest'
import { SkillTool } from '../../src/tools/SkillTool/SkillTool.js'
import type { LoadedSkill } from '../../src/runtime/skills/types.js'
import type { ToolContext } from '../../src/tools/Tool.js'

function makeCtx(
  skills: LoadedSkill[],
  state: Record<string, unknown> = {},
  parentSessionId?: string,
): ToolContext {
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

  test('注入 body 含 base directory header + ${CLAUDE_SKILL_DIR}', async () => {
    const ctx = makeCtx([sampleSkill], {}, 'sess-abc')
    await SkillTool.call({ name: 'pdf' }, ctx)
    const pending = (ctx.state as any).__pendingSkillInjection as {
      content: string
    }
    expect(pending.content).toContain('Base directory for this skill: /skills/pdf')
    expect(pending.content).toContain('Read $FILE as PDF.')
  })

  test('替换 ${CLAUDE_SKILL_DIR} 占位符', async () => {
    const skill: LoadedSkill = {
      ...sampleSkill,
      markdown: 'Load from ${CLAUDE_SKILL_DIR}/file.txt',
    }
    const ctx = makeCtx([skill], {}, 'sess-abc')
    await SkillTool.call({ name: 'pdf' }, ctx)
    const pending = (ctx.state as any).__pendingSkillInjection as {
      content: string
    }
    expect(pending.content).toContain('Load from /skills/pdf/file.txt')
  })

  test('替换 ${CLAUDE_SESSION_ID} 占位符', async () => {
    const skill: LoadedSkill = {
      ...sampleSkill,
      markdown: 'session: ${CLAUDE_SESSION_ID}',
    }
    const ctx = makeCtx([skill], {}, 'sess-xyz')
    await SkillTool.call({ name: 'pdf' }, ctx)
    const pending = (ctx.state as any).__pendingSkillInjection as {
      content: string
    }
    expect(pending.content).toContain('session: sess-xyz')
  })

  test('parentSessionId 缺失时 ${CLAUDE_SESSION_ID} 退化为占位', async () => {
    const skill: LoadedSkill = {
      ...sampleSkill,
      markdown: 'session: ${CLAUDE_SESSION_ID}',
    }
    const ctx = makeCtx([skill])
    await SkillTool.call({ name: 'pdf' }, ctx)
    const pending = (ctx.state as any).__pendingSkillInjection as {
      content: string
    }
    expect(pending.content).toContain('session: sess-unknown')
  })

  test('args 替换：declared argNames $FILE 取首 token', async () => {
    // Opencc-faithful: argumentNames[0] → parsedArgs[0]. With one arg 'report.pdf'
    // that's resolved. (Legacy 1-indexed $1 in substituteArgumentsLegacy doesn't
    // apply here — SkillTool now uses the opencc-faithful substituteArguments.)
    const ctx = makeCtx([sampleSkill])
    await SkillTool.call({ name: 'pdf', args: 'report.pdf' }, ctx)
    const pending = (ctx.state as any).__pendingSkillInjection as {
      content: string
    }
    expect(pending.content).toContain('Read report.pdf as PDF.')
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

  // -------------------------------------------------------------------------
  // Opencc parity: leading slash, validation, disable-model-invocation
  // -------------------------------------------------------------------------

  test('leading slash "/pdf" 与 "pdf" 等价', async () => {
    const ctx = makeCtx([sampleSkill])
    const out = await SkillTool.call({ name: '/pdf' }, ctx)
    expect(out.isError).toBe(false)
    expect(out.output).toContain('<skill_invocation name="pdf">')
  })

  test('validateInput: name 缺失 → result: false', async () => {
    const result = await SkillTool.validateInput!({} as any, {} as any)
    expect(result.result).toBe(false)
    if (!result.result) {
      expect(result.errorCode).toBe(1)
      expect(result.message).toContain('Missing skill name')
    }
  })

  test('validateInput: 空字符串 → result: false', async () => {
    const result = await SkillTool.validateInput!({ name: '   ' }, {} as any)
    expect(result.result).toBe(false)
  })

  test('validateInput: 有效输入 → result: true', async () => {
    const result = await SkillTool.validateInput!({ name: 'pdf' }, {} as any)
    expect(result.result).toBe(true)
  })

  test('checkPermissions: disable-model-invocation → deny', async () => {
    const skill: LoadedSkill = {
      ...sampleSkill,
      frontmatter: {
        ...sampleSkill.frontmatter,
        'disable-model-invocation': true,
      },
    }
    const ctx = makeCtx([skill])
    const decision = await SkillTool.checkPermissions!({ name: 'pdf' }, ctx)
    expect(decision.behavior).toBe('deny')
  })

  test('checkPermissions: 已知 skill 允许', async () => {
    const ctx = makeCtx([sampleSkill])
    const decision = await SkillTool.checkPermissions!({ name: 'pdf' }, ctx)
    expect(decision.behavior).toBe('allow')
  })

  test('checkPermissions: 未知 skill 走 allow（让 call 输出明确错误）', async () => {
    const ctx = makeCtx([sampleSkill])
    const decision = await SkillTool.checkPermissions!({ name: 'ghost' }, ctx)
    expect(decision.behavior).toBe('allow')
  })

  test('call: disable-model-invocation → isError=true', async () => {
    const skill: LoadedSkill = {
      ...sampleSkill,
      frontmatter: {
        ...sampleSkill.frontmatter,
        'disable-model-invocation': true,
      },
    }
    const ctx = makeCtx([skill])
    const out = await SkillTool.call({ name: 'pdf' }, ctx)
    expect(out.isError).toBe(true)
    expect(out.output).toContain('disable-model-invocation')
  })

  test('userFacingName: 去掉 leading slash', () => {
    expect(SkillTool.userFacingName!({ name: '/commit' })).toBe('Skill(commit)')
    expect(SkillTool.userFacingName!({ name: 'commit' })).toBe('Skill(commit)')
  })

  test('getActivityDescription: 有 name 才有 desc', () => {
    expect(SkillTool.getActivityDescription!({ name: 'pdf' })).toContain('pdf')
    expect(SkillTool.getActivityDescription!({ name: 'pdf', args: 'a.pdf' }))
      .toContain('with args')
    expect(SkillTool.getActivityDescription!({ name: '' })).toBeNull()
  })
})