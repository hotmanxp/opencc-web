import type { Tool } from '../Tool.js'
import type { LoadedSkill, PendingSkillInjection } from '../../runtime/skills/index.js'
import { substituteArguments } from '../../runtime/skills/substitute.js'
import { renderPrompt } from './prompt.js'
import { SkillInputSchema, type SkillInput } from './schema.js'

export const SkillTool: Tool<typeof SkillInputSchema, string> = {
  name: 'Skill',
  description: renderPrompt(),
  inputSchema: SkillInputSchema,
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  isDestructive: () => false,

  async call(rawInput, ctx) {
    const input = rawInput as SkillInput
    const skills: LoadedSkill[] = (ctx.state.__zaiSkills as LoadedSkill[] | undefined) ?? []
    const skill = skills.find(s => s.name === input.name)

    if (!skill) {
      const available = skills.map(s => s.name).join(', ') || '(none)'
      return {
        output: `Skill '${input.name}' not found. Available skills: ${available}`,
        isError: true,
      }
    }

    const skillDir = process.platform === 'win32'
      ? (skill.baseDir ?? '').replace(/\\/g, '/')
      : (skill.baseDir ?? '')

    let body = skill.markdown ?? skill.body ?? ''
    body = body.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir)
    const sessionId = ctx.parentSessionId ?? 'sess-unknown'
    body = body.replace(/\$\{CLAUDE_SESSION_ID\}/g, sessionId)

    const fmArgs = skill.frontmatter?.arguments
    const argNames = Array.isArray(fmArgs)
      ? fmArgs
      : typeof fmArgs === 'string'
        ? [fmArgs]
        : []

    if (input.args !== undefined) {
      body = substituteArguments(body, input.args, true, argNames)
    } else if (argNames.length > 0) {
      // No args provided: fall back to the skill directory for any named args
      body = substituteArguments(body, skillDir, true, argNames)
    }

    const pending: PendingSkillInjection = {
      skillName: skill.name,
      content: body,
    }
    ctx.state.__pendingSkillInjection = pending

    return {
      output: `<skill_invocation name="${skill.name}">\n${body}\n</skill_invocation>`,
      isError: false,
    }
  },
}
