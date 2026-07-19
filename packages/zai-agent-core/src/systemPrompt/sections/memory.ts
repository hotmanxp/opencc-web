/**
 * Memory section (AGENTS.md / AGENTS.local.md chain).
 *
 * Wraps the existing `loadMemoryForPrompt` (agents/memoryLoader.ts)
 * in a section registry entry. Per-cwd caching is owned by
 * memoryLoader; this section is just the format adapter.
 *
 * Output format mirrors the opencc `memory` section — a single
 * markdown block listing each file with a path comment, joined by
 * blank lines. We append a header so the model knows what it's
 * reading; opencc leaves this implicit.
 *
 * Section is cached per cwd so consecutive turns in the same cwd
 * reuse the rendered string. Cwd changes (LLM-self-cwd-switch)
 * trigger a recompute via the cache key.
 */

import { loadMemoryForPrompt } from '../../agents/memoryLoader.js'
import { systemPromptSection } from '../section.js'

export function getMemorySection(opts: { cwd: string; enabled: boolean }) {
  return systemPromptSection(
    `memory:${opts.cwd}`,
    async () => {
      if (!opts.enabled) return null
      const files = await loadMemoryForPrompt(opts.cwd)
      if (files.length === 0) return null
      const formatted = files
        .map(f => `<!-- ${f.path} -->\n${f.content}`)
        .join('\n\n')
      return `以下是根据项目 AGENTS.md / .claude/rules 加载的指令:\n\n${formatted}`
    },
  )
}