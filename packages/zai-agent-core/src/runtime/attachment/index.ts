/**
 * D. Mid-turn Attachment + Memory Prefetch (spec 2026-07-19-zai-loop-resilience-d).
 *
 * Public surface re-exported for the wire-in phase (Phase 2 — out of D scope).
 *
 * Sub-spec contract:
 *   - getAttachmentMessages pulls mid-turn content from bash tracker +
 *     background runtime + skill prefetch snapshot + memory prefetch cache,
 *     sorted by consumedAt asc, never throws (returns [] on error).
 *   - startRelevantMemoryPrefetch returns a Disposable handle synchronously
 *     and resolves `prefetched` within windowMs (default 1500ms) or earlier
 *     if the cache is ready; abort / dispose immediately resolves null.
 */
export {
  getAttachmentMessages,
  type Attachment,
  type AttachmentSource,
  type GetAttachmentOptions,
  type AttachmentContext,
} from './get.js'

export {
  startRelevantMemoryPrefetch,
  type MemoryPrefetchHandle,
  type PrefetchMemoryOptions,
  type MemoryCache,
} from './prefetchMemory.js'