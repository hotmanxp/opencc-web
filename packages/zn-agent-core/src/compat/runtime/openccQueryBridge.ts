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
import { toQueryParams } from './queryParamsAdapter.js'
import { translateSdkToRuntime } from './sdkEventAdapter.js'
import { defaultCoreToolsAsOpencc } from '../tools/opencc/index.js'
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

async function importOpenccSrc() {
  if (openccModulePromise) return openccModulePromise
  openccModulePromise = (async () => {
    try {
      // Dynamic import to a constructed path so Vite's static analysis
      // doesn't try to bundle opencc-src.
      const queryPath = join(OPENCC_SRC_DIR, 'query.js')
      return await import(queryPath)
    } catch (err: any) {
      // Lazy-stub fallback: if a .js file is missing in opencc-src,
      // create a minimal stub and retry the import.
      if (err?.code === 'ERR_MODULE_NOT_FOUND' && stubCount < STUB_LIMIT) {
        const match = err.message.match(/Cannot find module ['"]([^'"]+)['"]/i)
        const missing = match?.[1]
        if (missing && missing.endsWith('.js') && !missing.startsWith('node:') && !missing.includes('node_modules')) {
          const stubPath = join(STUB_DIR, missing)
          mkdirSync(dirname(stubPath), { recursive: true })
          if (!existsSync(stubPath)) {
            writeFileSync(stubPath, '// Auto-stub: lazy fallback for UI-shaped module\nexport default {}\n')
            stubCount++
            console.warn(`[openccQueryBridge] auto-stubbed: ${missing}`)
          }
          // Reset the promise so the next call retries the import.
          openccModulePromise = null
          return importOpenccSrc()
        }
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

  // 2. Translate params + attach core tools.
  const params = toQueryParams(opts, config)
  const zaiTools = (opts.tools ?? []) as any[]
  const coreTools = defaultCoreToolsAsOpencc()
  // zai tools win on name collision.
  const toolMap = new Map<string, any>()
  for (const t of coreTools) toolMap.set(t.name, t)
  for (const t of zaiTools) toolMap.set(t.name ?? t.name, t)
  params.tools = Array.from(toolMap.values())

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
    for await (const sdkMsg of stream) {
      if (opts.abortSignal?.aborted) {
        yield toAbortedEvent({ sessionId, turnIndex: 0 }, String(opts.abortSignal.reason ?? 'aborted'))
        return
      }
      eventCounter++
      for (const ev of translateSdkToRuntime(sdkMsg, { sessionId, turnIndex: 0, eventCounter })) {
        yield ev
      }
    }
  } catch (err) {
    yield toRuntimeErrorEvent(err, { sessionId, turnIndex: 0 })
  }
}
