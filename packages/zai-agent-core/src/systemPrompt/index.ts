/**
 * Public surface of the system-prompt subsystem.
 *
 * Hosts (queryLoop.ts, routes/agent.ts, tools/AgentTool) should
 * import from here rather than reaching into the section files.
 *
 * Layout:
 *   systemPrompt/                       — orchestration
 *     type.ts       (branded SystemPrompt + asSystemPrompt)
 *     boundary.ts   (cache-split marker constant)
 *     section.ts    (memoized section registry)
 *     buildSystemPrompt.ts
 *     effective.ts  (6-level priority arbitration)
 *     defaults.ts   (DEFAULT_STATIC_INTRO: 7 opencc-style sections)
 *     sections/     (one file per dynamic section)
 *
 * Mirrors opencc's `getSystemPrompt` + `buildEffectiveSystemPrompt` +
 * `systemPromptSections.ts` split, but bundled into a single
 * self-contained module so we don't depend on the vendored
 * `opencc-internals/constants/prompts.ts` (which has Bun-only
 * imports).
 */

export {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from './boundary.js'
export {
  type SystemPrompt,
  asSystemPrompt,
} from './type.js'
export {
  systemPromptSection,
  DANGEROUS_uncachedSystemPromptSection,
  resolveSystemPromptSections,
  clearSystemPromptSections,
  peekSystemPromptSectionCache,
} from './section.js'
export {
  type BuildSystemPromptInput,
  buildSystemPrompt,
} from './buildSystemPrompt.js'
export {
  type BuildEffectiveSystemPromptInput,
  buildEffectiveSystemPrompt,
} from './effective.js'
export { DEFAULT_STATIC_INTRO } from './defaults.js'

export {
  getEnvInfoSection,
} from './sections/env.js'
export { getLanguageSection } from './sections/language.js'
export {
  getScratchpadSection,
  resolveScratchpadDir,
  isScratchpadEnabled,
} from './sections/scratchpad.js'
export { getTokenBudgetSection } from './sections/tokenBudget.js'
export { getNumericAnchorsSection } from './sections/numericAnchors.js'
export { getFRCSection } from './sections/frc.js'
export { getSummarizeToolResultsSection } from './sections/summarizeToolResults.js'
export { getMemorySection } from './sections/memory.js'
export { getSkillsSection } from './sections/skills.js'
export { getMcpInstructionsDynamicSection } from './sections/mcp.js'
export { getAvailableAgentsSection } from './sections/agents.js'
export {
  type SectionComputeContext,
  type SectionExtraContext,
} from './sections/context.js'