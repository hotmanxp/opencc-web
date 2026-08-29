import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { CODE_REVIEWER_AGENT } from './built-in/codeReviewerAgent.js'
import { EXPLORE_AGENT } from './built-in/exploreAgent.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'
import { PLAN_AGENT } from './built-in/planAgent.js'
import { getCoordinatorAgents } from '../../coordinator/workerAgent.js'
import type { AgentDefinition } from './loadAgentsDir.js'

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
    CODE_REVIEWER_AGENT,
    // STATUSLINE_SETUP_AGENT, // commented out - not used in zai
  ]

  if (areExplorePlanAgentsEnabled()) {
    agents.push(EXPLORE_AGENT, PLAN_AGENT)
  }

  // // Include Code Guide agent for non-SDK entrypoints
  // const isNonSdkEntrypoint =
  //   process.env.CLAUDE_CODE_ENTRYPOINT !== 'sdk-ts' &&
  //   process.env.CLAUDE_CODE_ENTRYPOINT !== 'sdk-py' &&
  //   process.env.CLAUDE_CODE_ENTRYPOINT !== 'sdk-cli'
  //
  // if (isNonSdkEntrypoint) {
  //   agents.push(CLAUDE_CODE_GUIDE_AGENT)
  // }

  return agents
}

// @ts-ignore — fork has no verificationAgent import (AGENTS.md "removed
// providers" / "fork-only" policy); upstream PR #2102 includes it here.
// Re-enable when porting verificationAgent.
const BUILT_IN_AGENT_TYPES = new Set([
  GENERAL_PURPOSE_AGENT.agentType,
  CODE_REVIEWER_AGENT.agentType,
  EXPLORE_AGENT.agentType,
  PLAN_AGENT.agentType,
])

export function isBuiltInAgentType(agentType: string): boolean {
  return BUILT_IN_AGENT_TYPES.has(agentType)
}
