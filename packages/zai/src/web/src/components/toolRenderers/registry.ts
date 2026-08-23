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
import { structuredGrepRenderer, structuredGlobRenderer } from "./search.js"

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
  // Phase 5P2 (上游 dsh-tool-fs):model-facing 工具名是小写 `read` / `write`
  // / `edit`(见 packages/fs/tool-fs/src/index.ts)。字段 schema 与 zai 自实现
  // FileRead/FileWrite/FileEdit + opencc Read/Write/Edit 等价,渲染直接复用
  // 现有 readRenderer / diffRenderer (Phase 3A 零破坏)。
  read: readRenderer,
  write: diffRenderer,
  edit: diffRenderer,
  // Phase 5P3 (上游 dsh-tool-bash):model-facing 工具名是小写 `bash`
  // (见 packages/shell/tool-bash/src/index.ts)。input 字段是
  // { command, description, timeoutMs, workdir, run_in_background,
  //   sandbox_permissions?, justification? } — 与 zai-side 自实现的
  // `Bash` { command, description, timeout, run_in_background } 子集
  // (上游多了 workdir/sandbox_permissions/justification,zai 接受未知字段),
  // 渲染直接复用现有 bashRenderer。output 是上游 render() 产出的文本
  // (stdout + [stderr] + [exit code: N]),stringFromOutput 拍平后 parseBashOutput
  // 走 plain 路径 — 不区分 stdout/stderr 颜色,但可读性 OK (上游格式).
  bash: bashRenderer,
  // Phase 5P6 (上游 dsh-tool-subagent):model-facing 工具名是小写 `subagent`
  // (见 packages/subagent/tool-subagent/src/index.ts,toolName 配置默认 'subagent')。
  // input 字段 { description, prompt, subagent_type?, model?, run_in_background?, isolation? }
  // 与 zai-side `Agent` 几乎一致 — 渲染复用 agentRenderer。
  subagent: agentRenderer,
  // Phase 4 P1: harness `@deepseek-ai/dsh-tool-fs-search` 注册的小写
  // `grep` / `glob` 工具名 — 走结构化 renderer, 读 dsh `tool/result.meta`
  // 渲染按文件分组的 matches 卡片 / 路径列表 + 截断提示。meta 缺失时降级到
  // stringFromOutput 文本路径（renderer 内部 fallback）。
  grep: structuredGrepRenderer,
  glob: structuredGlobRenderer,
  // 旧 opencc-cli / dsh-bridge 自实现工具名 — 保留 grepRenderer (文本路径)
  // 不破坏既有 transcript 历史与回归测试。
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
