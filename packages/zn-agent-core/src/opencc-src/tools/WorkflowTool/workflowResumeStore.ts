// src/tools/WorkflowTool/workflowResumeStore.ts
//
// Plan12 Task 3 — auto-replay cache for workflow resume. When the
// caller passes `resumeFromRunId` to WorkflowTool, downstream
// `realSpawner` checks this store before launching a subagent; if the
// same `(prompt, opts)` was already run for that runId, the cached
// `report` is returned instantly instead of a fresh LLM call.
//
// Cache key: `JSON.stringify({ p, o }, sortedKeys)`. Sorting makes
// `{a:1, b:2}` and `{b:2, a:1}` collapse to the same key so callers
// don't have to maintain key order. Note: this is best-effort —
// non-JSON-safe values (e.g. functions, circular refs) will throw at
// stringify time. We don't catch that here because opts is normally a
// plain record of {model, tools, label, ...}; non-serializable opts
// would be a programmer error worth surfacing.

const store = new Map<
  string,
  Array<{ key: string; prompt: string; opts: unknown; result: unknown }>
>()

function cacheKey(prompt: string, opts: unknown): string {
  // Sort keys inside opts to make `{a:1, b:2}` and `{b:2, a:1}` collapse
  // to the same cache key. We do this with a replacer FUNCTION (not the
  // 2nd-arg key-array, which would strip the `o` key when opts is
  // empty) so the output shape is preserved regardless of opts.
  try {
    return JSON.stringify({ p: prompt, o: opts ?? null }, (_k, v) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const sorted: Record<string, unknown> = {}
        for (const k of Object.keys(v as Record<string, unknown>).sort()) {
          sorted[k] = (v as Record<string, unknown>)[k]
        }
        return sorted
      }
      return v
    })
  } catch {
    return JSON.stringify({ p: prompt, o: String(opts) })
  }
}

export function saveAgentResult(
  runId: string,
  call: { prompt: string; opts: unknown },
  result: unknown,
): void {
  let arr = store.get(runId)
  if (!arr) {
    arr = []
    store.set(runId, arr)
  }
  arr.push({
    key: cacheKey(call.prompt, call.opts),
    prompt: call.prompt,
    opts: call.opts,
    result,
  })
}

export function getCachedAgentResult(
  runId: string,
  call: { prompt: string; opts: unknown },
): unknown | undefined {
  const arr = store.get(runId)
  if (!arr) return undefined
  return arr.find(e => e.key === cacheKey(call.prompt, call.opts))?.result
}

export function clearRunCache(runId: string): void {
  store.delete(runId)
}
