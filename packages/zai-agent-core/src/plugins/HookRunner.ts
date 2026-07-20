import type {
  HookExecutor,
  PluginHook,
  PluginLoadError,
} from './types.js'

/**
 * Default per-hook timeout. Applied to every individual hook unless the
 * hook declares its own `timeoutMs`. 30 s matches OpenCC's default hook
 * timeout — anything longer is usually a hung child process.
 */
export const DEFAULT_HOOK_TIMEOUT_MS = 30_000

/**
 * Events where `blocked: true` from an executor is treated as authoritative
 * and short-circuits the rest of the matching hook chain. Phase-1 only —
 * see the plugin runtime plan §5.3.
 */
const BLOCKING_EVENTS = new Set<string>(['PreToolUse', 'Stop'])

/**
 * Local typing for the `input` object passed to `Stop` hooks when the
 * wire-in (Phase 2 in queryLoop.ts) wants to enable active blocking.
 *
 * Spec C §2.1: pure additive payload extension. The `blocking: true`
 * field signals to a Stop hook that it MAY throw a `HookBlockedError`
 * (defined in `runtime/nudge/hooks.ts`) to actively break the loop.
 * The actual catch + `runtime.error` translation lives in the wire-in
 * layer; this file only documents the payload shape.
 *
 * Not exported — keeps the public surface area of `plugins/HookRunner`
 * unchanged. Wire-in callers cast to this shape at the call site.
 */
interface StopHookPayload {
  /** Set to true by the wire-in when active blocking is allowed. */
  blocking: boolean
}

/**
 * Stable contract returned by `HookRunner.run`. The runtime (Task 6)
 * inspects `blocked` and forwards `outputs` / `errors` to telemetry.
 */
export type HookRunResult = {
  event: string
  ran: number
  blocked: boolean
  outputs: unknown[]
  errors: PluginLoadError[]
}

/**
 * Field names that the matcher regex is matched against, in priority
 * order. The first field that exists on `input` AND is a string wins;
 * everything else (objects, numbers, missing) falls back to the next
 * field. This keeps `PreToolUse` happy with `{ toolName }` while still
 * letting `UserPromptSubmit` use `{ command }` and `Stop` use any
 * structured stop-reason without special-casing.
 */
const MATCHER_INPUT_FIELDS = ['toolName', 'command', 'prompt', 'name', 'event'] as const

function extractMatcherSubject(input: unknown): string | null {
  if (input === null || input === undefined) return null
  if (typeof input === 'string') return input
  if (typeof input !== 'object') return null
  for (const field of MATCHER_INPUT_FIELDS) {
    const value = (input as Record<string, unknown>)[field]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

function matcherError(hook: PluginHook, reason: string): PluginLoadError {
  return {
    code: 'hook_matcher_invalid',
    message: `Hook matcher /${hook.matcher}/ is invalid: ${reason}`,
    component: 'hooks',
    pluginId: hook.pluginId,
    detail: { event: hook.event, matcher: hook.matcher },
  }
}

function hookError(
  hook: PluginHook,
  code: string,
  message: string,
  detail?: unknown,
): PluginLoadError {
  return {
    code,
    message,
    component: 'hooks',
    pluginId: hook.pluginId,
    detail: {
      event: hook.event,
      command: hook.command,
      ...(detail !== undefined ? { error: detail } : {}),
    },
  }
}

/**
 * Combine `parent` with a `timeoutMs` deadline into a single
 * AbortSignal. Either side can fire the abort; listeners on the
 * returned signal see both.
 */
function combinedAbortSignal(parent: AbortSignal, timeoutMs: number): {
  signal: AbortSignal
  cleanup: () => void
  timedOut: { current: boolean }
} {
  const controller = new AbortController()
  const timedOut = { current: false }

  const onParentAbort = (): void => controller.abort(parent.reason)
  const onTimeout = (): void => {
    timedOut.current = true
    controller.abort(new Error(`Hook timed out after ${timeoutMs}ms`))
  }

  if (parent.aborted) {
    controller.abort(parent.reason)
  } else {
    parent.addEventListener('abort', onParentAbort, { once: true })
  }

  const timer = setTimeout(onTimeout, timeoutMs)

  return {
    signal: controller.signal,
    cleanup: (): void => {
      clearTimeout(timer)
      parent.removeEventListener('abort', onParentAbort)
    },
    timedOut,
  }
}

/**
 * Orchestrates hook execution for a single event.
 *
 * Semantics (phase 1, from the plugin runtime plan):
 *
 * - Filters hooks by `event`, evaluating them in declared order.
 * - A missing or empty `matcher` matches every input. Otherwise the
 *   matcher is a regex applied to a sensible input field (toolName,
 *   command, prompt, name, event — first string wins). An invalid
 *   regex is recorded on `errors` and that hook is skipped (no throw).
 * - Each hook runs under a combined AbortSignal that mixes the caller
 *   signal with a per-hook timeout (`hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS`).
 * - For blocking events (`PreToolUse`, `Stop`), `blocked: true` from an
 *   executor short-circuits the rest of the chain. The blocker's output
 *   is still recorded in `outputs`.
 * - For non-blocking events, every matching hook runs to completion.
 *   `blocked: true` returned by an executor is recorded in `outputs`
 *   but does NOT short-circuit (the intent is captured for
 *   observability; the runtime treats it as informational).
 * - Executor errors and rejections are recorded on `errors` and never
 *   abort later hooks.
 *
 * Filesystem-free by design — the executor is fully responsible for any
 * side effects.
 */
export class HookRunner {
  private readonly hooks: PluginHook[]
  private readonly executor: HookExecutor

  constructor(hooks: PluginHook[], executor: HookExecutor) {
    this.hooks = hooks
    this.executor = executor
  }

  async run(
    event: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<HookRunResult> {
    const result: HookRunResult = {
      event,
      ran: 0,
      blocked: false,
      outputs: [],
      errors: [],
    }

    const isBlocking = BLOCKING_EVENTS.has(event)
    const subject = extractMatcherSubject(input)

    for (const hook of this.hooks) {
      if (hook.event !== event) continue

      // Matcher evaluation.
      if (hook.matcher && hook.matcher.length > 0) {
        if (subject === null) {
          // No stringifiable subject → can't match. Skip silently.
          continue
        }
        let regex: RegExp
        try {
          regex = new RegExp(hook.matcher)
        } catch (cause) {
          result.errors.push(matcherError(hook, String(cause)))
          continue
        }
        if (!regex.test(subject)) continue
      }

      // Build per-hook abort signal.
      const timeoutMs = hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
      const combined = combinedAbortSignal(signal, timeoutMs)

      try {
        const output = await this.executor({
          command: hook.command,
          event: hook.event,
          pluginId: hook.pluginId,
          pluginRoot: hook.pluginRoot,
          input,
          signal: combined.signal,
        })

        result.ran += 1

        // Timeout fired while the executor was running — even if it
        // resolved gracefully afterwards, we still record a timeout
        // error and skip its output.
        if (combined.timedOut.current) {
          result.errors.push(
            hookError(
              hook,
              'hook_timeout',
              `Hook exceeded ${timeoutMs}ms timeout.`,
            ),
          )
        } else if (output && typeof output === 'object') {
          if (output.error !== undefined) {
            result.errors.push(
              hookError(hook, 'hook_executor_error', output.error),
            )
          }
          if ('output' in output) {
            result.outputs.push(output.output)
          }
          if (isBlocking && output.blocked === true) {
            result.blocked = true
            combined.cleanup()
            return result
          }
        }
      } catch (cause) {
        result.ran += 1
        const timedOut = combined.timedOut.current
        const parentAborted = signal.aborted
        if (timedOut) {
          result.errors.push(
            hookError(
              hook,
              'hook_timeout',
              `Hook exceeded ${timeoutMs}ms timeout.`,
            ),
          )
        } else if (parentAborted) {
          result.errors.push(
            hookError(hook, 'hook_aborted', 'Hook aborted by caller signal.'),
          )
        } else if (combined.signal.aborted) {
          result.errors.push(
            hookError(hook, 'hook_aborted', 'Hook aborted.', cause),
          )
        } else {
          result.errors.push(
            hookError(
              hook,
              'hook_executor_error',
              cause instanceof Error ? cause.message : String(cause),
              cause,
            ),
          )
        }
      } finally {
        combined.cleanup()
      }
    }

    return result
  }
}