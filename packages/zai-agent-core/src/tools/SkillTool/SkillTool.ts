import type { LegacyTool, LegacyToolContext } from '../Tool.js'
import type { LoadedSkill, PendingSkillInjection } from '../../runtime/skills/index.js'
import {
  parseBooleanFrontmatter,
  parseEffortValue,
  parseShellFrontmatter,
  splitPathInFrontmatter,
} from '../../runtime/skills/frontmatter.js'
import { substituteArguments } from '../../runtime/skills/substitute.js'
import { renderPrompt } from './prompt.js'
import { SkillInputSchema, type SkillInput } from './schema.js'

/**
 * Skill tool — mirrors opencc's `SkillTool`.
 *
 * Invokes a skill by name and prepends the skill body as a user message in
 * the conversation so the model can act on the instructions. The actual
 * message injection happens in `queryLoop` via `ctx.state.__pendingSkillInjection`
 * — SkillTool only fills that field, then queryLoop appends the user message
 * in the right order.
 *
 * Opencc parity (incremental over the legacy zai version):
 *  - `validateInput` — name required, leading slash stripped
 *  - `checkPermissions` — respects `disable-model-invocation`, allows safe skills
 *  - Frontmatter passthrough — `when_to_use`, `argument-hint`, `disable-model-invocation`,
 *    `user-invocable`, `shell`, `effort`, `context:fork`, `paths:`
 *  - Base-directory header — injected content starts with
 *    `Base directory for this skill: <baseDir>` so skills can use
 *    relative paths in shell snippets
 *  - `tool_use:error` includes the toolUseId so the runtime can route the
 *    error to the matching tool card in the UI
 *  - `newMessages` not used here — the pending-injection pattern is the
 *    zai equivalent. Keeping it out of `newMessages` avoids double-rendering
 *    in the UI (see queryLoop.ts for the loadTranscript skip).
 */
export const SkillTool: LegacyTool<typeof SkillInputSchema, string> = {
  name: 'Skill',
  description: renderPrompt(),
  inputSchema: SkillInputSchema,
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  isDestructive: () => false,

  // -------------------------------------------------------------------------
  // Opencc Tool contract methods
  // -------------------------------------------------------------------------

  async validateInput(
    rawInput: unknown,
  ): Promise<
    { result: true } | { result: false; message: string; errorCode: number }
  > {
    const input = rawInput as Partial<SkillInput>
    if (!input || typeof input.name !== 'string' || !input.name.trim()) {
      return {
        result: false,
        message:
          'Missing skill name. Pass the skill name as the `name` argument ' +
          '(e.g., name: "commit" or "/commit").',
        errorCode: 1,
      }
    }
    const trimmed = input.name.trim()
    if (!trimmed) {
      return { result: false, message: `Invalid skill name: ${input.name}`, errorCode: 1 }
    }
    if (input.args !== undefined && typeof input.args !== 'string') {
      return {
        result: false,
        message: '`args` must be a string when provided.',
        errorCode: 1,
      }
    }
    return { result: true }
  },

  async checkPermissions(
    rawInput: unknown,
    ctx: LegacyToolContext,
  ): Promise<
    | { behavior: 'allow'; updatedInput?: any }
    | { behavior: 'deny'; message: string; updatedInput?: any }
    | { behavior: 'ask'; message?: string; updatedInput?: any }
  > {
    const input = rawInput as SkillInput
    const skills: LoadedSkill[] =
      ((ctx.state as any).__zaiSkills as LoadedSkill[] | undefined) ?? []
    const normalizedName = stripLeadingSlash(input.name ?? '').trim()
    const skill = skills.find(s => s.name === normalizedName)

    if (!skill) {
      // Unknown skill → let `call` produce the descriptive error. Permission
      // stage only blocks skills that ARE known but should never be invoked
      // by the model (disable-model-invocation).
      return { behavior: 'allow', updatedInput: input }
    }

    const disableModelInvocation = parseBooleanFrontmatter(
      skill.frontmatter?.['disable-model-invocation'],
      false,
    )
    if (disableModelInvocation) {
      return {
        behavior: 'deny',
        message: `Skill ${skill.name} has disable-model-invocation set; cannot be invoked via the Skill tool.`,
        updatedInput: input,
      }
    }

    return { behavior: 'allow', updatedInput: input }
  },

  userFacingName(input: SkillInput): string {
    const name = stripLeadingSlash(input.name ?? '').trim() || 'skill'
    return `Skill(${name})`
  },

  getActivityDescription(input: SkillInput): string | null {
    const name = stripLeadingSlash(input.name ?? '').trim()
    if (!name) return null
    return input.args
      ? `Invoking /${name} with args`
      : `Invoking /${name}`
  },

  getToolUseSummary(input: SkillInput): string | null {
    const name = stripLeadingSlash(input.name ?? '').trim()
    if (!name) return null
    return input.args ? `/${name} ${input.args}` : `/${name}`
  },

  toAutoClassifierInput(input: SkillInput) {
    return {
      name: 'Skill',
      skill: input.name,
      args: input.args ?? '',
    }
  },

  async call(rawInput, ctx: LegacyToolContext) {
    const input = rawInput as SkillInput
    const skills: LoadedSkill[] =
      ((ctx.state as any).__zaiSkills as LoadedSkill[] | undefined) ?? []
    const normalizedName = stripLeadingSlash(input.name ?? '').trim()

    const skill = skills.find(s => s.name === normalizedName)
    if (!skill) {
      const available = skills.map(s => s.name).join(', ') || '(none)'
      return {
        output: `Skill '${input.name}' not found. Available skills: ${available}`,
        isError: true,
      }
    }

    // Same disable-model-invocation check that checkPermissions performs — we
    // re-check at call time because legacy `canUseTool` is the one wired in
    // by `defaultCanUseToolFactory`, and this tool can still be called when
    // permissions are auto-allowed (e.g. acceptEdits mode). Belt-and-suspenders.
    if (
      parseBooleanFrontmatter(
        skill.frontmatter?.['disable-model-invocation'],
        false,
      )
    ) {
      return {
        output: `Skill '${skill.name}' cannot be used with the Skill tool (disable-model-invocation).`,
        isError: true,
      }
    }

    // ----- Compose the injected body ---------------------------------------

    const baseDir = skill.baseDir
      ? process.platform === 'win32'
        ? skill.baseDir.replace(/\\/g, '/')
        : skill.baseDir
      : undefined

    let body = skill.markdown ?? skill.body ?? ''
    if (baseDir) {
      // Opencc prepends this header so skills can reference relative paths
      // (e.g. `./schemas/foo.json`) and bash snippets can use `cd $base`.
      body = `Base directory for this skill: ${baseDir}\n\n${body}`
    }

    // Skill can reference its own directory / current session via env-var-like
    // placeholders. We substitute after the base-dir prepend so a skill that
    // already mentions ${CLAUDE_SKILL_DIR} resolves to the normalized path.
    // Matches opencc loadSkillsDir.ts:357-367.
    if (baseDir) {
      body = body.replace(/\$\{CLAUDE_SKILL_DIR\}/g, baseDir)
    }
    body = body.replace(
      /\$\{CLAUDE_SESSION_ID\}/g,
      ctx.parentSessionId ?? 'sess-unknown',
    )

    // Resolve arg names from frontmatter. Accept both string ("FOO bar baz")
    // and array form. parseArgumentNames is exported from substitute.ts.
    const fmArgs = skill.frontmatter?.arguments
    const argNames: string[] = Array.isArray(fmArgs)
      ? fmArgs.filter((n): n is string => typeof n === 'string')
      : typeof fmArgs === 'string'
        ? fmArgs.split(/\s+/).filter(Boolean)
        : []

    // Substitute placeholders. opencc-faithful signature: 0-indexed $N.
    // We pass appendIfNoPlaceholder=false for skills with explicit `arguments:`
    // declared (so unused args don't bloat the prompt) and true otherwise
    // (so users invoking `/pdf report.pdf` always see their args even if the
    // body doesn't reference them).
    const hasDeclaredArgs = argNames.length > 0
    body = substituteArguments(
      body,
      input.args,
      !hasDeclaredArgs,
      argNames,
    )

    // Skill-level shell / effort / paths metadata. We don't currently apply
    // these (zai doesn't yet support inline `!shell` snippets), but log them
    // in DEBUG so skill authors can verify the frontmatter parsed correctly.
    if (process.env.ZAI_DEBUG === '1') {
      const shell = parseShellFrontmatter(skill.frontmatter?.shell, skill.name)
      const effort = parseEffortValue(skill.frontmatter?.effort)
      const paths = splitPathInFrontmatter(skill.frontmatter?.paths)
      const fork = skill.frontmatter?.context === 'fork'
      console.debug('[SkillTool] invoke', {
        skill: skill.name,
        hasShell: !!shell,
        effort,
        pathCount: paths.length,
        forkContext: fork,
        agent: skill.frontmatter?.agent,
      })
    }

    // Hook for runtime injection (read by queryLoop.ts after this turn).
    const pending: PendingSkillInjection = {
      skillName: skill.name,
      content: body,
    }
    ;(ctx.state as any).__pendingSkillInjection = pending

    return {
      output: `<skill_invocation name="${skill.name}">\n${body}\n</skill_invocation>`,
      isError: false,
    }
  },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip a single leading `/` so users can pass `/commit` instead of `commit`.
 * Matches opencc's behavior — `/` is normalized away before the lookup.
 */
function stripLeadingSlash(name: string): string {
  return name.startsWith('/') ? name.slice(1) : name
}