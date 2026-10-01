import { setMaxListeners } from 'events'

/**
 * Default max listeners for standard operations
 */
const DEFAULT_MAX_LISTENERS = 50

/**
 * Creates an AbortController with proper event listener limits set.
 * This prevents MaxListenersExceededWarning when multiple listeners
 * are attached to the abort signal.
 *
 * @param maxListeners - Maximum number of listeners (default: 50)
 * @returns AbortController with configured listener limit
 */
export function createAbortController(
  maxListeners: number = DEFAULT_MAX_LISTENERS,
): AbortController {
  const controller = new AbortController()
  setMaxListeners(maxListeners, controller.signal)
  return controller
}

/**
 * Per-parent bookkeeping for the shared abort listener below.
 *
 * `children` holds WeakRefs so an abandoned child never keeps the parent
 * (or the whole chain rooted at it) alive.
 */
type ParentChildSet = {
  signal: AbortSignal
  children: Set<WeakRef<AbortController>>
}

/**
 * signal → its live/possibly-dead child refs. Keyed weakly: the entry (and
 * the listener it owns) dies with the signal, so no cleanup is required.
 */
const childSets = new WeakMap<AbortSignal, ParentChildSet>()

/** Sweep threshold — keeps the Set from growing without bound on hot parents. */
const SWEEP_THRESHOLD = 64

/** The single listener every child of one parent shares. */
function abortAllChildren(this: ParentChildSet): void {
  const { children, signal } = this
  for (const ref of children) ref.deref()?.abort(signal.reason)
  children.clear()
}

/**
 * Creates a child AbortController that aborts when its parent aborts.
 * Aborting the child does NOT affect the parent.
 *
 * The parent carries exactly ONE 'abort' listener no matter how many
 * children it spawns — each child is a WeakRef inside that listener's
 * bookkeeping set. The previous per-child-listener design leaked: a child
 * that is never aborted left its handler attached forever, so long-lived
 * parents (the per-query controller gets one child per turn from
 * StreamingToolExecutor / per-tool children from attachments.ts) crossed
 * `setMaxListeners(50)` and emitted MaxListenersExceededWarning.
 *
 * Memory-safe: the parent only holds WeakRefs, so a child dropped without
 * being aborted is still collectable.
 *
 * @param parent - The parent AbortController
 * @param maxListeners - Maximum number of listeners on the child (default: 50)
 * @returns Child AbortController
 */
export function createChildAbortController(
  parent: AbortController,
  maxListeners?: number,
): AbortController {
  const child = createAbortController(maxListeners)

  // Fast path: parent already aborted, no bookkeeping needed
  if (parent.signal.aborted) {
    child.abort(parent.signal.reason)
    return child
  }

  let entry = childSets.get(parent.signal)
  if (!entry) {
    entry = { signal: parent.signal, children: new Set() }
    childSets.set(parent.signal, entry)
    parent.signal.addEventListener('abort', abortAllChildren.bind(entry), {
      once: true,
    })
  }
  entry.children.add(new WeakRef(child))

  // Drop WeakRefs whose child has been collected. Deref is the only way to
  // observe that, and the Set otherwise grows one entry per child forever.
  if (entry.children.size > SWEEP_THRESHOLD) {
    for (const ref of entry.children) {
      if (!ref.deref()) entry.children.delete(ref)
    }
  }

  return child
}
