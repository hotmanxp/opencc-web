/**
 * Maximum array length allowed across the workflow VM boundary.
 * Matches upstream claude-code's `qL6 = 4096`. Arrays longer than
 * this are rejected (not silently truncated) to surface script
 * bugs that try to materialize huge data sets.
 */
export const MAX_ARRAY_LEN = 4096

/**
 * Symbol used to mark an Error as "re-thrown from VM boundary" so
 * callers can distinguish VM-crossing errors from regular script
 * errors. (Reserved for future use; not currently surfaced.)
 */
const VM_BOUNDARY_ERROR = Symbol('vmArrayCap')

/**
 * Seal a value for safe crossing of the VM boundary in either
 * direction. Rules:
 * - Functions are dropped (they cannot cross safely).
 * - Arrays longer than MAX_ARRAY_LEN throw.
 * - __proto__, constructor, prototype keys are stripped (prototype-
 * pollution defense).
 * - Recursively seals nested objects + arrays.
 * - Primitives pass through.
 */
export function sealForVmBoundary(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || value === undefined) return value
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint' || t === 'symbol') {
    return value
  }
  if (t === 'function') return undefined // drop
  if (value instanceof Error) return value // errors are passed through with stack intact

  if (Array.isArray(value)) {
    const len = value.length
    if (!Number.isSafeInteger(len)) {
      throw vmBoundaryError('array length is not a safe integer across the workflow VM boundary')
    }
    if (len > MAX_ARRAY_LEN) {
      throw vmBoundaryError(`array length ${len} exceeds the maximum of ${MAX_ARRAY_LEN} supported across the workflow VM boundary`)
    }
    if (seen.has(value)) return seen.get(value)
    const out: unknown[] = new Array(len)
    seen.set(value, out)
    for (let i = 0; i < len; i++) {
      try { out[i] = sealForVmBoundary(value[i], seen) }
      catch (e) {
        if (isVmBoundaryError(e)) throw e
        out[i] = undefined
      }
    }
    return out
  }

  // Plain object (or class instance).
  // Use null prototype so the output has no `__proto__` accessor on its
  // prototype chain (otherwise `'__proto__' in out` is always true because
  // Object.prototype.__proto__ is an accessor).
  if (typeof value === 'object') {
    if (seen.has(value as object)) return seen.get(value as object)
    // Array-like duck-type guard: non-Array objects with a numeric `length`
    // (e.g. class instances, jQuery collections) still need length validation
    // so scripts can't smuggle in objects whose getter returns a non-safe
    // integer.
    const rawLen = (value as { length?: unknown }).length
    if (typeof rawLen === 'number') {
      if (!Number.isSafeInteger(rawLen)) {
        throw vmBoundaryError('array length is not a safe integer across the workflow VM boundary')
      }
      if (rawLen > MAX_ARRAY_LEN) {
        throw vmBoundaryError(`array length ${rawLen} exceeds the maximum of ${MAX_ARRAY_LEN} supported across the workflow VM boundary`)
      }
    }
    const out: Record<string, unknown> = Object.create(null)
    seen.set(value as object, out)
    for (const key of Object.keys(value as object)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
      try {
        const v = (value as Record<string, unknown>)[key]
        if (typeof v === 'function') continue // drop
        out[key] = sealForVmBoundary(v, seen)
      } catch (e) {
        if (isVmBoundaryError(e)) throw e
        // skip non-vm-boundary errors silently
      }
    }
    return out
  }

  return value
}

function vmBoundaryError(message: string): Error {
  const e = new Error(message)
  ;(e as Error & { [VM_BOUNDARY_ERROR]: boolean })[VM_BOUNDARY_ERROR] = true
  return e
}

export function isVmBoundaryError(e: unknown): boolean {
  return Boolean(
    e && typeof e === 'object' && (e as { [VM_BOUNDARY_ERROR]?: boolean })[VM_BOUNDARY_ERROR],
  )
}