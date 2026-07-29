import { getIsNonInteractiveSession } from '../../bootstrap/state.ts'
import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js'
import { isEnvTruthy } from '../../utils/envUtils.ts'
import { CLAUDE_CODE_GUIDE_AGENT } from './built-in/claudeCodeGuideAgent.ts'
import { EXPLORE_AGENT } from './built-in/exploreAgent.ts'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.ts'
import { PLAN_AGENT } from './built-in/planAgent.ts'
import { STATUSLINE_SETUP_AGENT } from './built-in/statuslineSetup.ts'
import { getCoordinatorAgents } from '../../coordinator/workerAgent.js'
import type { AgentDefinition } from './loadAgentsDir.ts'

export function areExplorePlanAgentsEnabled(): boolean {
  // Always enable Explore/Plan agents in opencc
  return true
}

export function getBuiltInAgents(): AgentDefinition[] {
  // Allow disabling all built-in agents via env var (useful for SDK users who want a blank slate)
  // Only applies in noninteractive mode (SDK/API usage)
  if (
    isEnvTruthy(process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS) &&
    getIsNonInteractiveSession()
  ) {
    return []
  }

  // Enable worker agent via env var in opencc
  if (isCoordinatorMode()) {
    return getCoordinatorAgents()
    
  }

  const agents: AgentDefinition[] = [
    GENERAL_PURPOSE_AGENT,
    STATUSLINE_SETUP_AGENT,
  ]

  if (areExplorePlanAgentsEnabled()) {
    agents.push(EXPLORE_AGENT, PLAN_AGENT)
  }

  // Include Code Guide agent for non-SDK entrypoints
  const isNonSdkEntrypoint =
    process.env.CLAUDE_CODE_ENTRYPOINT !== 'sdk-ts' &&
    process.env.CLAUDE_CODE_ENTRYPOINT !== 'sdk-py' &&
    process.env.CLAUDE_CODE_ENTRYPOINT !== 'sdk-cli'

  if (isNonSdkEntrypoint) {
    agents.push(CLAUDE_CODE_GUIDE_AGENT)
  }

  return agents
}
