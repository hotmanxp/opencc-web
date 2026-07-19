/**
 * Scratchpad directory section.
 *
 * Mirrors opencc's `getScratchpadInstructions` (prompts.ts:819-841).
 * Tells the model where to put temporary files for this session,
 * instead of `/tmp` or other shared locations.
 *
 * Gated by `ZAI_SCRATCHPAD_ENABLED` env var (default: on). When the
 * flag is off, returns null and the section is skipped.
 *
 * Resolution order for the scratchpad dir:
 *   1. `ZAI_SCRATCHPAD_DIR` env var (explicit override)
 *   2. `<dataDir>/scratchpad/<sessionId>` (per-session, default)
 *
 * We use a closure-factory rather than a single cached section because
 * the section is sensitive to sessionId; if you want it cached across
 * turns, call the factory once per session and reuse the returned
 * `SystemPromptSection`.
 */

import { join } from 'node:path'
import { systemPromptSection } from '../section.js'

export function getScratchpadSection(opts: {
  enabled: boolean
  dir: string | null
}) {
  return systemPromptSection(
    `scratchpad:${opts.dir ?? 'off'}`,
    () => {
      if (!opts.enabled || !opts.dir) return null
      return `# Scratchpad Directory

IMPORTANT: Always use this scratchpad directory for temporary files instead of \`/tmp\` or other system temp directories:
\`${opts.dir}\`

Use this directory for ALL temporary file needs:
- Storing intermediate results or data during multi-step tasks
- Writing temporary scripts or configuration files
- Saving outputs that don't belong in the user's project
- Creating working files during analysis or processing
- Any file that would otherwise go to \`/tmp\`

Only use \`/tmp\` if the user explicitly requests it.

The scratchpad directory is session-specific, isolated from the user's project, and can be used freely without permission prompts.`
    },
  )
}

export function resolveScratchpadDir(dataDir: string, sessionId: string): string {
  const explicit = process.env.ZAI_SCRATCHPAD_DIR
  if (explicit) return explicit
  return join(dataDir, 'scratchpad', sessionId)
}

export function isScratchpadEnabled(): boolean {
  const v = process.env.ZAI_SCRATCHPAD_ENABLED
  return v === undefined || v === '' || v === '1' || v.toLowerCase() === 'true'
}