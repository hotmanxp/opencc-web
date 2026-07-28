// src/tools/WorkflowTool/constants.ts

export const WORKFLOW_TOOL_NAME = 'WorkflowTool'

/** Default limits — overridable via env vars (see below) */
export const WORKFLOW_DEFAULTS = {
  maxConcurrentAgents: 16,
  maxTotalAgents: 1000,
  defaultTimeoutMs: 30 * 60 * 1000,  // 30 min
} as const

/** Env vars (workflows are opt-in via OPENCC_ENABLE_WORKFLOWS, not kill-switched) */
export const WORKFLOW_ENV = {
  ENABLE: 'OPENCC_ENABLE_WORKFLOWS',
  TIMEOUT_MS: 'OPENCC_WORKFLOW_TIMEOUT_MS',
  MAX_AGENTS: 'OPENCC_WORKFLOW_MAX_AGENTS',
  KEYWORD: 'OPENCC_WORKFLOW_KEYWORD',  // custom trigger word (default: 'ultracode')
} as const
