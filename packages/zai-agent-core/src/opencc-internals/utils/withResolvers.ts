// @ts-nocheck
/**
 * Polyfill for Promise.withResolvers() (ES2024, Node 22+).
 * package.json declares "engines": { "node": ">=18.0.0" } so we can't use
 * the native one. The return type is also not in the standard lib until
 * ES2024, so define the type locally rather than referencing the global.
 */
export interface PromiseWithResolvers<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

export function withResolvers<T>(): PromiseWithResolvers<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}