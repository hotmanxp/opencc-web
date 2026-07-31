import { wrapAsOpenccTool } from '../../runtime/openccToolWrap.js'
import {
  TaskCreateTool,
  TaskGetTool,
  TaskListTool,
  TaskUpdateTool,
} from '../tasks/index.js'

/**
 * Bridge context for Task tools — same shape as AskUserQuestion's
 * `AskUserQuestionBridgeContext` (compat/tools/opencc/AskUserQuestionTool.ts).
 *
 * `__zaiBridgeCtx` is set by runViaOpenccQuery before vendor's `query()`
 * is invoked (see compat/runtime/openccQueryBridge.ts:190). The four
 * Task tools only need `sessionId` + `abortSignal` — `askRegistry` and
 * `onYield` are AskUserQuestion-specific and not consumed here.
 */
export interface TaskBridgeContext {
  sessionId?: string
  abortSignal?: AbortSignal
}

/**
 * Build the opencc ctx → zai ToolCallCtx transform for Task tools.
 * Injects `sessionId` (so each tool's `getTaskListStore().create(sid, ...)`
 * routes to the right session bucket) and `abortSignal` (for clean
 * cancellation). The bridge ctx also provides `sessionId` as a fallback
 * for cases where the opencc ctx doesn't carry it.
 */
function buildTaskTransformCtx(bridgeCtx: TaskBridgeContext) {
  return (openccCtx: any) => ({
    ...openccCtx,
    sessionId: openccCtx?.sessionId ?? bridgeCtx.sessionId,
    abortSignal: openccCtx?.abortController?.signal ?? bridgeCtx.abortSignal,
  })
}

/**
 * Wrap the four Task tools as opencc-compatible Tools so vendor's
 * `query()` can call them. Returns them in the same order as
 * compat/tools/tasks/index.ts: taskTools array.
 *
 * The wrap is parameterless (no sessionId override) — the bridge ctx
 * is read once at opencc query setup time (see builtin.ts) and the
 * transformCtx looks up the live sessionId per-call from openccCtx.
 */
export function wrapTaskToolsAsOpencc(): OpenccToolLike[] {
  const bridgeCtx = ((globalThis as any).__zaiBridgeCtx ?? {}) as TaskBridgeContext
  const transformCtx = buildTaskTransformCtx(bridgeCtx)

  return [
    wrapAsOpenccTool(TaskCreateTool as any, { transformCtx }) as any,
    wrapAsOpenccTool(TaskGetTool as any, { transformCtx }) as any,
    wrapAsOpenccTool(TaskUpdateTool as any, { transformCtx }) as any,
    wrapAsOpenccTool(TaskListTool as any, { transformCtx }) as any,
  ]
}

/**
 * Minimal subset of opencc Tool interface satisfied by wrapAsOpenccTool.
 * Re-declared here to avoid pulling opencc's full Tool interface
 * (which requires ReactNode) into every caller.
 */
interface OpenccToolLike {
  readonly name: string
  readonly inputSchema: unknown
  call(args: unknown, ctx: unknown, canUseTool: unknown, parentMessage: unknown, onProgress?: unknown): Promise<unknown>
  description(input: unknown, options: unknown): Promise<string>
  isConcurrencySafe(input: unknown): boolean
  isReadOnly(input: unknown): boolean
  isEnabled(): boolean
}