import { isManagedChild } from '../../cli/managedChild.js'

/**
 * Send a `ready` IPC message to the supervisor announcing the bound port.
 *
 * Used by the child process entry path (`zai start` non-supervisor branch)
 * to tell the parent we are listening. Called once from `runDirectServer`
 * inside the http.Server listen callback so the supervisor can move from
 * `starting` to `running` and unblock restart promotion.
 *
 * No-op when `ZAI_SUPERVISOR_PID` is unset (dev / unit-test modes); this
 * keeps the call site unconditional without polluting non-managed boots.
 */
export function sendReady(port: number): void {
  if (!isManagedChild()) return
  if (typeof process.send !== 'function') return
  try {
    process.send({ type: 'ready', pid: process.pid, port })
  } catch {
    // supervisor may have detached between isManagedChild() and send;
    // swallowing matches the contract — readiness is best-effort.
  }
}
