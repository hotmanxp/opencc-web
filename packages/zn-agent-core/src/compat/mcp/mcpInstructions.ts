/**
 * MCP Server Instructions → system prompt section.
 *
 * Mirrors opencc-internals' `getMcpInstructionsSection` (vendored from
 * opencc upstream which is not present in zai-agent-core's tree).
 *
 * Each connected MCP server can publish an `instructions` field (Anthropic
 * convention) describing how the model should use its tools. We concatenate
 * them into a single markdown block appended to the system prompt, AFTER
 * skills. This is the missing piece that distinguishes the opencc-style
 * MCP integration from zai-agent-core's previous minimal version: tool
 * *metadata* (description, inputSchema) was already injected via the
 * `tools` array of the API request, but *server-level instructions* were
 * silently dropped.
 */

export type MCPServerConnectionLike = {
  name?: string
  type?: string
  instructions?: string
  status?: string
}

const NOOP = () => ''

/**
 * Build the "MCP Server Instructions" section of the system prompt.
 * Returns '' when no client has instructions, so callers can use the
 * return value as a falsy guard.
 */
export function getMcpInstructionsSection(
  mcpClients: MCPServerConnectionLike[] | undefined,
): string {
  if (!mcpClients || mcpClients.length === 0) return NOOP()
  const blocks: { name: string; instructions: string }[] = []
  for (const c of mcpClients) {
    const text = c.instructions?.trim()
    if (text) blocks.push({ name: c.name ?? 'unknown', instructions: text })
  }
  if (blocks.length === 0) return NOOP()
  return [
    '# MCP Server Instructions',
    '',
    'The following MCP servers have provided instructions for how to use their tools:',
    '',
    ...blocks.map(
      (b) => `## ${b.name}\n\n${b.instructions}`,
    ),
  ].join('\n\n')
}