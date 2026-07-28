// MCP client pool + related compat shims (Batch 2b).
//
// Public surface re-exported through `@zn-ai/zn-agent-core` root.

export type { McpServerSpec } from './types.js'
export type { ToolRule } from './permission-matcher.js'
export { matchToolName } from './permission-matcher.js'
export { injectAuth, createMcpTransport } from './transport.js'
export { McpServerError, formatMcpError } from './errors.js'
export type { McpServerErrorContext } from './errors.js'
export { makeMcpToolName, parseMcpToolName, MAX_MCP_DESCRIPTION_LENGTH } from './tool-name.js'
export { jsonSchemaToZod } from './jsonSchemaToZod.js'
export { getMcpInstructionsSection } from './mcpInstructions.js'
export type { MCPServerConnectionLike } from './mcpInstructions.js'
export { MCPClientPool } from './MCPClientPool.js'
export { adaptMcpTools } from './MCPToolAdapter.js'
export type { MCPToolInfo } from './MCPToolAdapter.js'
export { parseSkillResource, loadMcpSkills } from './SkillResourceAdapter.js'
export type { SkillResource, LoadedSkillFromMcp } from './SkillResourceAdapter.js'