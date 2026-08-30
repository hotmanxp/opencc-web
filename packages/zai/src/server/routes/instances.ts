import { Router, type IRouter } from 'express'
import { existsSync, statSync } from 'node:fs'
import { getInstanceSupervisor, CURRENT_INSTANCE_ID } from '../services/instanceSupervisor.js'
import type { RuntimeCore } from '../../shared/settings.js'

const router: IRouter = Router()

// instance 子实例(instance manager 派生)不能再 spawn 孙实例:
// 持有 ZAI_INSTANCE_ID 的进程就是 instance child,所有 /api/instances/* 路由
// 在这里直接 404,让前端拿到明确的"不可用"信号而不是 500。
// 服务端 server/index.ts 的 initInstanceSupervisor 也会跳过这种进程,
// 但路由层兜底 — 防止有人手动注入 env 绕过 init 检查。
function ensureNotInstanceChild(res: import('express').Response): boolean {
  if (process.env.ZAI_INSTANCE_ID) {
    res.status(404).json({ error: 'instance management not available on child' })
    return false
  }
  return true
}

function notFound(res: import('express').Response, msg: string): void {
  res.status(404).json({ error: msg })
}

function badRequest(res: import('express').Response, msg: string): void {
  res.status(400).json({ error: msg })
}

function handleError(res: import('express').Response, err: unknown): void {
  const code = (err as { code?: string } | null)?.code
  if (code === 'NOT_FOUND') {
    notFound(res, err instanceof Error ? err.message : 'not found')
    return
  }
  if (code === 'CURRENT_INSTANCE') {
    badRequest(res, err instanceof Error ? err.message : 'cannot operate on current instance')
    return
  }
  if (code === 'DUPLICATE_NAME') {
    res.status(409).json({ error: err instanceof Error ? err.message : 'duplicate' })
    return
  }
  if (code === 'INVALID_STATE') {
    badRequest(res, err instanceof Error ? err.message : 'invalid state')
    return
  }
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
}

/**
 * Parse an optional boolean body field. The contract is intentionally
 * strict: only `undefined` (absent) and a real `boolean` are accepted.
 * - absent → `{ value: undefined }` so callers that distinguish "use the
 *   default" from "explicit false" (POST /start, POST /restart) can
 *   forward `undefined` through to the supervisor;
 * - boolean → `{ value: true | false }` after normalising via `=== true`
 *   so JSON-truthy like `1`/`"yes"` can't slip past;
 * - everything else → `{ ok: false, error }` so the route can return 400
 *   with the offending field name in the message.
 */
function parseBoolField(
  v: unknown,
  field: string,
): { ok: true; value: boolean | undefined } | { ok: false; error: string } {
  if (v === undefined) return { ok: true, value: undefined }
  if (typeof v !== 'boolean') return { ok: false, error: `${field} must be a boolean` }
  return { ok: true, value: v === true }
}

/**
 * Parse an optional port body field. Tri-state contract:
 * - `undefined` (absent) → `{ value: undefined }` so callers can forward
 *   "no override" through to the supervisor (used by /start, /restart);
 * - `null` → `{ value: null }` only meaningful for PATCH, where it
 *   explicitly clears the pin back to auto. POST /instances rejects
 *   `null` at the call-site because there's nothing to clear on a
 *   brand-new definition;
 * - integer 1..65535 → `{ value: number }`;
 * - everything else → 400.
 */
function parsePortField(
  v: unknown,
  field: string,
): { ok: true; value: number | null | undefined } | { ok: false; error: string } {
  if (v === undefined) return { ok: true, value: undefined }
  if (v === null) return { ok: true, value: null }
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 65535) {
    return { ok: false, error: `${field} must be an integer between 1 and 65535` }
  }
  return { ok: true, value: v }
}

const RUNTIME_CORE_VALUES: readonly RuntimeCore[] = ['default', 'inproc', 'spawn', 'repl']

/**
 * Parse an optional `runtimeCore` body field. Tri-state contract mirrors
 * `parsePortField` so the call-site in POST/PATCH can collapse both
 * fields into the same `undefined | value | null` shape:
 *
 * - `undefined` (absent) → `{ value: undefined }` so callers can forward
 *   "no override" through to the supervisor (used by /start, /restart);
 * - `null` → `{ value: null }` only meaningful for PATCH, where it
 *   explicitly clears the per-instance override back to "inherit global
 *   `settings.runtimeCore`". POST /instances treats `null` as 400 to
 *   match the `port` discipline (nothing to clear on a brand-new
 *   definition);
 * - string ∈ `'default' | 'inproc' | 'spawn' | 'repl'` → persisted as
 *   the per-instance override;
 * - anything else → 400.
 *
 * Validation intentionally mirrors `applyRuntimeCoreFlag`'s accepted
 * value set so a typo like `runtimeCore: 'repll'` fails at the HTTP
 * boundary instead of silently degrading to "inherit".
 */
function parseRuntimeCoreField(
  v: unknown,
  field: string,
  allowNull: boolean,
): { ok: true; value: RuntimeCore | null | undefined } | { ok: false; error: string } {
  if (v === undefined) return { ok: true, value: undefined }
  if (v === null) {
    if (!allowNull) return { ok: false, error: `${field} must be one of [default, inproc, spawn, repl]` }
    return { ok: true, value: null }
  }
  if (typeof v !== 'string' || !RUNTIME_CORE_VALUES.includes(v as RuntimeCore)) {
    return { ok: false, error: `${field} must be one of [default, inproc, spawn, repl]` }
  }
  return { ok: true, value: v as RuntimeCore }
}

router.get('/instances', (_req, res) => {
  if (!ensureNotInstanceChild(res)) return
  res.json({ instances: getInstanceSupervisor().getSnapshots() })
})

router.get('/instances/:id', (req, res) => {
  if (!ensureNotInstanceChild(res)) return
  const snap = getInstanceSupervisor().getSnapshots().find((s) => s.id === req.params.id)
  if (!snap) return notFound(res, `instance ${req.params.id} not found`)
  res.json({ instance: snap })
})

router.post('/instances', async (req, res) => {
  if (!ensureNotInstanceChild(res)) return
  const { name, cwd } = (req.body ?? {}) as { name?: unknown; cwd?: unknown }
  if (typeof name !== 'string' || name.trim() === '') return badRequest(res, 'name is required')
  if (typeof cwd !== 'string' || cwd.trim() === '') return badRequest(res, 'cwd is required')
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return badRequest(res, 'cwd must be an existing directory')
  }
  const lan = parseBoolField((req.body ?? {}).lan, 'lan')
  if (!lan.ok) return badRequest(res, lan.error)
  // POST /instances never accepts `null` for `port` — a brand-new
  // definition has no pin to clear. Treat `null` as a type error here
  // even though parsePortField allows it for PATCH symmetry.
  const rawPort = (req.body ?? {}).port
  if (rawPort === null) return badRequest(res, 'port must be an integer between 1 and 65535')
  const port = parsePortField(rawPort, 'port')
  if (!port.ok) return badRequest(res, port.error)
  // Same discipline as port: POST /instances never accepts `null` for
  // `runtimeCore` — there's no override to clear on a brand-new
  // definition, and `null` only carries meaning on PATCH.
  const runtimeCore = parseRuntimeCoreField((req.body ?? {}).runtimeCore, 'runtimeCore', false)
  if (!runtimeCore.ok) return badRequest(res, runtimeCore.error)
  try {
    const instance = await getInstanceSupervisor().createInstance({
      name: name.trim(),
      cwd,
      lan: lan.value === true,
      port: port.value as number | undefined,
      runtimeCore: runtimeCore.value as RuntimeCore | undefined,
    })
    res.status(201).json({ instance })
  } catch (err) {
    handleError(res, err)
  }
})

router.post('/instances/:id/start', async (req, res) => {
  if (!ensureNotInstanceChild(res)) return
  if (req.params.id === CURRENT_INSTANCE_ID) return badRequest(res, 'cannot start current instance')
  const lan = parseBoolField((req.body ?? {}).lan, 'lan')
  if (!lan.ok) return badRequest(res, lan.error)
  const port = parsePortField((req.body ?? {}).port, 'port')
  if (!port.ok) return badRequest(res, port.error)
  try {
    // Per-call `lan` / `port` override the persisted definition so the
    // UI can "start this one with --lan / on port X just this once"
    // without rewriting the definition. `value === undefined` means
    // "use the persisted value".
    const overrides: { lan?: boolean; port?: number | null } = {}
    if (lan.value !== undefined) overrides.lan = lan.value
    if (port.value !== undefined) overrides.port = port.value
    const instance = await getInstanceSupervisor().startInstance(
      req.params.id,
      Object.keys(overrides).length > 0 ? overrides : undefined,
    )
    res.json({ instance })
  } catch (err) {
    handleError(res, err)
  }
})

router.post('/instances/:id/stop', async (req, res) => {
  if (!ensureNotInstanceChild(res)) return
  if (req.params.id === CURRENT_INSTANCE_ID) return badRequest(res, 'cannot stop current instance')
  try {
    const instance = await getInstanceSupervisor().stopInstance(req.params.id)
    res.json({ instance })
  } catch (err) {
    handleError(res, err)
  }
})

router.post('/instances/:id/restart', async (req, res) => {
  if (!ensureNotInstanceChild(res)) return
  if (req.params.id === CURRENT_INSTANCE_ID) return badRequest(res, 'cannot restart current instance')
  const lan = parseBoolField((req.body ?? {}).lan, 'lan')
  if (!lan.ok) return badRequest(res, lan.error)
  const port = parsePortField((req.body ?? {}).port, 'port')
  if (!port.ok) return badRequest(res, port.error)
  try {
    const overrides: { lan?: boolean; port?: number | null } = {}
    if (lan.value !== undefined) overrides.lan = lan.value
    if (port.value !== undefined) overrides.port = port.value
    const instance = await getInstanceSupervisor().restartInstance(
      req.params.id,
      Object.keys(overrides).length > 0 ? overrides : undefined,
    )
    res.json({ instance })
  } catch (err) {
    handleError(res, err)
  }
})

router.patch('/instances/:id', async (req, res) => {
  if (!ensureNotInstanceChild(res)) return
  if (req.params.id === CURRENT_INSTANCE_ID) return badRequest(res, 'cannot patch current instance')
  const lan = parseBoolField((req.body ?? {}).lan, 'lan')
  if (!lan.ok) return badRequest(res, lan.error)
  const port = parsePortField((req.body ?? {}).port, 'port')
  if (!port.ok) return badRequest(res, port.error)
  // PATCH is the only surface where `runtimeCore: null` is meaningful:
  // it explicitly clears the per-instance override back to "inherit
  // global `settings.runtimeCore`". Allowed here, rejected on POST.
  const runtimeCore = parseRuntimeCoreField((req.body ?? {}).runtimeCore, 'runtimeCore', true)
  if (!runtimeCore.ok) return badRequest(res, runtimeCore.error)
  try {
    const patch: { lan?: boolean; port?: number | null; runtimeCore?: RuntimeCore | null } = {}
    if (lan.value !== undefined) patch.lan = lan.value
    if (port.value !== undefined) patch.port = port.value
    if (runtimeCore.value !== undefined) patch.runtimeCore = runtimeCore.value
    const instance = await getInstanceSupervisor().updateInstance(req.params.id, patch)
    res.json({ instance })
  } catch (err) {
    handleError(res, err)
  }
})

router.delete('/instances/:id', async (req, res) => {
  if (!ensureNotInstanceChild(res)) return
  if (req.params.id === CURRENT_INSTANCE_ID) return badRequest(res, 'cannot delete current instance')
  try {
    await getInstanceSupervisor().removeInstance(req.params.id)
    res.status(204).end()
  } catch (err) {
    handleError(res, err)
  }
})

export default router
