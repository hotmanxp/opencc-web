export { queryLoop as query } from './queryLoop.js'
export { abortSession } from './abort.js'
export { DefaultAgentRuntime } from './contract.js'
export type { AgentRuntime } from './contract.js'
export type { RuntimeConfig, QueryOptions, ModelCaller, AskRegistryLike, ApproveRegistryLike, SandboxConfig } from './types.js'
export { PERMISSION_MODES, EXTERNAL_PERMISSION_MODES } from './permissionMode.js'
export type { PermissionMode, UserFacingPermissionMode } from './permissionMode.js'
export type { RuntimeEvent, RuntimeErrorEvent, RuntimeDoneEvent, RuntimeAbortedEvent, ErrorCategory } from './events.js'
export { wrapWithZaiMeta, toRuntimeErrorEvent, toAbortedEvent } from './streamAdapter.js'
export { TranscriptStore } from '../transcript/store.js'
export { repairAndPersistTranscript } from '../transcript/repair.js'
export type { TranscriptRepairReport, TranscriptRepairResult } from '../transcript/repair.js'
export { resolveDataDir } from '../data/dataDir.js'
export type { DataDirConfig } from '../data/dataDir.js'
export type { TranscriptFile, TranscriptMessage, TranscriptMeta } from '../transcript/types.js'
export { loadMemoryForPrompt, clearMemoryCache, hasExternalIncludes } from '../agents/memoryLoader.js'
export type { MemoryFile } from '../agents/memoryLoader.js'
export { startMemoryWatcher, stopMemoryWatcher } from '../agents/memoryWatcher.js'
export type { MemoryWatcherHandle } from '../agents/memoryWatcher.js'
export { loadSkillsFromDirs } from './skills/index.js'
export type { LoadSkillsOptions, LoadedSkill, PendingSkillInjection, SkillFrontmatter } from './skills/index.js'
export type { AskUserAnswers, AskUserRequest } from '../tools/Tool.js'
export { AskUserQuestionTool, ASK_USER_QUESTION_TOOL_NAME, DESCRIPTION as ASK_USER_QUESTION_TOOL_DESCRIPTION, ASK_USER_QUESTION_TOOL_PROMPT } from '../tools/AskUserQuestionTool/AskUserQuestionTool.js'
export type { Question, QuestionOption } from '../tools/AskUserQuestionTool/schema.js'
export { MCPClientPool } from '../mcp/MCPClientPool.js'
export type { McpServerSpec } from '../mcp/types.js'
export type {
  PluginSourceName,
  PluginComponent,
  PluginManifest,
  PluginCandidate,
  LoadedPlugin,
  PluginHook,
  PluginLoadError,
  PluginCandidateResult,
  HookExecutor,
  PluginRuntimeConfig,
  PluginSnapshot,
  PluginRuntime,
} from '../plugins/types.js'
export { emptyPluginSnapshot } from '../plugins/types.js'
export {
  resolveOpenccConfigDir,
  resolveOpenccPluginsDir,
  resolveZaiPluginsDir,
} from '../plugins/paths.js'
export type { ResolveOpenccConfigDirOptions, ResolveZaiPluginsDirOptions } from '../plugins/paths.js'
export { HookRunner, DEFAULT_HOOK_TIMEOUT_MS } from '../plugins/HookRunner.js'
export type { HookRunResult } from '../plugins/HookRunner.js'
export { createDefaultHookExecutor } from '../plugins/defaultHookExecutor.js'
export { DefaultPluginRuntime, PluginRegistry } from '../plugins/index.js'

// /compact 命令 service (zai 自实现, 干净路径, 不接 opencc-internals/)
export { compactSession } from './compactService.js'
export type { CompactSessionOptions, CompactSessionResult } from './compactService.js'

// 后台任务运行时 (Phase 1 + Phase 2)
export * from './background/index.js'

// Per-session cwd tracking (zai LLM-self-cwd-switch feature)
export { CwdStore, type SessionCwd } from './cwdStore.js'
export { runWithSessionId, getCurrentSessionId } from '../opencc-internals/utils/cwd.js'

// System-prompt subsystem (zai-native port of opencc's getSystemPrompt)
// Hosts compose the system prompt for each query by calling
// `buildEffectiveSystemPrompt` with a list of sections. Most sections
// are memoized across turns; the section registry resets on /clear
// and /compact. See `systemPrompt/section.ts` for cache semantics.
export {
  type SystemPrompt,
  asSystemPrompt,
  type BuildSystemPromptInput,
  buildSystemPrompt,
  type BuildEffectiveSystemPromptInput,
  buildEffectiveSystemPrompt,
  DEFAULT_STATIC_INTRO,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  systemPromptSection,
  DANGEROUS_uncachedSystemPromptSection,
  clearSystemPromptSections,
  resolveScratchpadDir,
  isScratchpadEnabled,
} from '../systemPrompt/index.js'

// State change bus (in-process event for zai server SSE bridge)
export { stateChangeBus, resetStateChangeBusForTests } from './stateChangeBus.js'
export type { StateChangeEventMap } from './stateChangeBus.js'
