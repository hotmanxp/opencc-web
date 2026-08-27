/**
 * Global registry for cleanup functions that should run during graceful shutdown.
 * This module is separate from gracefulShutdown.ts to avoid circular dependencies.
 */

// zai patch (2026-08-27): leaf ALS module, no cycle risk with gracefulShutdown.
import { getPrintSessionContext } from './printSessionRuntime.js'

// Global registry for cleanup functions
const cleanupFunctions = new Set<() => Promise<void>>()

/**
 * Register a cleanup function to run during graceful shutdown.
 * @param cleanupFn - Function to run during cleanup (can be sync or async)
 * @returns Unregister function that removes the cleanup handler
 */
export function registerCleanup(cleanupFn: () => Promise<void>): () => void {
  // zai patch (2026-08-27): in-process headless sessions route cleanup into
  // their own dispose bag so it runs on session destroy (and never leaks into
  // the process-wide registry across N sessions). CLI behavior unchanged.
  const ctx = getPrintSessionContext()
  if (ctx) {
    ctx.cleanups.add(cleanupFn)
    return () => ctx.cleanups.delete(cleanupFn)
  }
  cleanupFunctions.add(cleanupFn)
  return () => cleanupFunctions.delete(cleanupFn) // Return unregister function
}

/**
 * Run all registered cleanup functions.
 * Used internally by gracefulShutdown.
 */
export async function runCleanupFunctions(): Promise<void> {
  await Promise.all(Array.from(cleanupFunctions).map(fn => fn()))
}
