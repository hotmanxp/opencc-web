/**
 * Tool registry for zai-agent-core runtime.
 *
 * Breaks the queryEngine ↔ tools cycle via dynamic import.
 */
import { BashTool } from './BashTool/BashTool.js'
import { AgentTool } from './AgentTool/AgentTool.js'
import { FileReadTool } from './FileReadTool/FileReadTool.js'
import { FileWriteTool } from './FileWriteTool/FileWriteTool.js'
import { FileEditTool } from './FileEditTool/FileEditTool.js'
import { GlobTool } from './GlobTool/GlobTool.js'
import { GrepTool } from './GrepTool/GrepTool.js'
import { AskUserQuestionTool } from './AskUserQuestionTool/AskUserQuestionTool.js'
import { ListMcpResourcesTool } from './ListMcpResourcesTool/ListMcpResourcesTool.js'
import { ReadMcpResourceTool } from './ReadMcpResourceTool/ReadMcpResourceTool.js'
import { BackgroundAgentTool } from './BackgroundAgentTool/BackgroundAgentTool.js'
import { BackgroundAgentResultTool } from './BackgroundAgentResultTool/BackgroundAgentResultTool.js'
import { TaskCreateTool } from './TaskCreateTool/TaskCreateTool.js'
import { TodoWriteTool } from './TodoWriteTool/TodoWriteTool.js'
import { TaskListTool } from './TaskListTool/TaskListTool.js'
import { TaskGetTool } from './TaskGetTool/TaskGetTool.js'
import { TaskUpdateTool } from './TaskUpdateTool/TaskUpdateTool.js'
import { TaskOutputTool } from './TaskOutputTool/TaskOutputTool.js'
import { TaskStopTool } from './TaskStopTool/TaskStopTool.js'
import { wrapAsOpenccTool } from './legacyAdapter.js'
import type { Tool } from './Tool.js'

export function getZaiRuntimeTools(): Tool[] {
  // Each legacy tool is wrapped in the opencc-internals Tool shape via
  // `wrapAsOpenccTool`. See `legacyAdapter.ts` for the field-mapping rationale.
  return [
    wrapAsOpenccTool(BashTool),
    wrapAsOpenccTool(AgentTool),
    wrapAsOpenccTool(FileReadTool),
    wrapAsOpenccTool(FileWriteTool),
    wrapAsOpenccTool(FileEditTool),
    wrapAsOpenccTool(GlobTool),
    wrapAsOpenccTool(GrepTool),
    wrapAsOpenccTool(AskUserQuestionTool),
    wrapAsOpenccTool(ListMcpResourcesTool),
    wrapAsOpenccTool(ReadMcpResourceTool),
    wrapAsOpenccTool(BackgroundAgentTool),
    wrapAsOpenccTool(BackgroundAgentResultTool),
    wrapAsOpenccTool(TaskCreateTool),
    wrapAsOpenccTool(TodoWriteTool),
    wrapAsOpenccTool(TaskListTool),
    wrapAsOpenccTool(TaskGetTool),
    wrapAsOpenccTool(TaskUpdateTool),
    wrapAsOpenccTool(TaskOutputTool),
    wrapAsOpenccTool(TaskStopTool),
  ]
}
