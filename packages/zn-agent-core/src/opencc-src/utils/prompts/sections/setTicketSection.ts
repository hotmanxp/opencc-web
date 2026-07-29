import { systemPromptSection } from '../../../constants/systemPromptSections.ts'
import { getTicketId } from '../../../state/setTicketStore.js'

/**
 * Set-ticket section — when /set-ticket has set an id, inject the team's
 * commit-message prefix rule into the LLM dynamic system prompt.
 *
 * Cacheable: section value is fixed at first turn (or after /clear / /compact).
 * Mid-conversation ticket id changes will not take effect on the LLM until the
 * user runs /clear or /compact to invalidate the prompt cache. Section text
 * stays compressed (~10 lines) — do NOT mirror AGENTS.md verbatim.
 */
export function createSetTicketSection() {
  return systemPromptSection('set_ticket', () => {
    const id = getTicketId()
    if (!id) return null
    return `Session ticket id: \`${id}\`. Prefix all git commits with it (e.g. \`${id} feat(login): xxx\`). Use \`/set-ticket clear\` to unbind.`
  })
}
