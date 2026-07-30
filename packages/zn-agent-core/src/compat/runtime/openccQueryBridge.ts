/**
 * openccQueryBridge — connects zai's DefaultAgentRuntime.run() to
 * opencc's `query()`. Full implementation: lazy import opencc-src,
 * translate zai QueryOptions → opencc QueryParams, attach 5 wrapped core
 * tools, stream SDKMessage → RuntimeEvent with lazy-stub fallback for
 * missing .js imports.
 *
 * Runtime path: zai /agent/prompt → DefaultAgentRuntime.run → here.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve as pathResolve } from 'node:path'
import type { QueryOptions, OpenccAdapterConfig } from './types.js'
import type { RuntimeEvent } from './events.js'
import { buildOpenccQueryParams } from './buildOpenccQueryParams.js'
import { translateSdkToRuntime } from './sdkEventAdapter.js'
import { getOpenccBuiltinTools } from '../tools/opencc/builtin.js'
import { toRuntimeErrorEvent, toAbortedEvent } from './streamAdapter.js'

const OPENCC_SRC_DIR = pathResolve(
  new URL('.', import.meta.url).pathname,
  '..',
  '..',
  'opencc-src',
)
const STUB_DIR = pathResolve(
  new URL('.', import.meta.url).pathname,
  '..',
  'dangling-shims',
)

let openccModulePromise: Promise<any> | null = null
let stubCount = 0
const STUB_LIMIT = 50
// Track specs we've already auto-stubbed. If the same missing module
// surfaces twice in a row, the resolve.alias isn't routing to the
// stub — surface that as a clear diagnostic instead of looping
// forever (the prior bug: stubCount++ was inside `if (!existsSync)`,
// so once the stub existed, retries skipped the increment and
// STUB_LIMIT was never reached).
const stubbedSpecs = new Set<string>()

async function importOpenccSrc() {
  if (openccModulePromise) return openccModulePromise
  openccModulePromise = (async () => {
    try {
      // Dynamic import to a constructed path so Vite's static analysis
      // doesn't try to bundle opencc-src. Try `.js`, `.ts`, `.tsx`
      // extensions — the bridge runs in both Node (via tsx) and Bun,
      // and the vendored opencc source is .ts. Bun's dynamic import
      // doesn't auto-substitute extensions on absolute paths, so we
      // try each explicitly.
      let queryPath: string | null = null
      let lastErr: any
      for (const ext of ['.js', '.ts', '.tsx']) {
        const candidate = join(OPENCC_SRC_DIR, `query${ext}`)
        if (existsSync(candidate)) {
          queryPath = candidate
          break
        }
      }
      if (!queryPath) {
        // Fall back to .js path — Bun's import() may handle TS
        // resolution differently than existsSync.
        queryPath = join(OPENCC_SRC_DIR, 'query.js')
      }
      return await import(queryPath)
    } catch (err: any) {
      // Three error shapes we accept (Node direct, Node via loader, Vite):
      //   (a) `Cannot find module 'X.js'`
      //   (b) `Failed to load url X.js (resolved id: ...) in <file>. Does the file exist?`
      //   (c) Vite: `Failed to resolve import "X" from "<file>". Does the file exist?`
      const missingSpec =
        err.message?.match(/Cannot find module ['"]([^'"]+)['"]/i)?.[1] ??
        err.message?.match(/Failed to load url ([^\s(]+)/i)?.[1] ??
        err.message?.match(/Failed to resolve import ['"]([^'"]+)['"]/i)?.[1]
      const importedFrom =
        err.message?.match(/Failed to load url .* in (\S+?)\. Does the file exist\?/i)?.[1] ??
        err.message?.match(/Failed to resolve import.* from (\S+?)\. Does the file exist\?/i)?.[1]

      // Vendored opencc-src/ is read-only. If the missing file resolves
      // from inside it (typically a build artifact that the vendored
      // snapshot omits, e.g. `../integrations/generated/foo.generated.js`),
      // surface a clear error instead of polluting vendored code.
      if (
        importedFrom?.startsWith(OPENCC_SRC_DIR + '/') &&
        missingSpec &&
        !missingSpec.startsWith('node:') &&
        !missingSpec.includes('node_modules')
      ) {
        throw new Error(
          `[openccQueryBridge] vendored opencc-src references a missing file ` +
            `(${missingSpec}). Hand-stub under dangling-shims/ and add a ` +
            `resolve.alias for the relative path. Imported from: ${importedFrom}`,
        )
      }

      // Out-of-tree missing module: drop a minimal stub in dangling-shims/
      // and retry. Bounded to prevent infinite loops on recursive missing
      // imports.
      if (
        stubCount < STUB_LIMIT &&
        missingSpec &&
        !missingSpec.startsWith('node:') &&
        !missingSpec.includes('node_modules')
      ) {
        if (stubbedSpecs.has(missingSpec)) {
          // Same missing spec surfaced twice — the alias isn't routing
          // to the stub we wrote. Surface a clear diagnostic instead of
          // looping forever.
          throw new Error(
            `[openccQueryBridge] auto-stubbed ${missingSpec} but import ` +
              `still fails. Check resolve.alias in vitest.config.ts and ` +
              `bunResolve() in bun-protocol.mjs — the alias must route ` +
              `${missingSpec} to dangling-shims before the generic ` +
              `'src/...' catch-all maps it to <OPENCC_SRC_DIR>.`,
          )
        }
        const stubPath = join(STUB_DIR, missingSpec)
        mkdirSync(dirname(stubPath), { recursive: true })
        if (!existsSync(stubPath)) {
          writeFileSync(
            stubPath,
            '// Auto-stub: lazy fallback for out-of-tree missing module\nexport default {}\n',
          )
          stubCount++
          console.warn(`[openccQueryBridge] auto-stubbed: ${missingSpec}`)
        }
        stubbedSpecs.add(missingSpec)
        openccModulePromise = null
        return importOpenccSrc()
      }
      throw err
    }
  })()
  return openccModulePromise
}

export async function* runViaOpenccQuery(
  opts: QueryOptions,
  config: OpenccAdapterConfig,
): AsyncIterable<RuntimeEvent> {
  const sessionId = opts.sessionId ?? opts.transcriptId ?? 'unknown'

  // 1. Pre-aborted.
  if (opts.abortSignal?.aborted) {
    yield toAbortedEvent({ sessionId, turnIndex: 0 }, String(opts.abortSignal.reason ?? 'aborted'))
    return
  }

  // 2. Translate params + attach core tools. buildOpenccQueryParams is
  // async because it dynamically imports opencc's `productionDeps()`
  // factory (avoiding Vite's static bundling of opencc-src).
  let params: any
  try {
    params = await buildOpenccQueryParams(opts, config)
  } catch (err) {
    yield toRuntimeErrorEvent(
      new Error(
        `[openccQueryBridge] failed to build QueryParams: ${(err as Error).message}`,
      ),
      { sessionId, turnIndex: 0 },
    )
    return
  }
  const zaiTools = (opts.tools ?? []) as any[]
  // Use opencc's BUILT-IN tools directly (Bash/Read/Edit/Write/
  // AskUserQuestion/Glob/Grep) instead of zai's wrapper layer.
  // See compat/tools/opencc/builtin.ts for trade-offs. The
  // `bridgeCtx` global lets the AskUserQuestion wrapper (which was
  // already constructed when getOpenccBuiltinTools() was first
  // called) access sessionId / askRegistry / onYield at call time.
  //
  // Tool events (e.g. tool_use:ask_pending from AskUserQuestion) are
  // pushed into pendingToolEvents. We drain this queue between
  // opencc stream events so they flow through translateRuntimeEvents
  // (which already handles tool_use:ask_pending → prompt.ask → SSE).
  const pendingToolEvents: Array<{ type: string; [k: string]: unknown }> = []
  const drainToolEvents = function* () {
    while (pendingToolEvents.length > 0) {
      const ev = pendingToolEvents.shift()!
      for (const out of translateSdkToRuntime(
        ev as unknown,
        { sessionId, turnIndex: 0, eventCounter: ++eventCounter },
      )) {
        yield out
      }
    }
  }
  ;(globalThis as any).__zaiBridgeCtx = {
    sessionId,
    askRegistry: config.askRegistry,
    abortSignal: opts.abortSignal,
    onYield: (ev: any) => {
      // CRITICAL: zai's tool callbacks (e.g. AskUserQuestion's
      // tool_use:ask_pending) fire SYNCHRONOUSLY before the tool
      // awaits. But the tool's await then blocks the bridge's
      // for-await on the opencc stream — so a queue drained
      // between opencc events never flushes until the tool returns
      // (which is when the user has already answered, too late).
      //
      // Workaround: the route attaches an EventEmitter to
      // globalThis.__zaiEventBus at init time. We emit directly to
      // it so prompt.ask / tool_call events reach the SSE
      // immediately, while the tool is still blocked awaiting the
      // user's answer.
      const bus = (globalThis as any).__zaiEventBus
      if (bus && typeof bus.emit === 'function') {
        bus.emit({
          type: ev.type,
          sessionId,
          ...(ev.id ? { id: ev.id } : {}),
          ...(ev.toolUseId ? { toolUseId: ev.toolUseId } : {}),
          ...(ev.questions ? { questions: ev.questions } : {}),
          ...(ev.metadata ? { metadata: ev.metadata } : {}),
          ...(ev.toolName ? { toolName: ev.toolName } : {}),
          ...(ev.input ? { input: ev.input } : {}),
        })
      } else {
        // Fallback: queue. Drainage will happen on the next opencc
        // stream event. (Without __zaiEventBus, ask_pending won't
        // reach the frontend until the tool returns.)
        pendingToolEvents.push({ type: ev.type, ...ev })
      }
    },
  }
  const coreTools = await getOpenccBuiltinTools()
  // zai tools win on name collision.
  const toolMap = new Map<string, any>()
  for (const t of coreTools) toolMap.set(t.name, t)
  for (const t of zaiTools) toolMap.set(t.name ?? t.name, t)
  params.tools = Array.from(toolMap.values())
  // Mirror tools onto toolUseContext.options.tools so opencc internals
  // that read `state.toolUseContext.options.tools` see them.
  if (params.toolUseContext?.options) {
    params.toolUseContext.options.tools = params.tools
  }

  // 3. Lazy import opencc-src.
  let openccQuery: any
  try {
    const mod = await importOpenccSrc()
    openccQuery = mod.query
  } catch (err) {
    yield toRuntimeErrorEvent(
      new Error(
        `[openccQueryBridge] failed to import opencc-src/query: ${(err as Error).message}. ` +
          `Ensure bun-protocol.mjs is loaded via \`tsx --import\` and any hand-stubs are in place.`,
      ),
      { sessionId, turnIndex: 0 },
    )
    return
  }

  // 4. Call opencc + stream forward.
  let eventCounter = 0
  try {
    const stream: AsyncIterable<unknown> = openccQuery(params)
    // Watchdog: after we see a message_stop or message_delta (the natural
    // "end of LLM output" signals opencc emits), if no further opencc
    // events arrive within WATCHDOG_MS, the opencc loop has stalled (e.g.
    // model produced end_turn but queryLoop's natural exit path didn't
    // fire, or a tool result fed into a continuation-nudge loop).
    //
    // Critical: when translateRuntimeEvents in routes/agent.ts sees
    // message_stop it yields runtime.done and the consumer's outer
    // for-await breaks, which calls .return() on THIS generator and
    // freezes the while loop at the next iter.next() — so we can't
    // rely on a Promise.race inside the loop to fire. Instead, the
    // timer is armed here and on fire, emits runtime.done via the same
    // __zaiEventBus side-channel used by AskUserQuestion. Without this
    // watchdog, the frontend stays stuck on "calling" forever.
    const iter = stream[Symbol.asyncIterator]()
    const WATCHDOG_MS = Number(process.env.ZAI_OPENCC_WATCHDOG_MS ?? 300_000)
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null
    const disarmWatchdog = () => {
      if (watchdogTimer) {
        clearTimeout(watchdogTimer)
        watchdogTimer = null
      }
    }
    const bus = (globalThis as any).__zaiEventBus
    while (true) {
      if (opts.abortSignal?.aborted) {
        disarmWatchdog()
        yield toAbortedEvent({ sessionId, turnIndex: 0 }, String(opts.abortSignal.reason ?? 'aborted'))
        return
      }
      const sdkMsg: IteratorResult<unknown, unknown> = await iter.next()
      if (sdkMsg.done) {
        disarmWatchdog()
        break
      }
      // Drain any tool events buffered by tool callbacks (e.g.
      // AskUserQuestion's tool_use:ask_pending) BEFORE the next
      // opencc stream event. The route's translateRuntimeEvents
      // already maps these to prompt.ask / tool_call SSE events.
      for (const ev of drainToolEvents()) {
        yield ev
      }
      for (const ev of translateSdkToRuntime(sdkMsg.value, { sessionId, turnIndex: 0, eventCounter })) {
        yield ev
        eventCounter++
      }
      const sdkType = (sdkMsg.value as any)?.type
      // Arm the watchdog after any "end of LLM output" signal:
      //   - message_stop  (Anthropic stop primitive)
      //   - message_delta (last message_delta carries stop_reason)
      // opencc doesn't always yield message_stop through the bridge
      // (sometimes it wraps the stop in an assistant message and
      // just closes the iterator), so trigger on either to be safe.
      // On any further event from the next turn, disarm so a long
      // follow-up turn doesn't trip the watchdog.
      if (sdkType === 'message_stop' || sdkType === 'message_delta') {
        if (WATCHDOG_MS > 0 && !watchdogTimer) {
          watchdogTimer = setTimeout(() => {
            console.warn(
              `[openccQueryBridge] watchdog tripped after ${sdkType} with ` +
                `no further opencc events for ${WATCHDOG_MS}ms — emitting runtime.done via side-channel`,
            )
            if (bus && typeof bus.emit === 'function') {
              bus.emit({
                type: 'runtime.done',
                sessionId,
                turnIndex: 0,
                eventId: `evt-watchdog-${Date.now()}`,
                ts: Date.now(),
                forced: true,
              })
            }
            watchdogTimer = null
          }, WATCHDOG_MS)
        }
      } else {
        // Disarm on any further event so a long next turn doesn't trip.
        disarmWatchdog()
      }
    }
    disarmWatchdog()
    // Final drain — any tool events buffered after the last opencc
    // event (e.g. AskUserQuestion yielded ask_pending during its
    // call) need to flush before the bridge returns.
    for (const ev of drainToolEvents()) {
      yield ev
    }
  } catch (err) {
    yield toRuntimeErrorEvent(err, { sessionId, turnIndex: 0 })
  }
}
