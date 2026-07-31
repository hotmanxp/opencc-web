/**
 * openccBuiltin — direct passthrough of opencc vendor's built-in tools.
 *
 * The previous `defaultCoreToolsAsOpencc()` returned 5 zai-side tool
 * implementations wrapped as opencc Tool interface (~5 files, ~600 LOC
 * of wrapper code). This file is a much smaller alternative: import
 * opencc's own built-in tools and pass them through directly.
 *
 * Strategy: use opencc's built-in for 6 tools (Bash/Read/Edit/
 * Write/Glob/Grep). AskUserQuestion stays as a zai wrapper because
 * zai has its own AskRegistry integration (POST /api/agent/answer)
 * that's incompatible with opencc's default behavior (which assumes
 * in-process interactive prompt).
 *
 * Lazy imports throughout — tsc is configured to exclude
 * src/opencc-src/, so the import paths can't be statically
 * type-checked. They resolve fine at runtime under Bun + the
 * bridge (opencc-src is loaded by the bridge before this function
 * is called).
 */

import { wrapAskUserQuestionToolAsOpencc } from './AskUserQuestionTool.js'
import { wrapTaskToolsAsOpencc } from './TaskTools.js'
import { wrapSkillToolAsOpencc } from './SkillTool.js'

export type OpenccBuiltinTool = any

let cachedTools: OpenccBuiltinTool[] | null = null

export async function getOpenccBuiltinTools(): Promise<OpenccBuiltinTool[]> {
  if (cachedTools) return cachedTools

  // Helper: dynamically import a single opencc tool module. We use
  // `// @ts-ignore` because tsconfig excludes `src/opencc-src`
  // from this project's file list, so tsc would refuse to resolve
  // the import path. At runtime under Bun, the path resolves via
  // the bridge's opencc-src/ import graph.
  const dyn = (path: string): Promise<any> =>
    // @ts-ignore — opencc-src is outside the tsconfig project
    import(/* @vite-ignore */ path)

  const [
    { BashTool },
    { FileReadTool },
    { FileEditTool },
    { FileWriteTool },
    { GlobTool },
    { GrepTool },
    { AgentTool },
    { BackgroundAgentResultTool },
    { TaskOutputTool },
    { WebFetchTool },
    { WebSearchTool },
  ] = await Promise.all([
    dyn('../../../opencc-src/tools/BashTool/BashTool.js'),
    dyn('../../../opencc-src/tools/FileReadTool/FileReadTool.js'),
    dyn('../../../opencc-src/tools/FileEditTool/FileEditTool.js'),
    dyn('../../../opencc-src/tools/FileWriteTool/FileWriteTool.js'),
    dyn('../../../opencc-src/tools/GlobTool/GlobTool.js'),
    dyn('../../../opencc-src/tools/GrepTool/GrepTool.js'),
    dyn('../../../opencc-src/tools/AgentTool/AgentTool.js'),
    dyn('../../../opencc-src/tools/BackgroundAgentResultTool/BackgroundAgentResultTool.js'),
    dyn('../../../opencc-src/tools/TaskOutputTool/TaskOutputTool.js'),
    dyn('../../../opencc-src/tools/WebFetchTool/WebFetchTool.js'),
    dyn('../../../opencc-src/tools/WebSearchTool/WebSearchTool.js'),
  ])

  // AskUserQuestion uses zai's wrapper because zai-server has its own
  // AskRegistry that intercepts the tool's `ask_pending` event and
  // waits for the user to POST /api/agent/answer. opencc's default
  // AskUserQuestion assumes an in-process interactive prompt which
  // doesn't fit zai's HTTP-driven flow. `bridgeCtx` is set at call
  // time by the bridge (see runViaOpenccQuery); it's `{ sessionId,
  // askRegistry, onYield }` so the wrapper can construct zai's
  // ToolCallCtx.
  const AskUserQuestionOpencc = wrapAskUserQuestionToolAsOpencc(
    (globalThis as any).__zaiBridgeCtx ?? {},
  )

  // 4 个 Task 工具 (TaskCreate / TaskGet / TaskUpdate / TaskList) 接
  // compat/tools/tasks/ 的 zai-native 实现,通过 wrapTaskToolsAsOpencc
  // 适配成 opencc Tool 接口。它们取代 opencc vendor 自带的 TodoWrite 工具,
  // 走 zai 的 TaskListStore 持久化 + stateChangeBus → SSE v2_task.changed 路径。
  const taskToolsOpencc = wrapTaskToolsAsOpencc()

  // Skill 走 zai-native wrapper (vendor 的 SkillTool 是 Bun-only,
  // 不能在 Node+tsx 下跑;zai-native skillTool 已处理 ctx.skills +
  // ZAI_SKILL_DIRS fallback,Node-safe).
  const skillToolsOpencc = wrapSkillToolAsOpencc()

  cachedTools = [
    BashTool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    GlobTool,
    GrepTool,
    AskUserQuestionOpencc,
    ...taskToolsOpencc,
    ...skillToolsOpencc,
    AgentTool,
    BackgroundAgentResultTool,
    TaskOutputTool,
    WebFetchTool,
    WebSearchTool,
  ]
  return cachedTools
}