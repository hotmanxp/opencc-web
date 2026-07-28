// @zn-ai/zn-agent-core compat shim — port of zai-agent-core runtime/skills/index.ts.
//
// Barrel re-export. Path adjustments: all imports point at the flat
// `skills-*.ts` files in this directory.

export type { LoadedSkill, PendingSkillInjection, SkillFrontmatter } from './skills-types.js'
export {
  EFFORT_LEVELS,
  type EffortLevel,
  type EffortValue,
  type SkillShell,
  coerceDescriptionToString,
  parseBooleanFrontmatter,
  parseEffortValue,
  parseShellFrontmatter,
  parseSkillFrontmatter,
  splitPathInFrontmatter,
} from './skills-frontmatter.js'
export {
  parseArguments,
  parseArgumentNames,
  substituteArguments,
  substituteArgumentsLegacy,
} from './skills-substitute.js'
export { loadSkillsFromDirs } from './skills-loader.js'
export type { LoadSkillsOptions, ConditionalSkill } from './skills-loader.js'
export { buildSkillsSystemPrompt } from './skills-promptBuilder.js'