import type { LoadedSkill } from './types.js'

export function buildSkillsSystemPrompt(skills: LoadedSkill[]): string | null {
  if (skills.length === 0) return null

  const blocks = skills
    .map(s => {
      const lines: string[] = []
      lines.push(`<name>${escapeXml(s.name)}</name>`)
      const desc = s.description ?? s.frontmatter?.description ?? ''
      lines.push(`<description>${escapeXml(desc)}</description>`)
      if (s.frontmatter?.when_to_use) {
        lines.push(`<when_to_use>${escapeXml(s.frontmatter.when_to_use)}</when_to_use>`)
      }
      return `<skill>\n${lines.join('\n')}\n</skill>`
    })
    .join('\n')

  return `The following skills are available for use with the Skill tool:

<skills>
${blocks}
</skills>

When a skill matches the user's intent, invoke it via the Skill tool with the skill name as the \`name\` argument. Only the frontmatter (name/description) is shown above; the full skill body is injected on invocation.`
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
