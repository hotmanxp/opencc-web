// @ts-nocheck -- bridges zai's minimal Tool to opencc-internals Tool shape.
// opencc-internals/Tool.ts is itself @ts-nocheck and uses zod/v4; we don't
// duplicate that machinery here. We only fill the fields the runtime actually
// inspects: description, prompt, checkPermissions, call, mapToolResult...

import type { Tool } from './Tool.js'

/**
 * The minimal shape that legacy zai tools implement. Their bodies return
 * `{output, isError}` (string) rather than opencc's `{data: T, ...}`. We keep
 * these working unchanged and adapt at the registry boundary.
 */
type LegacyTool = {
  name: string
  description: string
  inputSchema: any
  call(input: any, ctx: any): Promise<{ output: string; isError?: boolean }>
  isConcurrencySafe?: (input: any) => boolean
  isReadOnly?: (input: any) => boolean
  isDestructive?: (input: any) => boolean
}

const MAX_RESULT_SIZE_CHARS_DEFAULT = 100_000

/**
 * Adapt a minimal legacy Tool to the opencc-internals Tool contract.
 *
 * The opencc Tool type is enormous (30+ fields, React-aware renderers,
 * permission classifiers). zai-agent-core's runtime never invokes any of
 * those optional methods; we provide no-op stubs that keep tool bodies
 * working without forcing every file to be rewritten.
 */
export function wrapAsOpenccTool(legacy: LegacyTool): Tool {
  return {
    // Identity
    name: legacy.name,
    isMcp: false,

    // Schemas: zod (v3) vs zod/v4 mismatch is hidden behind `as any` because
    // opencc-internals/Tool.ts is `@ts-nocheck`.
    inputSchema: legacy.inputSchema,

    // Description / prompt: opencc requires async methods. Cache the result
    // so the model isn't blocked on per-call re-renders.
    async description() {
      return legacy.description
    },
    async prompt() {
      // Legacy tools carry a single PROMPT/DESCRIPTION string. opencc wants
      // both; we use the same text for both since legacy didn't separate them.
      return legacy.description
    },

    // Lifecycle / classification — minimal no-ops + pass-through to legacy.
    isEnabled: () => true,
    isConcurrencySafe: (input: any) =>
      legacy.isConcurrencySafe?.(input) ?? false,
    isReadOnly: (input: any) => legacy.isReadOnly?.(input) ?? false,
    isDestructive: (input: any) => legacy.isDestructive?.(input) ?? false,

    async checkPermissions(input: any) {
      // Default: allow everything. Per-tool deny logic (BashTool via
      // defaultCanUseToolFactory) is invoked by the runtime BEFORE tool.call
      // returns here, so this is the post-permission-check entry point.
      return {
        behavior: 'allow',
        updatedInput: input,
      }
    },

    toAutoClassifierInput(input: any) {
      // Auto-mode security classifier reads this. For zai we don't have that
      // pipeline — return a stringified form for parity.
      if (typeof input === 'string') return input
      try {
        return JSON.stringify(input)
      } catch {
        return String(input)
      }
    },

    userFacingName: () => legacy.name,

    maxResultSizeChars: MAX_RESULT_SIZE_CHARS_DEFAULT,

    // The core call bridge. zai returns {output, isError}; opencc wants
    // {data, newMessages?, contextModifier?, ...}. We forward `output` as `data`
    // and let the runtime read both via mapToolResultToToolResultBlockParam.
    async call(input: any, ctx: any) {
      const r = await legacy.call(input, ctx)
      return {
        data: r.output,
        isError: r.isError ?? false,
      }
    },

    mapToolResultToToolResultBlockParam(content: unknown) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: typeof content === 'string' ? content : JSON.stringify(content),
        is_error: false,
      }
    },

    // Methods that legacy zai tools don't use; provide explicit no-ops so the
    // opencc Tool contract is fully satisfied.
    renderToolUseMessage: () => null,
    renderToolResultMessage: () => null,
    isResultTruncated: () => false,
    isOpenWorld: () => false,
    isSearchOrReadCommand: () => ({ isSearch: false, isRead: false }),
    isLsp: false,
    shouldDefer: false,
  } as unknown as Tool
}