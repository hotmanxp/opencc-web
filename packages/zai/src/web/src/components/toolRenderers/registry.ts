import type { ToolRenderer } from "./types.js"
import { bashRenderer } from "./bash.js"
import { genericRenderer } from "./generic.js"
import { globRenderer } from "./glob.js"
import { grepRenderer } from "./grep.js"
import { readRenderer } from "./read.js"
import { agentRenderer } from "./agent.js"
import { diffRenderer } from "./diff.js"
import { mcpRenderer, isMcpToolName } from "./mcp.js"

const registry: Record<string, ToolRenderer> = {
  Agent: agentRenderer,
  Bash: bashRenderer,
  // Edit / Write 走 DiffBlock 一体渲染 (整接管 renderFull), 不再各自写输入/输出.
  Edit: diffRenderer,
  Glob: globRenderer,
  Grep: grepRenderer,
  Read: readRenderer,
  Write: diffRenderer,
}

export function setRenderer(name: string, renderer: ToolRenderer): void {
  registry[name] = renderer
}

export function getRenderer(name: string): ToolRenderer {
  // MCP 工具名 (mcp_<server>_<action>) 走专用 renderer — MCP 工具集是用户/服务端
  // 动态注入的, 用前缀路由避免为每一个静态注册. 不在静态 registry 里占坑.
  if (isMcpToolName(name)) return mcpRenderer
  return registry[name] ?? genericRenderer
}

export function _renderersForTest(): Readonly<Record<string, ToolRenderer>> {
  return registry
}
