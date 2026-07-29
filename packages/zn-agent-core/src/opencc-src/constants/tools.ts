// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import { feature } from 'bun:bundle'
import { TASK_OUTPUT_TOOL_NAME } from '../tools/TaskOutputTool/constants.ts'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from '../tools/ExitPlanModeTool/constants.ts'
import { ENTER_PLAN_MODE_TOOL_NAME } from '../tools/EnterPlanModeTool/constants.ts'
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.ts'
import { ASK_USER_QUESTION_TOOL_NAME } from '../tools/AskUserQuestionTool/prompt.ts'
import { TASK_STOP_TOOL_NAME } from '../tools/TaskStopTool/prompt.ts'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/constants.ts'
import { WEB_SEARCH_TOOL_NAME } from '../tools/WebSearchTool/prompt.ts'
import { TODO_WRITE_TOOL_NAME } from '../tools/TodoWriteTool/constants.ts'
import { GREP_TOOL_NAME } from '../tools/GrepTool/prompt.ts'
import { WEB_FETCH_TOOL_NAME } from '../tools/WebFetchTool/prompt.ts'
import { GLOB_TOOL_NAME } from '../tools/GlobTool/prompt.ts'
import { SHELL_TOOL_NAMES } from '../utils/shell/shellToolUtils.ts'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.ts'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/constants.ts'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../tools/NotebookEditTool/constants.ts'
import { SKILL_TOOL_NAME } from '../tools/SkillTool/constants.ts'
import { SEND_MESSAGE_TOOL_NAME } from '../tools/SendMessageTool/constants.ts'
import { TASK_CREATE_TOOL_NAME } from '../tools/TaskCreateTool/constants.ts'
import { TASK_GET_TOOL_NAME } from '../tools/TaskGetTool/constants.ts'
import { TASK_LIST_TOOL_NAME } from '../tools/TaskListTool/constants.ts'
import { TASK_UPDATE_TOOL_NAME } from '../tools/TaskUpdateTool/constants.ts'
import { TOOL_SEARCH_TOOL_NAME } from '../tools/ToolSearchTool/constants.ts'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../tools/SyntheticOutputTool/SyntheticOutputTool.ts'
import { ENTER_WORKTREE_TOOL_NAME } from '../tools/EnterWorktreeTool/constants.ts'
import { EXIT_WORKTREE_TOOL_NAME } from '../tools/ExitWorktreeTool/constants.ts'
import { WORKFLOW_TOOL_NAME } from '../tools/WorkflowTool/constants.ts'
import {
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
} from '../tools/ScheduleCronTool/constants.ts'

export const ALL_AGENT_DISALLOWED_TOOLS = new Set([
  TASK_OUTPUT_TOOL_NAME,
  EXIT_PLAN_MODE_V2_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  // Prevent recursive workflow execution inside subagents.
  WORKFLOW_TOOL_NAME,
])

export const CUSTOM_AGENT_DISALLOWED_TOOLS = new Set([
  ...ALL_AGENT_DISALLOWED_TOOLS,
])

/*
 * Async Agent Tool Availability Status (Source of Truth)
 */
export const ASYNC_AGENT_ALLOWED_TOOLS = new Set([
  FILE_READ_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  GREP_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  GLOB_TOOL_NAME,
  ...SHELL_TOOL_NAMES,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  SKILL_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
  ENTER_WORKTREE_TOOL_NAME,
  EXIT_WORKTREE_TOOL_NAME,
])
/**
 * Tools allowed only for in-process teammates (not general async agents).
 * These are injected by inProcessRunner.ts and allowed through filterToolsForAgent
 * via isInProcessTeammate() check.
 */
export const IN_PROCESS_TEAMMATE_ALLOWED_TOOLS = new Set([
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  // Teammate-created crons are tagged with the creating agentId and routed to
  // that teammate's pendingUserMessages queue (see useScheduledTasks.ts).
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
])

/*
 * BLOCKED FOR ASYNC AGENTS:
 * - AgentTool: Blocked to prevent recursion
 * - TaskOutputTool: Blocked to prevent recursion
 * - ExitPlanModeTool: Plan mode is a main thread abstraction.
 * - TaskStopTool: Requires access to main thread task state.
 * - TungstenTool: Uses singleton virtual terminal abstraction that conflicts between agents.
 *
 * ENABLE LATER (NEED WORK):
 * - MCPTool: TBD
 * - ListMcpResourcesTool: TBD
 * - ReadMcpResourceTool: TBD
 */

/**
 * Tools allowed in coordinator mode - only output and agent management tools for the coordinator
 */
export const COORDINATOR_MODE_ALLOWED_TOOLS = new Set([
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
  AGENT_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
])
