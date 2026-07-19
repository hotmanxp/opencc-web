/**
 * Tool description for the Skill tool. Mirrors opencc's `SkillTool/prompt.ts`
 * so the model gets the same "what / when / how" framing:
 *
 *  - Skills are slash commands invoked by name
 *  - Always invoke when one matches; never mention a skill without calling it
 *  - Skills expand into a full prompt on invocation; downstream tool calls
 *    come from the expanded body, not from this wrapper
 *  - Frontmatter `arguments` and `argument-hint` describe accepted arg shapes
 *
 * The full description lives in the system prompt's `<skills>` listing —
 * SkillTool's `description` only has to teach the model how to call it.
 */
export function renderPrompt(): string {
  return [
    'Invoke a skill by name. The skill body is injected as a user message for the current session.',
    '',
    'Args:',
    '  - name: The skill name as listed in the <skills> block of the system prompt (with or without leading "/", e.g. "pdf" or "/pdf").',
    '  - args: Optional argument string to substitute into the skill body via $ARGUMENTS / $NAME / $0..$N placeholders.',
    '',
    'How to invoke:',
    '  - Use this tool with the skill name and optional arguments',
    '  - Examples:',
    '    - name: "pdf"                       → invoke the pdf skill',
    '    - name: "/commit"                   → invoke /commit (leading slash stripped)',
    '    - name: "review-pr", args: "123"    → invoke with arguments',
    '    - name: "ms-office-suite:pdf"       → invoke using fully qualified name',
    '',
    'Important:',
    '  - Available skills are listed in the <skills> block of the system prompt',
    '  - When a skill matches the user\'s request, this is a BLOCKING REQUIREMENT: invoke the Skill tool BEFORE generating any other response',
    '  - NEVER mention a skill without actually calling this tool',
    '  - Do not invoke a skill that is already running',
    '  - The full skill body becomes available to you after invocation; only the frontmatter (name/description) is in the listing',
  ].join('\n')
}