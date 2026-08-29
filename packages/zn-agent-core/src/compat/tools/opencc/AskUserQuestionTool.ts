import { wrapAsOpenccTool } from '../../runtime/openccToolWrap.js'
import { getCurrentSessionId } from '../../runWithSessionId.js'
import { askUserQuestionTool } from '../../tools/index.js'
import { z as z4 } from 'zod/v4'

export interface AskUserQuestionBridgeContext {
  sessionId?: string
  askRegistry?: any
  onYield?: (event: any) => void
}

/**
 * zai patch (2026-08-27): resolve the bridging ctx for an AskUserQuestion
 * call. sessionId prefers the per-async-chain ALS (runWithSessionId) over the
 * process-global `__zaiBridgeCtx.sessionId` pointer:
 *   - in-process print sessions (ZAI_CORE_RUNTIME=inproc) wrap the whole
 *     runHeadless chain in runWithSessionId, so concurrent sessions each see
 *     their OWN sessionId here — the global pointer would cross-fire.
 *   - outside any ALS (current lightweight default runtime) the global pointer is used
 *     unchanged (per-query merge in createOpenccRuntime-impl.query), so
 *     existing behavior is preserved.
 * Exported for unit testing without booting the full tool.
 */
export function resolveAskBridgeCtx(): AskUserQuestionBridgeContext & {
  sessionId: string | undefined
} {
  const bridge = ((globalThis as any).__zaiBridgeCtx ??
    {}) as AskUserQuestionBridgeContext
  return { ...bridge, sessionId: getCurrentSessionId() ?? bridge.sessionId }
}

/**
 * Wrap zai-native AskUserQuestion as an opencc-compatible Tool.
 *
 * Critically, `transformCtx` reads `__zaiBridgeCtx` at CALL time, not at
 * wrapper-construction time. The wrapper itself is module-cached inside
 * `getOpenccBuiltinTools()`; capturing `ctx` in a closure (the prior
 * implementation) pinned sessionId / askRegistry / onYield to whichever
 * session called `getOpenccBuiltinTools()` first, so a SECOND session's
 * AskUserQuestion call would hit `askUserQuestionCall`'s
 * `ctx.askRegistry || !ctx.onYield` stub branch and silently no-op instead
 * of yielding `tool_use:ask_pending`. Reading the global on each call
 * (matching SkillTool.ts's pattern) keeps the cached wrapper correct
 * across concurrent sessions.
 */
// opencc's `toolToAPISchema` (utils/api.ts:210) converts a tool's
// inputSchema with `zodToJsonSchema` (utils/zodToJsonSchema.ts), which
// imports `toJSONSchema` from `zod/v4` and reads `schema._zod.def`. The
// zai-native `askUserQuestionTool.inputSchema` is built with the
// workspace's zod v3 (`compat/tools/index.ts`), whose instances have no
// `_zod` property — every API request with the wrapped tool crashed with
// "undefined is not an object (evaluating 'schema._zod.def')". The vendor
// tools all use `zod/v4` (137 files in opencc-src). So the wrapper
// exposes a zod-v4 input schema mirroring the same fields, while the
// tool's `call` path still parses through the zai-native v3 schema
// (makeTool's safeParse) — the two never disagree because the model
// emits the vendor schema shape and the v3 parse is lenient (z.object).
//
// Loose z4.object (not strictObject): the vendor tool declares extra
// fields (e.g. option.preview) that this mirror may lag on; strict mode
// would reject the model's input and break the call.
const AskUserQuestionInputV4 = z4.object({
  questions: z4
    .array(
      z4.object({
        question: z4.string(),
        header: z4.string(),
        options: z4
          .array(
            z4.object({
              label: z4.string(),
              description: z4.string().optional(),
              preview: z4.string().optional(),
            }),
          )
          .min(2)
          .max(4),
        multiSelect: z4.boolean().optional(),
      }),
    )
    .min(1)
    .max(4),
  metadata: z4
    .object({
      source: z4.string().optional(),
    })
    .optional(),
})

export function wrapAskUserQuestionToolAsOpencc(): unknown {
  const wrapped = wrapAsOpenccTool(askUserQuestionTool as any, {
    transformCtx: (openccCtx: any) => {
      // zai patch (2026-08-27): ALS-preferred sessionId (see resolveAskBridgeCtx).
      const ctx = resolveAskBridgeCtx()
      return {
        ...openccCtx,
        // zai patch (2026-08-29, plan §A): surface the vendor's `toolUseId`
        // (camelCase) on the ctx we hand back to zai-native tools. The
        // openccToolWrap fallback already tolerates both casings, but
        // setting it here means the strict `!ctx.toolUseId` guard inside
        // askUserQuestionCall never fires for the in-process headless
        // path. Without this, the LLM sees a stub string and the Web
        // UI never gets a QuestionCard.
        toolUseId: openccCtx?.toolUseId ?? openccCtx?.toolUseID,
        sessionId: ctx.sessionId,
        askRegistry: ctx.askRegistry,
        onYield: ctx.onYield,
        abortSignal: openccCtx.abortController?.signal,
      }
    },
  }) as any
  wrapped.name = 'AskUserQuestion'
  // opencc converts `tool.inputSchema` with zod/v4's toJSONSchema — see
  // the module-level comment for why the v3 zai-native schema would crash.
  wrapped.inputSchema = AskUserQuestionInputV4
  // Tell opencc this tool needs user input — opencc will pause the loop.
  wrapped.requiresUserInteraction = () => true
  // Don't cancel on new user message — wait for current question to resolve.
  wrapped.interruptBehavior = () => 'block'
  return wrapped
}
