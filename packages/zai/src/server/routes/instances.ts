import { Router, type IRouter } from 'express'
import { existsSync, statSync } from 'node:fs'
import { getInstanceSupervisor, CURRENT_INSTANCE_ID } from '../services/instanceSupervisor.js'
import type { InstanceDefinition } from '../../shared/instances.js'

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

/**
 * Per-instance 生命周期操作的串行化闸。
 *
 * Why(fix-plan-10-05 H3):`doStart` / `doStop` / `doRestart` 各自读
 * `entry.child` / `entry.status` 做 check-then-act,中间夹着
 * `assertPortAvailable` / `probePort`(自动扫描最多 100 个候选,每个都是
 * 真 connect + bind + close 的 await)这样的长 I/O 窗口。两个并发的
 * start/stop 会在窗口中途被派发,看到过时的 entry 状态就各自往下走。
 *
 * 这里按 `id` 排队:同一实例的 start / stop / restart 严格顺序执行,
 * 不丢请求也不改变返回值语义(后来的请求排到前面那个完成后再跑)。
 * 不同 id 互不阻塞。
 */
const lifecycleQueues = new Map<string, Promise<unknown>>()

function serializeLifecycle<T>(id: string, task: () => Promise<T>): Promise<T> {
  const prev = lifecycleQueues.get(id) ?? Promise.resolve()
  const run = prev.then(task, task)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  lifecycleQueues.set(id, tail)
  // 队列排空后删掉,避免 id 集合无界增长(实例数量有界但会 churn)。
  void tail.then(() => {
    if (lifecycleQueues.get(id) === tail) lifecycleQueues.delete(id)
  })
  return run
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
 * Parse an optional boolean body field that also accepts an explicit
 * `null` as "clear this override back to inherit / auto".
 *
 * Same strictness as {@link parseBoolField} for everything but `null`:
 * only `undefined` (absent), `null` (clear) and a real `boolean` pass;
 * JSON-truthy like `1` / `"yes"` still 400. Used by PATCH `aa`, where
 * the UI genuinely needs a way to express "off = follow root again" —
 * without `null` the only off-switch would be `false`, which pins the
 * instance to force-off forever instead of returning it to auto.
 */
function parseNullableBoolField(
  v: unknown,
  field: string,
): { ok: true; value: boolean | null | undefined } | { ok: false; error: string } {
  if (v === undefined) return { ok: true, value: undefined }
  if (v === null) return { ok: true, value: null }
  if (typeof v !== 'boolean') return { ok: false, error: `${field} must be a boolean or null` }
  return { ok: true, value: v }
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
  // 应用 profile:仅允许 `undefined | 'task-factory' | 'weixin'`。`null` 与未知
  // 字符串都 400,对齐 POST 上其它字段(`port` 等)无 null / 无 typo 的口径 —
  // 创建路径没有"清除"语义,拒绝未知值避免给任务工厂实例错锁 mainAgent。
  // `weixin` 是微信专用实例 profile(独占微信通道 owner 锁),主实例会按
  // settings.weixinBot 自动用它拉起子实例。
  const rawApp = (req.body ?? {}).app
  if (rawApp !== undefined && rawApp !== 'task-factory' && rawApp !== 'weixin') {
    return badRequest(res, 'app must be "task-factory" or "weixin" when present')
  }
  // AA per-instance 覆盖:`undefined` = auto(跟随 root);`true` = 强制开;`false`
  // = 强制关。`parseBoolField` 与 `lan` 走同一收窄,非布尔值 400。
  const aa = parseBoolField((req.body ?? {}).aa, 'aa')
  if (!aa.ok) return badRequest(res, aa.error)
  try {
    const instance = await getInstanceSupervisor().createInstance({
      name: name.trim(),
      cwd,
      lan: lan.value === true,
      port: port.value as number | undefined,
      app: rawApp as InstanceDefinition['app'],
      aa: aa.value,
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
  // Per-call `aa` override 与 `lan` 对齐:body 显式给 `true` / `false` 临时覆盖
  // def.aa(不影响落盘),`undefined` 走 persisted value。
  const aa = parseBoolField((req.body ?? {}).aa, 'aa')
  if (!aa.ok) return badRequest(res, aa.error)
  try {
    // Per-call `lan` / `port` / `aa` override the persisted definition so the
    // UI can "start this one with --lan / on port X / with --aa just this once"
    // without rewriting the definition. `value === undefined` means
    // "use the persisted value".
    const overrides: { lan?: boolean; port?: number | null; aa?: boolean } = {}
    if (lan.value !== undefined) overrides.lan = lan.value
    if (port.value !== undefined) overrides.port = port.value
    if (aa.value !== undefined) overrides.aa = aa.value
    const instance = await serializeLifecycle(req.params.id, () =>
      getInstanceSupervisor().startInstance(
        req.params.id,
        Object.keys(overrides).length > 0 ? overrides : undefined,
      ),
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
    const instance = await serializeLifecycle(req.params.id, () =>
      getInstanceSupervisor().stopInstance(req.params.id),
    )
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
  const aa = parseBoolField((req.body ?? {}).aa, 'aa')
  if (!aa.ok) return badRequest(res, aa.error)
  try {
    const overrides: { lan?: boolean; port?: number | null; aa?: boolean } = {}
    if (lan.value !== undefined) overrides.lan = lan.value
    if (port.value !== undefined) overrides.port = port.value
    if (aa.value !== undefined) overrides.aa = aa.value
    const instance = await serializeLifecycle(req.params.id, () =>
      getInstanceSupervisor().restartInstance(
        req.params.id,
        Object.keys(overrides).length > 0 ? overrides : undefined,
      ),
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
  // PATCH aa:落盘到 def.aa,下次 start/restart 立即生效。三态:
  //   `true`  = 请求启用   `false` = 强制禁用   `null` = 清除,回到 auto(跟随 root)
  // 字段缺省 = 不改。
  //
  // `null` 是后加的。之前这里走 `parseBoolField`(只收 `undefined | boolean`),
  // 于是「清除回 auto」在 wire 上没法表达,客户端只能发空 body `{}`,撞上
  // supervisor 的「空补丁守卫」400 `no patchable fields supplied` —— 真机上
  // 的表现是 lan-agent 的 AA 开关点关不掉。UI 两态开关本身走 `true`/`false`
  // (关 = force-off),`null` 供 API 侧把 force-off 掰回 auto。
  const aa = parseNullableBoolField((req.body ?? {}).aa, 'aa')
  if (!aa.ok) return badRequest(res, aa.error)
  try {
    // `cwd` is intentionally absent from the HTTP surface: the only caller
    // that mutates it is the weixin orchestration (which validates the
    // directory itself, see weixinDedicatedInstance.ts). `name` is not
    // patchable at all.
    const patch: { lan?: boolean; port?: number | null; aa?: boolean | null } = {}
    if (lan.value !== undefined) patch.lan = lan.value
    if (port.value !== undefined) patch.port = port.value
    if (aa.value !== undefined) patch.aa = aa.value
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
