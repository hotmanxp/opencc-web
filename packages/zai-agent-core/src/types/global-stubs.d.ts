// Global type stubs for opencc-internals cross-module references
// This file provides minimal type declarations for modules that are
// imported by opencc-internals but don't exist in this package.

// Stub for bun:bundle
declare module 'bun:bundle' {
  export const VERSION: string;
}

// Stub for lodash-es/memoize
declare module 'lodash-es/memoize.js' {
  export default function memoize<T extends (...args: any[]) => any>(fn: T): T;
}

// Stub for figures
declare module 'figures' {
  export const tick: string;
  export const cross: string;
  export const info: string;
  export const warning: string;
}

// Stub for chalk
declare module 'chalk' {
  const chalk: {
    red: (s: string) => string;
    green: (s: string) => string;
    yellow: (s: string) => string;
    blue: (s: string) => string;
    dim: (s: string) => string;
    bold: (s: string) => string;
  };
  export default chalk;
}

// Stub for axios
declare module 'axios' {
  export default {};
}

// Stub for @anthropic-ai/sdk
declare module '@anthropic-ai/sdk' {
  export {};
}

// Stub for @anthropic-ai/sdk/resources/beta/messages/messages.mjs
declare module '@anthropic-ai/sdk/resources/beta/messages/messages.mjs' {
  export {};
}

// Stub for @anthropic-ai/sdk/resources/messages.mjs
declare module '@anthropic-ai/sdk/resources/messages.mjs' {
  export type ContentBlockParam = Record<string, unknown>;
}

// Common empty module stubs
declare module 'src/commands.js' {
  export const commands: Record<string, unknown>;
}

declare module 'src/utils/auth.js' {
  export {};
}

declare module 'src/utils/effort.js' {
  export {};
}

declare module 'src/utils/http.js' {
  export {};
}

declare module 'src/utils/messages.js' {
  export {};
}

declare module 'src/utils/proxy.js' {
  export {};
}

declare module 'src/utils/model/model.js' {
  export {};
}

declare module 'src/utils/model/providers.js' {
  export {};
}

declare module 'src/utils/model/modelStrings.js' {
  export {};
}

declare module 'src/utils/embeddedTools.js' {
  export {};
}

declare module 'src/services/analytics/growthbook.js' {
  export {};
}

declare module 'src/services/analytics/index.js' {
  export {};
}

declare module 'src/tools/GlobTool/prompt.js' {
  export {};
}

declare module 'src/tools/GrepTool/prompt.js' {
  export {};
}

declare module 'src/tools/AgentTool/built-in/exploreAgent.js' {
  export {};
}

declare module 'src/tools/AgentTool/builtInAgents.js' {
  export {};
}

// Path-based stubs for opencc-internals
declare module '../utils/git.js' {
  export const git: Record<string, unknown>;
}

declare module '../bootstrap/state.js' {
  export const state: Record<string, unknown>;
}

declare module '../utils/worktree.js' {
  export const worktree: Record<string, unknown>;
}

declare module '../utils/settings/settings.js' {
  export const settings: Record<string, unknown>;
}

declare module '../utils/settings/constants.js' {
  export const constants: Record<string, unknown>;
}

declare module '../utils/settings/types.js' {
  export const types: Record<string, unknown>;
}

declare module '../utils/model/providers.js' {
  export const providers: Record<string, unknown>;
}

declare module '../utils/model/agent.js' {
  export const agent: Record<string, unknown>;
}

declare module '../utils/model/aliases.js' {
  export const aliases: Record<string, unknown>;
}

declare module '../services/mcp/types.js' {
  export const types: Record<string, unknown>;
}

declare module '../services/analytics/growthbook.js' {
  export const growthbook: Record<string, unknown>;
}

declare module '../services/analytics/datadog.js' {
  export const datadog: Record<string, unknown>;
}

declare module '../services/analytics/firstPartyEventLogger.js' {
  export const logger: Record<string, unknown>;
}

declare module '../services/analytics/sinkKillswitch.js' {
  export const killswitch: Record<string, unknown>;
}

declare module '../oauth/auth-code-listener.js' {
  export const listener: Record<string, unknown>;
}

declare module '../oauth/crypto.js' {
  export const crypto: Record<string, unknown>;
}

declare module '../../constants.js' {
  export const AGENTS_INSTRUCTIONS_FILENAME = "AGENTS.md";
  export const AGENTS_INSTRUCTIONS_LOCAL_FILENAME = "AGENTS.local.md";
  export const AGENTS_FILENAME = "CLAUDE.md";
}

declare module '../../utils/combinedAbortSignal.js' {
  export const signal: Record<string, unknown>;
}

declare module '../../utils/teleport/api.js' {
  export const api: Record<string, unknown>;
}

declare module '../../components/CustomSelect/select.js' {
  export const select: Record<string, unknown>;
}

declare module '../../utils/permissions/PermissionMode.js' {
  export const mode: Record<string, unknown>;
}

declare module '../../utils/optionalRuntimeModule.js' {
  export const runtime: Record<string, unknown>;
}

declare module '../../utils/fsOperations.js' {
  export const fs: Record<string, unknown>;
}

declare module '../../utils/projectInstructions.js' {
  export const instructions: Record<string, unknown>;
}

declare module '../../utils/privacyLevel.js' {
  export const level: Record<string, unknown>;
}

declare module '../../utils/imageResizer.js' {
  export const resizer: Record<string, unknown>;
}

declare module '../../utils/imageValidation.js' {
  export const validation: Record<string, unknown>;
}

declare module '../claudeAiLimits.js' {
  export const limits: Record<string, unknown>;
}

declare module '../rateLimitMocking.js' {
  export const mocking: Record<string, unknown>;
}

declare module './openaiShim/index.js' {
  export const shim: Record<string, unknown>;
}

declare module '../oauth/auth-code-listener.js' {
  export const listener: Record<string, unknown>;
}

declare module '../oauth/crypto.js' {
  export const crypto: Record<string, unknown>;
}

declare module '../../utils/combinedAbortSignal.js' {
  export const signal: Record<string, unknown>;
}

declare module '../../utils/toolResultStorage.js' {
  export const storage: Record<string, unknown>;
}

declare module '../datadog.js' {
  export const datadog: Record<string, unknown>;
}

declare module '../firstPartyEventLogger.js' {
  export const logger: Record<string, unknown>;
}

declare module '../growthbook.js' {
  export const growthbook: Record<string, unknown>;
}

declare module '../sinkKillswitch.js' {
  export const killswitch: Record<string, unknown>;
}

declare module '../../utils/permissions/PermissionMode.js' {
  export const mode: Record<string, unknown>;
}

declare module '../../utils/model/agent.js' {
  export const agent: Record<string, unknown>;
}

declare module '../../utils/model/aliases.js' {
  export const aliases: Record<string, unknown>;
}

declare module '../../utils/model/providers.js' {
  export const providers: Record<string, unknown>;
}

declare module '../../utils/optionalRuntimeModule.js' {
  export const runtime: Record<string, unknown>;
}

declare module '../../utils/fsOperations.js' {
  export const fs: Record<string, unknown>;
}

declare module '../../utils/projectInstructions.js' {
  export const instructions: Record<string, unknown>;
}

declare module '../../utils/privacyLevel.js' {
  export const level: Record<string, unknown>;
}

declare module '../../utils/imageResizer.js' {
  export const resizer: Record<string, unknown>;
}

declare module '../../utils/imageValidation.js' {
  export const validation: Record<string, unknown>;
}

declare module '../../bootstrap/state.js' {
  export const state: Record<string, unknown>;
}

declare module './context.js' {
  export const context: Record<string, unknown>;
}

declare module './fastMode.js' {
  export const fastMode: Record<string, unknown>;
}

declare module './fpsTracker.js' {
  export const fps: Record<string, unknown>;
}

declare module './billing.js' {
  export const billing: Record<string, unknown>;
}

declare module './advisor.js' {
  export const advisor: Record<string, unknown>;
}

declare module './errors.js' {
  export const errors: Record<string, unknown>;
}

declare module './pasteStore.js' {
  export const store: Record<string, unknown>;
}

declare module './slowOperations.js' {
  export const ops: Record<string, unknown>;
}

declare module '../tools/AgentTool/constants.js' {
  export const constants: Record<string, unknown>;
}

declare module '../tools/FileWriteTool/prompt.js' {
  export const prompt: Record<string, unknown>;
}

declare module '../tools/FileWriteTool/constants.js' {
  export const constants: Record<string, unknown>;
}

declare module '../tools/FileReadTool/constants.js' {
  export const constants: Record<string, unknown>;
}

declare module '../tools/FileEditTool/constants.js' {
  export const constants: Record<string, unknown>;
}

declare module '../tools/TodoWriteTool/constants.js' {
  export const constants: Record<string, unknown>;
}

declare module '../tools/TaskCreateTool/constants.js' {
  export const constants: Record<string, unknown>;
}

declare module '../tools/BashTool/toolName.js' {
  export const toolName: string;
}

declare module '../tools/SkillTool/constants.js' {
  export const constants: Record<string, unknown>;
}

declare module '../tools/AskUserQuestionTool/prompt.js' {
  export const prompt: Record<string, unknown>;
}

declare module '../utils/prompts/sections/setTicketSection.js' {
  export const section: Record<string, unknown>;
}

declare module '../tools/REPLTool/constants.js' {
  export const constants: Record<string, unknown>;
}

declare module '../utils/betas.js' {
  export const betas: Record<string, unknown>;
}

declare module '../tools/AgentTool/forkSubagent.js' {
  export const fork: Record<string, unknown>;
}

declare module '../tools/SleepTool/prompt.js' {
  export const prompt: Record<string, unknown>;
}

declare module '../memdir/memdir.js' {
  export const memdir: Record<string, unknown>;
}

declare module '../utils/undercover.js' {
  export const undercover: Record<string, unknown>;
}

declare module '../utils/mcpInstructionsDelta.js' {
  export const delta: Record<string, unknown>;
}

declare module '../tools/BriefTool/prompt.js' {
  export const prompt: Record<string, unknown>;
}

declare module '../tools/BriefTool/BriefTool.js' {
  export const BriefTool: Record<string, unknown>;
}

declare module '../utils/permissions/filesystem.js' {
  export const fs: Record<string, unknown>;
}

declare module '../outputStyles/loadOutputStylesDir.js' {
  export const loader: Record<string, unknown>;
}

declare module '../utils/plugins/loadPluginOutputStyles.js' {
  export const loader: Record<string, unknown>;
}

declare module '../utils/codegraph.js' {
  export const codegraph: Record<string, unknown>;
}

declare module '../tools/TaskOutputTool/constants.js' {
  export const constants: Record<string, unknown>;
}

declare module '../tools/ExitPlanModeTool/constants.js' {
  export const constants: Record<string, unknown>;
}

declare module '../tools/EnterPlanModeTool/constants.js' {
  export const constants: Record<string, unknown>;
}

declare module '../tools/TaskStopTool/prompt.js' {
  export const prompt: Record<string, unknown>;
}

declare module '../tools/WebSearchTool/prompt.js' {
  export const prompt: Record<string, unknown>;
}

declare module '../tools/WebFetchTool/prompt.js' {
  export const prompt: Record<string, unknown>;
}

declare module '../tools/NotebookEditTool/constants.js' {
  export const constants: Record<string, unknown>;
}

declare module '../tools/TaskGetTool/constants.js' {
  export const constants: Record<string, unknown>;
}

declare module '../tools/TaskListTool/constants.js' {
  export const constants: Record<string, unknown>;
}

declare module '../tools/TaskUpdateTool/constants.js' {
  export const constants: Record<string, unknown>;
}

declare module '../tools/ToolSearchTool/constants.js' {
  export const constants: Record<string, unknown>;
}

declare module '../tools/SyntheticOutputTool/SyntheticOutputTool.js' {
  export const tool: Record<string, unknown>;
}

declare module '../tools/EnterWorktreeTool/constants.js' {
  export const constants: Record<string, unknown>;
}

declare module '../tools/ExitWorktreeTool/constants.js' {
  export const constants: Record<string, unknown>;
}

declare module '../tools/WorkflowTool/constants.js' {
  export const constants: Record<string, unknown>;
}

declare module '../tools/ScheduleCronTool/constants.js' {
  export const constants: Record<string, unknown>;
}

declare module '../utils/shell/shellToolUtils.js' {
  export const utils: Record<string, unknown>;
}

declare module '../tools/SendMessageTool/constants.js' {
  export const constants: Record<string, unknown>;
}

declare module '../../utils/workloadContext.js' {
  export const context: Record<string, unknown>;
}

declare module '../workloadContext.js' {
  export const context: Record<string, unknown>;
}
