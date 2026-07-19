/**
 * Available agents section.
 *
 * Renders the set of agents the model can delegate to via AgentTool.
 * Returns null when there are no agents to advertise (e.g. base
 * tool pool without sub-agent support).
 *
 * Section is cached by agent-type list — adding/removing agents
 * flips the cache key.
 */

import { loadAgentDefinitions } from '../../tools/AgentTool/loadAgentsDir.js'
import { renderAvailableAgentsSection } from '../../tools/AgentTool/prompt.js'
import { systemPromptSection } from '../section.js'

export function getAvailableAgentsSection(opts: {
  dataDir?: string
  userAgentsDir?: string
  pluginAgents?: ReadonlyArray<unknown>
}) {
  return systemPromptSection(
    `available_agents:${opts.dataDir ?? 'none'}:${opts.userAgentsDir ?? 'none'}`,
    async () => {
      if (!opts.dataDir) return null
      try {
        const { agents } = await loadAgentDefinitions(
          opts.dataDir,
          opts.userAgentsDir,
          undefined,
          opts.pluginAgents as never,
        )
        if (agents.length === 0) return null
        return renderAvailableAgentsSection(agents)
      } catch {
        return null
      }
    },
  )
}