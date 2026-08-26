/**
 * Format the `External subagent providers` section for AgentTool's tool
 * description.
 *
 * Pulled out of `tools/AgentTool/prompt.ts` so the formatting can be
 * tested without triggering the buildTool initialization chain that
 * importing `opencc-src/tools/AgentTool/prompt.ts` pulls in (BashTool,
 * SendMessageTool, etc.). The shape produced here is part of the
 * model-facing contract — if it changes, registered providers become
 * invisible to the model.
 *
 * Returns an empty string when no providers are registered so the
 * caller can compose the description without a "registered: (none)"
 * placeholder that would itself be misleading.
 */
import type { SubagentRegistry } from './registry.js'

export function formatSubagentProviderSection(registry: SubagentRegistry): string {
  const names = registry.list()
  if (names.length === 0) return ''
  const lines = names.map((name) => {
    const provider = registry.getProvider(name)
    return provider ? `- ${provider.name}: ${provider.description}` : `- ${name}`
  })
  return `External subagent providers (route via \`subagent_type\`; each runs as an independent process and inherits no parent context):
${lines.join('\n')}`
}