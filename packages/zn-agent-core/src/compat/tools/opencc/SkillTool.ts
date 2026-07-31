import { wrapAsOpenccTool } from '../../runtime/openccToolWrap.js'
import { skillTool } from '../index.js'

/**
 * Bridge context for Skill — same shape as TaskTools' TaskBridgeContext.
 * `__zaiBridgeCtx` is set by runViaOpenccQuery before vendor `query()` is
 * invoked (see compat/runtime/openccQueryBridge.ts:190). Skill only needs
 * `sessionId` + `abortSignal`.
 */
export interface SkillBridgeContext {
  sessionId?: string
  abortSignal?: AbortSignal
}

/**
 * Build the opencc ctx → zai ToolCallCtx transform for Skill. Injects
 * sessionId + abortSignal; cwd is provided by the vendor ctx (opencc
 * tracks cwd per-query) so we don't override it.
 */
function buildSkillTransformCtx(bridgeCtx: SkillBridgeContext) {
  return (openccCtx: any) => ({
    ...openccCtx,
    sessionId: openccCtx?.sessionId ?? bridgeCtx.sessionId,
    abortSignal: openccCtx?.abortController?.signal ?? bridgeCtx.abortSignal,
  })
}

/**
 * Wrap the zai-native Skill tool as an opencc-compatible Tool so vendor's
 * `query()` can call it. Returns an array (length 1) to keep the same
 * shape as wrapTaskToolsAsOpencc.
 *
 * Why zai-native and not vendor's SkillTool:
 * - vendor's SkillTool is Bun-only (imports `feature` from `bun:bundle`)
 * - zai-native Skill (compat/tools/index.ts) already handles
 *   `ctx.skills` + ZAI_SKILL_DIRS fallback paths and is Node-safe.
 * - Sub-agents (AgentTool) need the zai-native Skill too, so keeping
 *   one source of truth avoids drift.
 */
export function wrapSkillToolAsOpencc(): OpenccToolLike[] {
  const bridgeCtx = ((globalThis as any).__zaiBridgeCtx ?? {}) as SkillBridgeContext
  const transformCtx = buildSkillTransformCtx(bridgeCtx)

  return [
    wrapAsOpenccTool(skillTool as any, { transformCtx }) as any,
  ]
}

interface OpenccToolLike {
  readonly name: string
  readonly inputSchema: unknown
  call(args: unknown, ctx: unknown, canUseTool: unknown, parentMessage: unknown, onProgress?: unknown): Promise<unknown>
  description(input: unknown, options: unknown): Promise<string>
  isConcurrencySafe(input: unknown): boolean
  isReadOnly(input: unknown): boolean
  isEnabled(): boolean
}