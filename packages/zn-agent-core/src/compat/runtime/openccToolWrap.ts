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
      // zai's Tool.call has signature: (args, ctx) => Promise<ToolResult>
      // opencc's Tool.call has signature: (args, ctx, canUseTool, parentMessage, onProgress?) => Promise<ToolResult>
      // We pass through args + ctx (with optional transformCtx injection
      // so tools like AskUserQuestion can access zai's AskRegistry
      // and onYield callback). The extra opencc-only params are ignored.
      if (!tool.call) throw new Error(`openccToolWrap: tool "${tool.name}" has no call method`)
      const finalCtx = opts.transformCtx ? opts.transformCtx(ctx) : ctx
      return tool.call(args, finalCtx as any)
    },

    async description(input, options) {
      // zai's description is synchronous; opencc's is async.
      if (typeof tool.description === 'function') {
        return tool.description(input as any)
      }
      return defaultDescription(input, options)
    },

    isConcurrencySafe: falseFn,
    isReadOnly: falseFn,
    isDestructive: falseFn,
    isEnabled: trueFn,
    renderToolUseMessage: noopReactNode as any,
    renderToolResultMessage: noopReactNode as any,
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
