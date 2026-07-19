/**
 * Shared context passed to every section compute fn.
 *
 * Carries the runtime metadata each section needs without making
 * sections depend on `RuntimeConfig` (which pulls in MCP / plugin
 * types — too heavy for a section compute).
 *
 * Sections that need richer config (e.g. skills, MCP) read from
 * `config` directly via the QueryLoop-time wrapper, not via this
 * context — see `getSkillsSection`, `getMcpInstructionsSection`.
 */

import type { MCPServerConnectionLike } from '../../mcp/mcpInstructions.js'
import type { LoadedSkill } from '../../runtime/skills/types.js'

export type SectionComputeContext = {
  /** Current model id (e.g. "claude-sonnet-4-6"). Drives env_info cache key. */
  model: string
  /** Per-request override flag for AGENTS.md / .claude/rules injection. */
  enableAgentsMd: boolean
  /** Cwd for memory loading. */
  cwd: string
}

export type SectionExtraContext = {
  mcpClients?: MCPServerConnectionLike[]
  skills?: LoadedSkill[]
  dataDir?: string
}