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
import type { Tool } from './Tool.js'

export function getZaiRuntimeTools(): Tool[] {
  return [
    BashTool,
    AgentTool,
    FileReadTool,
    FileWriteTool,
    FileEditTool,
    GlobTool,
    GrepTool,
    AskUserQuestionTool,
    ListMcpResourcesTool,
    ReadMcpResourceTool,
  ]
}
