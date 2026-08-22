import type { ToolRenderer } from "./types.js"
import { bashRenderer } from "./bash.js"
import { genericRenderer } from "./generic.js"
import { globRenderer } from "./glob.js"
import { grepRenderer } from "./grep.js"
import { readRenderer } from "./read.js"
import { agentRenderer } from "./agent.js"
import { diffRenderer } from "./diff.js"
import { fileDisplayRenderer } from "./fileDisplay.js"
import { mcpRenderer, isMcpToolName } from "./mcp.js"

const registry: Record<string, ToolRenderer> = {
  Agent: agentRenderer,
  Bash: bashRenderer,
  DisplayFiles: fileDisplayRenderer,
  // Edit / Write 走 DiffBlock 一体渲染 (整接管 renderFull), 不再各自写输入/输出.
  Edit: diffRenderer,
  // dsh 内核别名 — 工具名对齐 dsh-bridge defineTool().name.
  // dsh fs 工具在 packages/dsh-bridge/src/tools/fs.ts 用 FileRead/FileWrite/FileEdit,
  // 字段名与 opencc Read/Write/Edit 完全一致 (file_path/old_string/new_string/content
  // /offset/limit), 这里只需名字映射到现有 renderer.
  FileEdit: diffRenderer,
  FileRead: readRenderer,
  FileWrite: diffRenderer,
  Glob: globRenderer,
  Grep: grepRenderer,
  Read: readRenderer,
  // dsh 用 Ripgrep (packages/dsh-bridge/src/tools/ripgrep.ts), 字段名 ignore_case
  // /max_results/file_type 与 opencc Grep 的 ignore_case/output_mode/context/glob
  // 不完全一致 — P1 留作后续, 这里先让 grepRenderer 接管, 避免降级到 generic.
  Ripgrep: grepRenderer,
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
