/**
 * opencc-src/tools/index.ts — barrel re-export of vendor built-in tools.
 *
 * zai's compat/tools/opencc/builtin.ts imports each tool individually via
 * `from '.../opencc-src/tools/<Name>/<Name>.js'` (relative path). After
 * we switch to the bundled opencc-core.mjs, those paths no longer exist
 * (Bun collapses everything into a single file). This barrel re-exports
 * the 11 built-in tools so the bridge can destructure them from
 * `mod.BashTool`, `mod.FileReadTool`, etc. when consuming the bundle.
 *
 * Important: this file must be reachable from query.ts (the bundle's
 * entrypoint) or Bun's tree-shaker drops it. query.ts has a side-effect
 * `import './tools/index.js'` near the top to force inclusion.
 */
export { BashTool } from './BashTool/BashTool.js'
export { FileReadTool } from './FileReadTool/FileReadTool.js'
export { FileEditTool } from './FileEditTool/FileEditTool.js'
export { FileWriteTool } from './FileWriteTool/FileWriteTool.js'
export { GlobTool } from './GlobTool/GlobTool.js'
export { GrepTool } from './GrepTool/GrepTool.js'
export { AgentTool } from './AgentTool/AgentTool.js'
export { BackgroundAgentResultTool } from './BackgroundAgentResultTool/BackgroundAgentResultTool.js'
export { TaskOutputTool } from './TaskOutputTool/TaskOutputTool.js'
export { WebFetchTool } from './WebFetchTool/WebFetchTool.js'
export { WebSearchTool } from './WebSearchTool/WebSearchTool.js'