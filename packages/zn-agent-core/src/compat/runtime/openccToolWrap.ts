/**
 * wrapAsOpenccTool — wraps a zai Tool as an opencc Tool.
 *
 * opencc's `Tool` interface (packages/zn-agent-core/src/opencc-src/Tool.ts)
 * requires ~30 methods. zai's compat Tool is much simpler. This wrapper
 * fills the gap with no-op defaults for unused methods (React renderers,
 * isReadOnly, etc.) and delegates the essential ones (call, description,
 * name, inputSchema) to the underlying zai tool.
 *
 * Tool-specific wrappers (BashTool, ReadTool, etc.) in compat/tools/opencc/
 * extend this base with tool-specific behavior like permission checks.
 */

/**
 * wrapWithOverrides — like wrapAsOpenccTool but allows tool-specific
 * wrappers to override specific methods (e.g., BashTool overrides
 * checkPermissions, AskUserQuestionTool overrides requiresUserInteraction).
 */
export function wrapWithOverrides(
  tool: ZaiToolLike,
  overrides: Partial<OpenccToolMinimal>,
): OpenccToolMinimal {
  return { ...wrapAsOpenccTool(tool), ...overrides }
}

import {
  noopReactNode,
  falseFn,
  trueFn,
  defaultDescription,
  defaultUserFacingName,
} from './openccToolDefaults.js'

// Structural input type for wrapAsOpenccTool. Decouples from the narrow
// `Tool` declaration in types.js — callers in later tasks can cast as needed.
export type ZaiToolLike = {
  name: string
  description?: string | ((input: unknown) => string)
  inputSchema?: unknown
  call?: (args: unknown, ctx: unknown) => Promise<unknown>
  maxResultSizeChars?: number
  userFacingName?: ((input: unknown) => string) | string
}

// Minimal subset of opencc's Tool type that we satisfy. Avoids pulling
// opencc's full Tool interface (which requires ReactNode) into every caller.
export interface OpenccToolMinimal {
  readonly name: string
  readonly inputSchema: unknown
  readonly maxResultSizeChars: number
  call(args: unknown, ctx: unknown, canUseTool: unknown, parentMessage: unknown, onProgress?: unknown): Promise<unknown>
  description(input: unknown, options: unknown): Promise<string>
  // vendor's permission main loop calls `tool.checkPermissions(input,
  // context)` at packages/zn-agent-core/src/opencc-src/utils/permissions/
  // permissions.ts:1122. The full vendor Tool interface lists this as
  // optional (vendor Tool.ts:749 marks it a defaultable key). wrapAsOpenccTool
  // supplies a guaranteed-allow default so wrapped zai-native tools
  // (compat/tools/) don't fall through to a vendor `passthrough` message
  // when called by the main loop. wrapWithOverrides callers (compat/tools/
  // opencc/builtin.ts) override the default for vendor tools that need
  // finer-grained permission behavior.
  checkPermissions?(input: unknown): Promise<{
    behavior: 'allow' | 'deny' | 'ask' | 'passthrough'
    updatedInput?: unknown
    decisionReason?: unknown
    message?: string
  }>
  isConcurrencySafe(input: unknown): boolean
  isReadOnly(input: unknown): boolean
  isDestructive(input: unknown): boolean
  isEnabled(): boolean
  isMcp?: boolean
  isLsp?: boolean
  renderToolUseMessage(input: unknown, options: unknown): unknown
  renderToolResultMessage(output: unknown, progress: unknown[], options: unknown): unknown
  /**
   * REQUIRED by vendor's Tool interface (NOT in DefaultableToolKeys, so
   * `buildTool` does NOT provide a default). Called unconditionally by
   * vendor at packages/zn-agent-core/src/opencc-src/services/tools/
   * toolExecution.ts:1573 and utils/messages.ts:3159 to translate a tool's
   * `ToolResult.data` into an Anthropic `ToolResultBlockParam` for the
   * next LLM turn. Without this, every wrapped zai-native tool
   * (AskUserQuestion, TaskCreate, Skill, …) throws
   * `tool.mapToolResultToToolResultBlockParam is not a function` the
   * moment opencc finishes executing it.
   */
  mapToolResultToToolResultBlockParam(
    data: unknown,
    toolUseID: string,
  ): {
    type: 'tool_result'
    content: string | unknown[]
    tool_use_id: string
    is_error?: boolean
  }
  /**
   * Also in vendor's DefaultableToolKeys (vendor Tool.ts:749 lists
   * `toAutoClassifierInput` as a defaultable key), so `buildTool`
   * provides `() => ''`. wrapAsOpenccTool doesn't go through buildTool,
   * so we supply the same default to keep the YOLO auto-classifier
   * (utils/permissions/yoloClassifier.ts:429) from blowing up on
   * wrapped zai-native tools. Today the wrapper forces `checkPermissions`
   * to always allow, so the classifier shouldn't run, but defense-in-
   * depth: the wrapper exposes every DefaultableToolKey method that any
   * downstream code path might call.
   */
  toAutoClassifierInput(input: unknown): unknown
  /**
   * REQUIRED by vendor's Tool interface (NOT in DefaultableToolKeys).
   * Called for EVERY tool on EVERY API request via
   * `toolToAPISchema(tool, options)` (utils/api.ts:221 + claude.ts:1288).
   * If this method is missing, the very next prompt would throw
   * `tool.prompt is not a function` before the LLM even sees the
   * tool list. Vendor tools like Bash use the `options` arg to render
   * context-aware descriptions (allowed subcommands, sandbox rules).
   * zai-native tools expose a static description string and don't use
   * this hook, so the default returns that static text verbatim.
   */
  prompt(options: {
    getToolPermissionContext: () => Promise<unknown>
    tools: unknown
    agents: unknown
    allowedAgentTypes?: string[]
  }): Promise<string>
  // ... other methods are optional and default to no-ops
}

export interface WrapOptions {
  /**
   * Transform opencc's ToolUseContext into zai's ToolCallCtx before
   * invoking the tool. Use this to inject sessionId / askRegistry /
   * onYield / abortSignal that zai's tools need but opencc's
   * ToolUseContext doesn't provide.
   */
  transformCtx?: (openccCtx: unknown) => unknown
}

export function wrapAsOpenccTool(
  tool: ZaiToolLike,
  opts: WrapOptions = {},
): OpenccToolMinimal {
  const wrapped: OpenccToolMinimal = {
    name: tool.name,
    inputSchema: tool.inputSchema,
    maxResultSizeChars: tool.maxResultSizeChars ?? 50_000,

    // zai patch: vendor permission main-loop calls
    // `tool.checkPermissions(input, context)` at
    // packages/zn-agent-core/src/opencc-src/utils/permissions/permissions.ts:1122.
    // The vendor Tool interface declares this method as defaultable
    // (Tool.ts:749) — `buildTool` spreads TOOL_DEFAULTS.checkPermissions
    // which returns `{behavior:'allow', updatedInput: input}` for built
    // tools. zai-native tools built via `makeTool(...)` (compat/tools/)
    // never got a checkPermissions because that file's ToolLike is the
    // narrower ZaiToolLike we declare here. Without this default, a
    // runtime call to `tool.checkPermissions` from the permission main
    // loop throws TypeError; the try/catch at permissions.ts:1120-1128
    // swallows it (logging only) and `toolPermissionResult` stays at
    // `{behavior:'passthrough'}`, which usually still falls through to
    // the bypassPermissions allow branch — but the `passthrough`
    // message ("AskUserQuestion to use Skill …") leaks into the next LLM
    // turn and we observed it precipitating `toolFailureLoopGuard`
    // trips downstream. Setting this to a guaranteed allow sidesteps
    // both paths. zai never depends on a vendor-permission pause for
    // user-facing approval — user-facing approval flows (AskUserQuestion,
    // permission prompts) live in their own zai-native tool wrappers
    // (compat/tools/opencc/AskUserQuestionTool.ts and the
    // /api/agent/answer AskRegistry route).
    async checkPermissions(input: unknown) {
      return {
        behavior: 'allow' as const,
        updatedInput: input,
        decisionReason: {
          type: 'mode' as const,
          mode: 'bypassPermissions' as const,
        },
      }
    },

    async call(args, ctx, _canUseTool, _parentMessage, _onProgress) {
      // zai's Tool.call has signature: (args, ctx) => Promise<{output: string}>
      // opencc's Tool.call has signature: (args, ctx, canUseTool,
      // parentMessage, onProgress?) => Promise<ToolResult<Output>> where
      // ToolResult is `{data: Output, newMessages?, contextModifier?,
      // mcpMeta?}` (see opencc-src/Tool.ts:358). Vendor code reads
      // `result.data` directly to feed `mapToolResultToToolResultBlockParam`
      // and to log `result.data.output` for analytics (toolExecution.ts:
      // 1542-1544, 1573). Wrapping the bare zai output in `{data: ...}`
      // here keeps both paths working without forcing every zai tool's
      // executor to learn vendor's ToolResult envelope.
      //
      // The previous implementation returned `tool.call(...)` directly,
      // so `result.data` was undefined and mapToolResultToToolResultBlockParam
      // produced `{content: '', tool_use_id}` — an empty tool_result that
      // made the LLM stop after AskUserQuestion (UI shows "completed with
      // no output", conversation halts).
      if (!tool.call) throw new Error(`openccToolWrap: tool "${tool.name}" has no call method`)
      const finalCtx = opts.transformCtx ? opts.transformCtx(ctx) : ctx
      // zai patch (2026-08-29, plan §A): the in-process headless wrap of
      // AskUserQuestion takes a strict `!ctx.toolUseId` guard
      // (compat/tools/index.ts:304) before yielding `tool_use:ask_pending`.
      // Without this fallback the wrapped call drops into a stub branch
      // that returns `[zai askRegistry not configured]` and the Web UI
      // never receives `prompt.ask`. The vendor vocabulary exposes
      // BOTH `toolUseId` (camelCase, ToolUseContext line 310) and
      // `toolUseID` (PascalCase, Progress line 353); surface whichever
      // the caller actually supplied.
      const ctxAny = finalCtx as any
      const toolUseIdFallback =
        ctxAny?.toolUseId ??
        ctxAny?.toolUseID ??
        (ctx as any)?.toolUseId ??
        (ctx as any)?.toolUseID
      const enrichedCtx = toolUseIdFallback
        ? { ...ctxAny, toolUseId: toolUseIdFallback }
        : ctxAny
      const result = await tool.call(args, enrichedCtx)
      // If the zai tool already returned a ToolResult-shaped value
      // (e.g. newMessages / contextModifier / mcpMeta passed through),
      // don't double-wrap. Detect by presence of `data` field — zai's
      // bare `{output: string}` doesn't have one.
      if (
        result != null &&
        typeof result === 'object' &&
        'data' in (result as Record<string, unknown>)
      ) {
        return result
      }
      return { data: result }
    },

    async description(input, options) {
      // zai's description is synchronous; opencc's is async.
      // Two paths:
      //  - tool.description is a function (opencc-native shape): call it
      //    with the same (input, options) shape vendor expects. The
      //    function may ignore options and return a static string, or it
      //    may use options.tools/permissions to render context-aware text.
      //  - tool.description is a static string (the zai-native shape —
      //    see compat/tools/index.ts:431-488): return it verbatim. The
      //    previous implementation fell through to defaultDescription()
      //    here, which returned "(no description)" — silently breaking
      //    the MCP tool detail view (MCPToolDetailView.tsx:71) and the
      //    useCanUseTool confirmation dialog (useCanUseTool.tsx:57),
      //    which both call tool.description() to render the description.
      if (typeof tool.description === 'function') {
        return tool.description(input as any)
      }
      if (typeof tool.description === 'string') {
        return tool.description
      }
      return defaultDescription(input, options)
    },

    isConcurrencySafe: falseFn,
    isReadOnly: falseFn,
    isDestructive: falseFn,
    isEnabled: trueFn,
    renderToolUseMessage: noopReactNode as any,
    renderToolResultMessage: noopReactNode as any,

    // vendor's required `mapToolResultToToolResultBlockParam` (see the
    // interface doc above). Translates a wrapped zai tool's
    // `ToolResult.data` (always `{ output: string }` per makeTool.ts
    // and the task/skill executors in compat/tools/) into an Anthropic
    // ToolResultBlockParam. Zai signals errors with a `[error]` prefix
    // inside the output string (compat/tools/index.ts:204 etc.) — we
    // forward the prefix verbatim and do NOT set `is_error` because
    // opencc's permission classifier already handles `[error]` strings
    // downstream (see toolExecution.ts:1508-1549 which reads
    // `result.data.output` for content event logging). Setting
    // `is_error: true` would make Anthropic wrap the response as an
    // error and the LLM would treat it as a hard failure rather than a
    // recoverable output.
    mapToolResultToToolResultBlockParam(data: unknown, toolUseID: string) {
      let content: string
      if (data == null) {
        content = ''
      } else if (typeof data === 'string') {
        content = data
      } else if (
        typeof data === 'object' &&
        'output' in data &&
        typeof (data as { output: unknown }).output === 'string'
      ) {
        content = (data as { output: string }).output
      } else {
        // Fallback: serialize structured task output (e.g. JSON-stringified
        // task record from TaskCreateTool). opencc expects content to be
        // either a string or an array of content blocks; jsonStringify
        // is what vendor tools use (see TaskStopTool.ts:102).
        try {
          content = JSON.stringify(data)
        } catch {
          content = String(data)
        }
      }
      return {
        type: 'tool_result' as const,
        content,
        tool_use_id: toolUseID,
      }
    },

    // vendor's DefaultableToolKey default (mirrors TOOL_DEFAULTS in
    // opencc-src/Tool.ts:804). Returning '' tells the auto-classifier to
    // skip this tool; security-relevant tools (Bash etc.) define their
    // own override, but zai-wrapped tools are force-allowed at the
    // permission layer so the classifier shouldn't reach them anyway.
    toAutoClassifierInput(_input: unknown): unknown {
      return ''
    },

    // vendor's required `prompt()` (see the interface doc above). zai
    // tools carry their full description as a static string in
    // `description: '...'` (see compat/tools/index.ts:431-488 for all
    // the buildDefaultTools entries). Vendor tools like Bash consume
    // the `options` arg (getToolPermissionContext, tools, agents) to
    // render context-aware descriptions that mention allowed subcommands
    // or current sandbox state — zai tools don't have that pattern, so
    // we ignore `options` and return the static description string. If
    // `description` is a function (the opencc-native shape), forward
    // through it for completeness.
    async prompt(_options: {
      getToolPermissionContext: () => Promise<unknown>
      tools: unknown
      agents: unknown
      allowedAgentTypes?: string[]
    }): Promise<string> {
      if (typeof tool.description === 'function') {
        return (tool.description as (input: unknown, options?: unknown) => string | Promise<string>)(
          undefined,
          _options,
        )
      }
      if (typeof tool.description === 'string') {
        return tool.description
      }
      return '(no description)'
    },
  }

  // Preserve userFacingName if present; otherwise default to a closure that
  // calls defaultUserFacingName(tool) so the name field is always available.
  if (tool.userFacingName) {
    ;(wrapped as any).userFacingName = tool.userFacingName
  } else {
    ;(wrapped as any).userFacingName = (input?: unknown) =>
      defaultUserFacingName(tool as { name: string })
  }

  return wrapped
}
