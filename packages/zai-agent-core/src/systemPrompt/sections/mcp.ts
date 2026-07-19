/**
 * MCP server instructions section.
 *
 * Wraps `getMcpInstructionsSection` (mcp/mcpInstructions.ts) in a
 * section registry entry.
 *
 * UNLIKE most sections, this one is `DANGEROUS_uncached` — the opencc
 * comment in prompts.ts:529-536 is explicit:
 *
 *   "MCP servers connect/disconnect between turns"
 *
 * If we cached the rendered block, a server that disconnects mid-
 * conversation would leave stale instructions in the prompt. The
 * recompute cost is small (it's a synchronous string concat over
 * already-loaded client objects).
 */

import { getMcpInstructionsSection, type MCPServerConnectionLike } from '../../mcp/mcpInstructions.js'
import { DANGEROUS_uncachedSystemPromptSection } from '../section.js'

export function getMcpInstructionsDynamicSection(
  mcpClients: readonly MCPServerConnectionLike[] | undefined,
) {
  return DANGEROUS_uncachedSystemPromptSection(
    'mcp_instructions',
    () => getMcpInstructionsSection([...(mcpClients ?? [])]) || null,
    'MCP servers connect/disconnect between turns',
  )
}