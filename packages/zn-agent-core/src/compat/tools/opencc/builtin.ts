/**
 * openccBuiltin — direct passthrough of opencc vendor's built-in tools.
 *
 * Pulls tools from the bundled `dist/opencc-core.mjs` (which re-exports
 * them from `src/opencc-src/tools/index.ts`). Single import, no
 * per-tool dynamic imports of the (no longer shipped) per-file paths.
 *
 * zai patches on top of passthrough:
 *   - BashTool.checkPermissions is overridden to always return
 *     `{behavior:'allow', ...}`. The vendor permission system has
 *     multiple bypass-immune layers (permissions.ts step 1e/1f/1g for
 *     `requiresUserInteraction` / content-specific ask rules /
 *     safety-check paths) that still fire even when the mode is
 *     `bypassPermissions`. zai's HTTP server has no in-process UI
 *     to answer a permission dialog, so any one of these layers
 *     returning a non-allow decision causes vendor's classifier /
 *     permission chain to keep re-firing — and after 5 consecutive
 *     same-errorCategory failures (toolFailureLoopGuard in
 *     packages/zn-agent-core/src/opencc-src/query/query.ts:2456)
 *     vendor seeds the LLM with "The user doesn't want to take this
 *     action right now. STOP...", hard-stopping the conversation.
 *     Short-circuiting the entry point is the only reliable way to
 *     guarantee no permission checks fire on the runtime path.
 *
 * AskUserQuestion stays as a zai wrapper because zai has its own
 * AskRegistry integration (POST /api/agent/answer) that's incompatible
 * with opencc's default behavior (which assumes in-process interactive
 * prompt).
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { wrapAskUserQuestionToolAsOpencc } from './AskUserQuestionTool.js'
import { wrapTaskToolsAsOpencc } from './TaskTools.js'
import { wrapSkillToolAsOpencc } from './SkillTool.js'

export type OpenccBuiltinTool = any

// Same bundle as openccQueryBridge.ts. Imported via the package's
// `./opencc-core` subpath export so we don't depend on the relative
// layout of dist/ subdirs.
const BUNDLE_URL = '@zn-ai/zn-agent-core/opencc-core'

/**
 * zai patch: overwrite `tool.checkPermissions` on the live vendor Tool
 * object with a guaranteed-allow implementation. See the module-level
 * comment + getOpenccBuiltinTools() call site for the rationale
 * (toolFailureLoopGuard STOP message after 5 consecutive denials).
 *
 * Direct mutation rather than `{...tool, checkPermissions}` so that
 * any downstream reference vendor holds to the same tool identity
 * (cached in toolUseContext.options.tools, ToolRegistry, etc.) sees
 * the override.
 *
 * @param tool  Vendor tool object — mutated in place.
 */
export function forceAllowCheckPermissions(tool: {
  checkPermissions?: unknown
  [k: string]: unknown
}): void {
  Object.defineProperty(tool, 'checkPermissions', {
    configurable: true,
    writable: true,
    value: async function checkPermissions(input: unknown) {
      return {
        behavior: 'allow' as const,
        updatedInput: input,
        decisionReason: {
          type: 'mode' as const,
          mode: 'bypassPermissions' as const,
        },
      }
    },
  })
}

let cachedTools: OpenccBuiltinTool[] | null = null

export async function getOpenccBuiltinTools(): Promise<OpenccBuiltinTool[]> {
  if (cachedTools) return cachedTools

  // Verify the resolved path is on disk. import.meta.resolve returns
  // a file:// URL when the target exists; otherwise it throws. We
  // pre-flight the resolve so the error points to the build step
  // rather than a deep "Cannot find module" from Node's resolver.
  try {
    const url = (await import.meta.resolve?.(BUNDLE_URL)) ?? BUNDLE_URL
    if (url.startsWith('file://') && !existsSync(fileURLToPath(url))) {
      throw new Error('bundle path does not exist on disk')
    }
  } catch {
    throw new Error(
      `[openccBuiltin] cannot resolve ${BUNDLE_URL}. ` +
      `Run \`pnpm --filter @zn-ai/zn-agent-core build\` to (re)generate the bundle.`,
    )
  }
  // The bundle re-exports the 11 built-in tools at top level
  // (see src/opencc-src/query.ts re-export block + tools/index.ts).
  const bundle = (await import(/* @vite-ignore */ BUNDLE_URL as any)) as any
  const {
    BashTool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    GlobTool,
    GrepTool,
    AgentTool,
    BackgroundAgentResultTool,
    TaskOutputTool,
    WebFetchTool,
    WebSearchTool,
  } = bundle

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

  // zai patch: short-circuit every vendor tool's checkPermissions to
  // always allow. See the module-level comment above for the root
  // cause (toolFailureLoopGuard STOP message after 5 consecutive
  // same-errorCategory denials). Wrapping with `wrapWithOverrides`
  // spread a new object, but vendor queryLoop receives the original
  // tool object via the `toolUseContext.options.tools` array — if any
  // downstream resolver (e.g. tool search, ToolRegistry) caches the
  // pre-wrap tool reference, the override doesn't take effect. Direct
  // mutation `tool.checkPermissions = ...` writes to the same object
  // identity vendor uses everywhere, so this hook is bullet-proof
  // regardless of where vendor caches the tool.
  //
  // vendor Tool.ts:820 `buildTool` returns `{...TOOL_DEFAULTS, ...def}`
  // — a plain object, no Object.freeze, so writable properties are
  // always settable on the returned tool references. We use
  // Object.defineProperty with `configurable:true, writable:true` for
  // defense-in-depth in case a future vendor patch freezes the tool.
  //
  // The override mirrors vendor Tool.ts:794 TOOL_DEFAULTS shape: input
  // echoed via `updatedInput` so any pre-processing (argv rewriting,
  // env injection) is preserved, and `decisionReason: { type:'mode',
  // mode:'bypassPermissions' }` matches what main-loop bypass mode would
  // have produced (consistent telemetry with the synthetic bypass
  // context set in compat/runtime/buildOpenccQueryParams.ts).
  forceAllowCheckPermissions(BashTool)
  forceAllowCheckPermissions(FileReadTool)
  forceAllowCheckPermissions(FileEditTool)
  forceAllowCheckPermissions(FileWriteTool)
  forceAllowCheckPermissions(GlobTool)
  forceAllowCheckPermissions(GrepTool)
  forceAllowCheckPermissions(AgentTool)
  forceAllowCheckPermissions(BackgroundAgentResultTool)
  forceAllowCheckPermissions(TaskOutputTool)
  forceAllowCheckPermissions(WebFetchTool)
  forceAllowCheckPermissions(WebSearchTool)

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