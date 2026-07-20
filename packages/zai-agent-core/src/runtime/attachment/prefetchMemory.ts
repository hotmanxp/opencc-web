/**
 * startRelevantMemoryPrefetch — turn 入点异步预取 session 相关 memory.
 *
 * Spec: docs/superpowers/specs/2026-07-19-zai-loop-resilience-d-attachment-design.md
 *
 * 契约 (spec §2.1 / §2.4 / §3):
 *   - 立即返回 handle, 不等待 IO (spec §3 行为 5).
 *   - prefetched 在 windowMs 内 resolve (默认 1500ms) 或更早 (若 cache 已就绪).
 *   - dispose() / signal abort → 立即 resolve null (spec §3 行为 6/8).
 *   - 内部异常不抛到外层, 写到 prefetched (spec §2.4).
 *
 * 实现策略: 用 setTimeout 限制 windowMs. 真正的 memory loader 是 duck-typed
 * 注入 (`MemoryCache.prefetch(sessionId)`); 默认实现返回空字符串 (此 module
 * 不耦合具体的 memory backend, wire-in 阶段由 caller 注入 cache).
 */
/** 默认窗口 (ms). spec §2.1 / umbrella §3.3 `config.runtime.memoryPrefetchWindow`. */
export const DEFAULT_MEMORY_PREFETCH_WINDOW_MS = 1500

/**
 * Memory cache duck-type. 调用方注入 (wire-in 阶段).
 *
 *   - prefetch(sessionId): 异步拉取 memory 内容. 不抛 — 内部 try/catch 返回 null.
 *   - get(sessionId): 同步读已缓存内容, 给 getAttachmentMessages 用.
 */
export interface MemoryCache {
  prefetch(sessionId: string): Promise<string | null>
  get(sessionId: string): string | null
}

/** 默认 cache — 仅实现 spec §3 行为 7 的"立即 resolve"语义, 不假数据. */
const defaultMemoryCache: MemoryCache = {
  async prefetch(_sessionId: string): Promise<string | null> {
    // 阶段 1 不接真 memory backend; 返回空字符串让 prefetched resolve 非空,
    // 调用方据此判断"已尝试过 prefetch".
    return ''
  },
  get(_sessionId: string): string | null {
    return null
  },
}

/** 默认 enabled 兜底 (spec §2.1: 默认 config.runtime.attachmentPrefetchEnabled=true). */
const DEFAULT_ENABLED = true

export interface MemoryPrefetchHandle {
  /** resolve 内容或 null (abort / dispose / 异常). */
  prefetched: Promise<string | null>
  /** 立即取消 timer, resolve null. 幂等 (spec §3 行为 6). */
  dispose(): void
}

export interface PrefetchMemoryOptions {
  sessionId: string
  /** 默认 1500ms. */
  windowMs?: number
  /** 默认 true. false 时 handle 立即 resolve null. */
  enabled?: boolean
  /** 外部 abort 信号; abort 等价于 dispose. */
  signal: AbortSignal
  /** 可选自定义 cache. 默认仅返回空 (阶段 1 stub). */
  cache?: MemoryCache
}

/**
 * 入口. 同步返回 handle; 内部 IO 异步进行.
 */
export function startRelevantMemoryPrefetch(
  opts: PrefetchMemoryOptions,
): MemoryPrefetchHandle {
  const {
    sessionId,
    windowMs = DEFAULT_MEMORY_PREFETCH_WINDOW_MS,
    enabled = DEFAULT_ENABLED,
    signal,
    cache = defaultMemoryCache,
  } = opts

  let resolvePrefetched!: (v: string | null) => void
  const prefetched: Promise<string | null> = new Promise((resolve) => {
    resolvePrefetched = resolve
  })

  let disposed = false
  let timer: NodeJS.Timeout | undefined
  const cleanup = () => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const resolveWithNull = () => {
    if (disposed) return
    disposed = true
    cleanup()
    resolvePrefetched(null)
  }

  const resolveWithContent = (content: string | null) => {
    if (disposed) return
    disposed = true
    cleanup()
    resolvePrefetched(content)
  }

  const dispose = () => {
    // 幂等: 多次调用安全 (spec §3 行为 6).
    resolveWithNull()
  }

  // 快速路径: enabled=false 或 signal 已 abort → 立即 null.
  if (enabled === false || signal.aborted) {
    // 用 queueMicrotask 推到下个 tick, 仍保持 "立即返回 handle" 的契约.
    queueMicrotask(resolveWithNull)
    return { prefetched, dispose }
  }

  // signal abort 监听 (spec §3 行为 8): 等价于 dispose.
  const onAbort = () => resolveWithNull()
  signal.addEventListener('abort', onAbort, { once: true })

  // 异步: 在 windowMs 之内尝试 prefetch; 任意错误吞到 prefetched (spec §2.4).
  const runAsync = async () => {
    try {
      const content = await Promise.race<string | null>([
        cache.prefetch(sessionId),
        new Promise<string | null>((resolve) => {
          timer = setTimeout(() => resolve(null), windowMs)
          timer.unref?.()
        }),
      ])
      // dispose / abort 已在 race 外 resolve 过; 这里再 resolve 是幂等的 (resolveWithContent 内部判 disposed).
      resolveWithContent(content ?? '')
    } catch (err) {
      // spec §2.4: 内部异常写到 prefetched, 不抛.
      console.warn('[attachment/prefetchMemory] cache.prefetch failed:', err)
      resolveWithContent(null)
    }
  }

  // 调度到下一 microtask, 让 handle 同步返回 (spec §3 行为 5).
  queueMicrotask(runAsync)

  return { prefetched, dispose }
}