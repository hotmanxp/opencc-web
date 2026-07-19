// @ts-nocheck -- bridges zai's minimal Tool to opencc-internals Tool shape.
// opencc-internals/Tool.ts is itself @ts-nocheck and uses zod/v4; we don't
// duplicate that machinery here. We only fill the fields the runtime actually
// inspects: description, prompt, checkPermissions, call, mapToolResult...

import type { Tool, LegacyTool } from './Tool.js'

const MAX_RESULT_SIZE_CHARS_DEFAULT = 100_000

/**
 * Adapt a minimal legacy Tool to the opencc-internals Tool contract.
 *
 * 新工具(典型: 移植后的 BashTool)在 LegacyTool 上实现了 opencc 风格的可选方法
 * (`prompt` / `validateInput` / `checkPermissions` / `preparePermissionMatcher` /
 * `mapToolResultToToolResultBlockParam` / `toAutoClassifierInput` / `userFacingName` /
 * `getToolUseSummary` / `getActivityDescription` / `isSearchOrReadCommand` /
 * `maxResultSizeChars` / `asyncDescription`)。本适配器直接转发, 不再走默认值。
 * 老工具这些字段都是 undefined, 适配器自动回落到默认 no-op。
 */
export function wrapAsOpenccTool(legacy: LegacyTool): Tool {
  return {
    // Identity
    name: legacy.name,
    // Forward legacy-tool aliases to the opencc Tool contract so
    // `findToolByName` and `toolMatchesName` can resolve the renamed
    // tool under its prior names (e.g. BashOutput → TaskOutput).
    aliases: legacy.aliases,
    isMcp: false,

    inputSchema: legacy.inputSchema,

    // Description / prompt: opencc requires async methods.
    async description(input: any) {
      if (legacy.asyncDescription) return legacy.asyncDescription(input)
      return legacy.description
    },
    async prompt() {
      // 优先用工具自己实现的 `prompt` (新 BashTool 提供完整 331 行提示词),
      // 回落到 `description` (老工具共享同一文本)。
      if (legacy.prompt) {
        const p = legacy.prompt()
        return typeof p === 'string' ? p : await p
      }
      return legacy.description
    },

    // Lifecycle / classification — minimal no-ops + pass-through to legacy.
    isEnabled: () => true,
    isConcurrencySafe: (input: any) =>
      legacy.isConcurrencySafe?.(input) ?? false,
    isReadOnly: (input: any) => legacy.isReadOnly?.(input) ?? false,
    isDestructive: (input: any) => legacy.isDestructive?.(input) ?? false,

    async validateInput(input: any, ctx: any) {
      if (!legacy.validateInput) return { result: true }
      return legacy.validateInput(input, ctx)
    },

    async checkPermissions(input: any, ctx: any) {
      if (!legacy.checkPermissions) {
        return { behavior: 'allow', updatedInput: input }
      }
      return legacy.checkPermissions(input, ctx)
    },

    async preparePermissionMatcher(input: any) {
      if (!legacy.preparePermissionMatcher) return () => true
      return legacy.preparePermissionMatcher(input)
    },

    inputsEquivalent(input1: any, input2: any) {
      if (!legacy.inputsEquivalent) return false
      return legacy.inputsEquivalent(input1, input2)
    },

    toAutoClassifierInput(input: any) {
      if (legacy.toAutoClassifierInput) return legacy.toAutoClassifierInput(input)
      if (typeof input === 'string') return input
      try {
        return JSON.stringify(input)
      } catch {
        return String(input)
      }
    },

    userFacingName(input: any) {
      if (legacy.userFacingName) return legacy.userFacingName(input)
      return legacy.name
    },

    getToolUseSummary(input: any) {
      return legacy.getToolUseSummary?.(input) ?? null
    },

    getActivityDescription(input: any) {
      return legacy.getActivityDescription?.(input) ?? null
    },

    isSearchOrReadCommand(input: any) {
      return legacy.isSearchOrReadCommand?.(input) ?? { isSearch: false, isRead: false }
    },

    maxResultSizeChars: legacy.maxResultSizeChars ?? MAX_RESULT_SIZE_CHARS_DEFAULT,

    // The core call bridge. zai returns {output, isError}; opencc wants {data, ...}.
    async call(input: any, ctx: any) {
      const r = await legacy.call(input, ctx)
      return {
        data: r.output,
        isError: r.isError ?? false,
      }
    },

    mapToolResultToToolResultBlockParam(content: unknown, toolUseId: string) {
      if (legacy.mapToolResultToToolResultBlockParam) {
        return legacy.mapToolResultToToolResultBlockParam(content, toolUseId)
      }
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: typeof content === 'string' ? content : JSON.stringify(content),
        is_error: false,
      }
    },

    // Methods that legacy zai tools don't use; provide explicit no-ops.
    renderToolUseMessage: () => null,
    renderToolResultMessage: () => null,
    isResultTruncated: () => false,
    isOpenWorld: () => false,
    isLsp: false,
    shouldDefer: false,
  } as unknown as Tool
}