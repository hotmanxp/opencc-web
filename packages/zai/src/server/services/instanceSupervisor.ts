import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { basename, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import { eventBus, type ServerEventInput } from './eventBus.js'
import {
  EMPTY_INSTANCE_STATUS,
  readInstancesFile,
  writeInstancesFile,
  type InstancesFile,
} from './instanceStore.js'
import { assertPortAvailable, listen } from '../../cli/ports.js'
import type { InstanceDefinition, InstanceSnapshot, InstanceStatus } from '../../shared/instances.js'

export const INSTANCE_BASE_PORT = 9201
export const HEARTBEAT_TIMEOUT_MS = 20_000
export const HEARTBEAT_POLL_MS = 5_000
// After a supervisor restart, entries hydrated from disk have no live child,
// so the 20s heartbeat-timeout path can never fire for them — an instance
// that died while the supervisor was down would show `running` forever. Any
// child-less entry still in an active state (running/starting/stopping) whose
// last activity is older than this window is force-reset to `stopped` on
// hydrate and on every heartbeat tick.
export const STALE_RUNNING_RESET_MS = 30 * 60_000
export const STOP_TIMEOUT_MS = 10_000
export const SHUTDOWN_TIMEOUT_MS = 3_000
export const CURRENT_INSTANCE_ID = '__current__'
export const MAX_PORT_ATTEMPTS = 100
// Upper bound on how long `doStop` will continue awaiting a child's `exit`
// after a SIGKILL has already been issued. Real OS processes are guaranteed to
// terminate immediately when SIGKILL is delivered, so this window only exists
// to cover pathological cases (e.g. zombie children, mocks that forget to
// emit `exit`). If the bound is exceeded we resolve anyway — the next
// lifecycle op will treat the entry as no longer alive.
export const POST_SIGKILL_EXIT_GRACE_MS = 1_500

export class InstanceSupervisorError extends Error {
  readonly code: 'NOT_FOUND' | 'CURRENT_INSTANCE' | 'DUPLICATE_NAME' | 'INVALID_STATE'
  constructor(code: InstanceSupervisorError['code'], message: string) { super(message); this.code = code }
}

// Debugger / profiler flags bind a fixed port (or a fixed socket) for the
// lifetime of the process. A child that inherits `--inspect` would try to bind
// the same port the parent already holds and die at startup, so they are the
// one category of `execArgv` that must NOT be propagated. Everything else
// (loaders, `--require`/`--import` preflight hooks, `--enable-source-maps`,
// V8 flags) is exactly what the child needs in order to run the same entry the
// parent is running. Matches every form node accepts: `--inspect`,
// `--inspect=host:port`, `--inspect-brk`, `--debug-port`.
const NON_INHERITABLE_EXEC_ARGV = /^-{1,2}(inspect|debug)([-=]|$)/

/**
 * 把父进程的 `process.execArgv` 转成子进程可用的 node 参数。
 *
 * Why: 子进程的入口是 `cliEntry`(默认 `process.argv[1]`),dev 下就是
 * `src/cli/index.ts` —— **TypeScript 源文件**。而 spawn 用的是裸
 * `process.execPath`(node),不带任何 loader,于是 ESM 解析 `.js` 后缀的
 * 相对导入时找不到对应的 `.ts` 实体文件,子进程一起来就
 * `ERR_MODULE_NOT_FOUND: .../services/accessLog.js`,实例永远停在 `down`。
 * 生产走 `bin/zai.js`(纯 JS、execArgv 为空)所以一直没暴露。
 *
 * 唯一忠实的修法是让子进程**继承父进程实际在用的 loader 链**:tsx 的
 * `--require preflight.cjs` + `--import tsx/loader.mjs`,加上 zai 自己为了
 * 拦 `bun:` 协议加的 `--loader bun-protocol.mjs`。
 *
 * Why 要绝对化:dev 下那条 bun-protocol loader 在 `execArgv` 里是**相对路径**
 * (`./node_modules/@zn-ai/...`)。Node 按**进程 cwd** 解析它,而子进程的
 * `cwd` 是用户给实例配的 `entry.def.cwd` —— 照抄过去必然解析失败,而且失败
 * 方式跟原来的 bug 一模一样(loader 没挂上 → `.ts` 解析不了),非常难查。
 * 所以凡是 `./` / `../` 开头的参数都相对**父进程 cwd** 绝对化成 file:// URL
 * (URL 对 `--loader` 和 `--import` 都合法,不带协议反而有被当成 bare
 * specifier 的风险)。
 *
 * @param execArgv 父进程参数,注入以便单测
 * @param parentCwd 解析相对路径的基准,注入以便单测
 */
export function childExecArgv(execArgv: string[], parentCwd: string): string[] {
  return execArgv
    .filter((arg) => !NON_INHERITABLE_EXEC_ARGV.test(arg))
    .map((arg) =>
      arg.startsWith('./') || arg.startsWith('../')
        ? pathToFileURL(resolvePath(parentCwd, arg)).href
        : arg,
    )
}

export type InstanceSupervisorDeps = {
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess
  probePort: (start: number, maxAttempts?: number) => Promise<number>
  /**
   * Verify a user-pinned port is bindable; rejects if the port is
   * already in use. Used when an instance definition (or per-start
   * override) carries a fixed `port`. Default impl delegates to
   * `assertPortAvailable` from `cli/ports.ts`.
   */
  assertPortAvailable: (port: number) => Promise<void>
  readFile: () => Promise<InstancesFile>
  writeFile: (file: InstancesFile) => Promise<void>
  emit: (event: ServerEventInput, opts?: { recordHistory?: boolean }) => void
  now: () => number
  sleep: (ms: number) => Promise<void>
}

// Per-child tracking. `timeoutKilled` / `userStopping` / `scheduledKill`
// live on the *child* (not on the entry) so that late exit / kill events
// for a child whose reference has been replaced cannot poison the new
// child's state. `activeChild` is the entry's current child pointer; the
// exit handler closes over its own child ref and bails out when it no
// longer matches `activeChild`.
interface ChildState {
  timeoutKilled: boolean
  userStopping: boolean
  scheduledKill: ReturnType<typeof setTimeout> | null
}
type Entry = { def: InstanceDefinition; status: InstanceStatus; child: ChildProcess | null; childState: ChildState | null }

export interface InstanceSupervisor {
  getSnapshots: () => InstanceSnapshot[]
  createInstance: (input: { name: string; cwd: string; lan?: boolean; port?: number | null; app?: InstanceDefinition['app']; aa?: boolean }) => Promise<InstanceSnapshot>
  startInstance: (id: string, opts?: { lan?: boolean; port?: number | null; aa?: boolean }) => Promise<InstanceSnapshot>
  stopInstance: (id: string) => Promise<InstanceSnapshot>
  restartInstance: (id: string, opts?: { lan?: boolean; port?: number | null; aa?: boolean }) => Promise<InstanceSnapshot>
  removeInstance: (id: string) => Promise<void>
  /**
   * Patch definition fields that can change after creation: `lan`, `port`,
   * `cwd` and `aa`. `lan` is a boolean toggle; `port` follows the tri-state
   * contract — `number` persists, `null` clears back to auto, `undefined`
   * is a no-op; `cwd` is a plain replacement (the caller validates that
   * the directory exists — same contract as `createInstance`); `aa` is a
   * boolean toggle taking effect on the next start/restart.
   *
   * `cwd` is patchable because the weixin panel treats the dedicated
   * instance's working directory as a *saved setting* rather than a
   * create-time argument: the instance is auto-provisioned and long-lived,
   * so remove + recreate would drop the channel and hand the user a new
   * instance id every time they edit the field. `startInstance` /
   * `restartInstance` deliberately never rewrite `def.cwd` — only this
   * explicit patch does.
   *
   * `name` stays non-patchable: renames are cosmetic and would have to
   * re-run the duplicate-name check, which the definition layer does not
   * model.
   *
   * `aa: null` is the "clear" form: it **deletes** `def.aa` so the instance
   * returns to `auto` (follow root). Distinct from `aa: false`, which pins
   * the instance to force-off — that one is what the two-state UI switch
   * sends for OFF. Mirrors `port: null` (clear the pin). Before this
   * existed "auto" was unreachable over HTTP: the route's `parseBoolField`
   * rejected a JSON `null`, so a client wanting it had to send an empty
   * patch, which the no-op guard below then refused with a 400.
   */
  updateInstance: (id: string, patch: { lan?: boolean; port?: number | null; cwd?: string; aa?: boolean | null }) => Promise<InstanceSnapshot>
  shutdown: () => Promise<void>
}

interface InitOptions { cwd: string; dataDir?: string; cliEntry?: string; deps?: Partial<InstanceSupervisorDeps> }

// Module-level capture of the root process's listening port. Set when
// initInstanceSupervisor runs; read in doStart when constructing AA env
// vars for spawned children. Read via `getRootPort()`.
let rootPort: string | null = null;
function initRootPort(port: string): void { rootPort = port; }
function getRootPort(): string | null { return rootPort; }
let singleton: InstanceSupervisor | null = null
// In-flight initialization promise. If `initInstanceSupervisor` is called
// while a previous call is still hydrating, the new call awaits the same
// promise and reuses the resulting singleton. Without this guard two
// concurrent callers could each see `singleton === null` and race to
// construct independent supervisors.
let initPromise: Promise<InstanceSupervisor> | null = null

export function getInstanceSupervisor(): InstanceSupervisor {
  if (!singleton) throw new Error('instanceSupervisor not initialized')
  return singleton
}

export function resetInstanceSupervisorForTests(): void {
  singleton = null
  initPromise = null
}

async function probePortDefault(start: number, maxAttempts = MAX_PORT_ATTEMPTS): Promise<number> {
  for (let offset = 0; offset < maxAttempts; offset++) {
    const candidate = start + offset
    try { const server = await listen(candidate); server.close(); return candidate } catch { /* occupied */ }
  }
  throw new Error(`No available port found in range [${start}, ${start + maxAttempts - 1}]`)
}

interface ChildReadyMessage { type: 'ready'; pid?: number; port: number }
interface ChildHeartbeatMessage { type: 'heartbeat' }
interface ChildRestartMessage { type: 'restart'; reason?: string }
type ChildIpcMessage = ChildReadyMessage | ChildHeartbeatMessage | ChildRestartMessage | { type?: string }
function isChildReadyMessage(msg: ChildIpcMessage): msg is ChildReadyMessage {
  return msg?.type === 'ready' && typeof (msg as { port?: unknown }).port === 'number'
}
function isChildHeartbeatMessage(msg: ChildIpcMessage): msg is ChildHeartbeatMessage {
  return msg?.type === 'heartbeat'
}
function isChildRestartMessage(msg: ChildIpcMessage): msg is ChildRestartMessage {
  return msg?.type === 'restart'
}

export async function initInstanceSupervisor(opts: InitOptions): Promise<InstanceSupervisor> {
  if (singleton) return singleton
  if (initPromise) return initPromise
  // Capture the root's port so spawned children know where to forward events.
  // We capture here so it's set even if no instance is ever started (rare,
  // but keeps the invariant "supervisor always knows the root port" simple).
  initRootPort(opts.deps?.spawn ? (process.env.ZAI_PORT ?? '9201') : (process.env.ZAI_PORT ?? '9201'));
  initPromise = (async () => {
    const deps: InstanceSupervisorDeps = {
      spawn: opts.deps?.spawn ?? nodeSpawn,
      probePort: opts.deps?.probePort ?? probePortDefault,
      assertPortAvailable: opts.deps?.assertPortAvailable ?? ((port) => assertPortAvailable(port)),
      readFile: opts.deps?.readFile ?? (() => readInstancesFile(opts.dataDir)),
      writeFile: opts.deps?.writeFile ?? ((f) => writeInstancesFile(f, opts.dataDir)),
      emit: opts.deps?.emit ?? ((e) => eventBus.emit(e)),
      now: opts.deps?.now ?? Date.now,
      sleep: opts.deps?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    }
    const cliEntry = opts.cliEntry ?? process.argv[1] ?? ''
    const entries = new Map<string, Entry>()
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null
    const emit = (instanceId: string, status: InstanceStatus) => deps.emit({ type: 'instance.changed', instanceId, state: status.state, port: status.port, pid: status.pid, lastHeartbeatAt: status.lastHeartbeatAt })
    // 心跳 tick 专用:只推给**当前在线**的订阅者,不进 eventBus 的重放缓冲。
    //
    // Why (2026-10-07):心跳每 HEARTBEAT_POLL_MS(5s) 一次、每实例一条,
    // N 个运行实例 ≈ N/5 条每秒。而 history 上限只有 CAPACITY=256
    // (eventBus.ts),于是全局 history 每约 256/(N/5) 秒被心跳事件彻底刷满
    // —— 实测 5 实例时 history 时间跨度只有 268s,前 256 条里 254 条是
    // instance.changed,把 server.connected / session.* / job.* 全挤掉,
    // 导致重连补发(replay)失效。
    //
    // 心跳**本就不该进重放缓冲**:它是「进程还活着」的周期性信号,不带状态
    // 跃迁,重放给新客户端没有增量信息 —— 新连接本来就会收到一条
    // server.connected 触发 hydrate,以及 /instances 页自己的
    // `loadInstances()` 冷拉。真正需要进 history 的是状态跃迁
    // (starting→running→down 等),那些走上面的 `emit`,不受影响。
    const emitHeartbeat = (instanceId: string, status: InstanceStatus) => deps.emit(
      { type: 'instance.changed', instanceId, state: status.state, port: status.port, pid: status.pid, lastHeartbeatAt: status.lastHeartbeatAt },
      { recordHistory: false },
    )
    const snapshotOf = (entry: Entry): InstanceSnapshot => ({ ...entry.def, ...entry.status, isCurrent: false })
    const currentSnapshot = (): InstanceSnapshot => ({ id: CURRENT_INSTANCE_ID, name: basename(opts.cwd) || opts.cwd, cwd: opts.cwd, createdAt: '', state: 'running', port: Number(process.env.ZAI_PORT ?? 0) || null, pid: process.pid, startedAt: new Date(deps.now()).toISOString(), lastHeartbeatAt: null, lastError: null, isCurrent: true })
    const ensureNotCurrent = (id: string) => { if (id === CURRENT_INSTANCE_ID) throw new InstanceSupervisorError('CURRENT_INSTANCE', 'cannot operate on current instance') }
    const getEntry = (id: string) => { const entry = entries.get(id); if (!entry) throw new InstanceSupervisorError('NOT_FOUND', `instance ${id} not found`); return entry }
    const persist = async () => { const definitions: InstanceDefinition[] = []; const statuses: Record<string, InstanceStatus> = {}; for (const [id, entry] of entries) { definitions.push(entry.def); statuses[id] = entry.status } await deps.writeFile({ definitions, statuses }) }
    // Serialised, best-effort persistence. Lifecycle transitions are not
    // guaranteed to land on disk — losing one is acceptable; landing an
    // older snapshot (e.g. `starting`) AFTER a later one (e.g. `running`)
    // would be worse than losing a write, so we chain every persist call
    // through `writeChain` and warn loudly if a writer rejects.
    let writeChain: Promise<void> = Promise.resolve()
    const persistSafe = () => { writeChain = writeChain.then(() => persist().catch((err: unknown) => { const msg = err instanceof Error ? err.stack ?? err.message : String(err); console.warn(`[instanceSupervisor] persist failed: ${msg}`) })) }
    const setStatus = (entry: Entry, patch: Partial<InstanceStatus>) => { entry.status = { ...entry.status, ...patch }; return entry.status }
    // Last known activity for an entry: freshest of heartbeat, start time,
    // or creation time. Used to decide stale-running resets.
    const lastActivityAt = (entry: Entry): number => {
      const ts = entry.status.lastHeartbeatAt ?? entry.status.startedAt ?? entry.def.createdAt
      return ts ? new Date(ts).getTime() : 0
    }
    // Force-reset a child-less entry stuck in an active state whose last
    // activity predates STALE_RUNNING_RESET_MS. Keeps `lastHeartbeatAt` so
    // the UI can still show when the instance was last alive; clears the
    // runtime endpoints and any stale error. Returns true when reset.
    //
    // On hydration there is never an attached child (a fresh root process
    // can't re-adopt the previous root's children), so a persisted
    // `running`/`starting` is only believable while its pid is actually
    // alive. Previously we waited STALE_RUNNING_RESET_MS (30 min) on
    // lastActivityAt alone, which meant a child killed seconds earlier
    // kept reporting state:"running" with a dead pid and a port nobody
    // was listening on — the supervisor then refused to start it again
    // ("already running"), and AA's portFromRuntime liveness probe
    // rejected the only mapping. Signal-0 liveness probing is the fix;
    // a genuinely-alive pid still falls through to the 30-min rule so we
    // don't stomp on a process we can't actually manage.
    const isPidAlive = (pid: number | null | undefined): boolean => {
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
      try {
        process.kill(pid, 0)
        return true
      } catch (err) {
        // EPERM means the pid exists but belongs to another user — treat
        // as alive so we don't try to manage (or report dead) someone
        // else's process.
        return (err as NodeJS.ErrnoException).code === 'EPERM'
      }
    }
    const resetStaleActive = (entry: Entry, nowMs: number): boolean => {
      if (entry.child) return false
      const st = entry.status.state
      if (st !== 'running' && st !== 'starting' && st !== 'stopping') return false
      if (!isPidAlive(entry.status.pid)) {
        // Pid is gone — the child cannot possibly still be serving.
        setStatus(entry, { state: 'stopped', port: null, pid: null, lastError: null })
        return true
      }
      if (nowMs - lastActivityAt(entry) <= STALE_RUNNING_RESET_MS) return false
      setStatus(entry, { state: 'stopped', port: null, pid: null, lastError: null })
      return true
    }

    // Schedule a deferred `kill()` (e.g. post-SIGINT SIGKILL escalation).
    // When the timeout fires we MUST resolve the waiter's promise too —
    // otherwise `doStop`/`shutdown` hang forever when the child never emits
    // `exit` (e.g. FakeChild, or pathological OS processes). The `onFire`
    // callback resolves the waiter; it runs alongside the kill attempt.
    // If the child emits `exit` first, the scheduled kill is cancelled and
    // `onFire` is never invoked.
    const scheduleKill = (child: ChildProcess, sig: NodeJS.Signals, ms: number, childState: ChildState, onFire: () => void): void => {
      const handle = setTimeout(() => {
        childState.scheduledKill = null
        try { child.kill(sig) } catch { /* ignore */ }
        onFire()
      }, ms)
      // Don't keep the event loop alive solely for this timer.
      handle.unref()
      childState.scheduledKill = handle
    }

    const attachChild = (entry: Entry, child: ChildProcess) => {
      // Bind child-specific state to this child. The exit handler closes
      // over the local refs so a stale exit from a replaced child can never
      // touch the new entry.child.
      const childState: ChildState = { timeoutKilled: false, userStopping: false, scheduledKill: null }
      entry.child = child
      entry.childState = childState
      child.on('message', (raw: unknown) => {
        if (!raw || typeof raw !== 'object') return
        const msg = raw as ChildIpcMessage
        if (isChildReadyMessage(msg)) {
          const now = new Date(deps.now()).toISOString()
          setStatus(entry, { state: 'running', port: msg.port, pid: msg.pid ?? child.pid ?? null, startedAt: now, lastHeartbeatAt: now, lastError: null })
          emit(entry.def.id, entry.status)
          persistSafe()
        } else if (isChildHeartbeatMessage(msg)) {
          setStatus(entry, { lastHeartbeatAt: new Date(deps.now()).toISOString() })
          emitHeartbeat(entry.def.id, entry.status)
        } else if (isChildRestartMessage(msg)) {
          // instance child 请求重启(设置面板「重启服务」→ /api/system/restart →
          // sendRestart → IPC 'restart')。复用 restartInstance(stop+start)重新
          // 拉起;否则 child 退出后 exit handler 只把它标记为 down,永远不会
          // respawn — 表现为「重启只关闭不重启」。先置 userStopping,让中途的
          // exit 标记成 stopped 而非 down。
          childState.userStopping = true
          void supervisor.restartInstance(entry.def.id).catch((err) => {
            const message = err instanceof Error ? err.message : String(err)
            console.warn(`[instanceSupervisor] restart child ${entry.def.id} failed: ${message}`)
          })
        }
      })
      child.on('exit', (code: number | null) => {
        // Stale-child isolation: if a new child has been attached, this
        // exit event belongs to an old child and must not mutate the
        // replacement's state.
        if (entry.child !== child) return
        entry.child = null
        entry.childState = null
        if (childState.scheduledKill) { clearTimeout(childState.scheduledKill); childState.scheduledKill = null }
        if (childState.timeoutKilled) { childState.timeoutKilled = false; return }
        // 主动退出(设置面板「关闭服务」→ cleanupAndExit(0)→ exit code 0)
        // 与 userStopping 一样标记 stopped;只有非 0 / 信号退出才算异常 down。
        // 与顶层 supervisor.ts 的约定一致(exitCode = code ?? 0)。
        if (childState.userStopping || code === 0) { setStatus(entry, { state: 'stopped', port: null, pid: null, lastError: null }); emit(entry.def.id, entry.status); persistSafe(); return }
        setStatus(entry, { state: 'down', port: null, pid: null, lastError: { at: new Date(deps.now()).toISOString(), message: `process exited with code ${code ?? 'null'}` } }); emit(entry.def.id, entry.status); persistSafe()
      })
    }

    const doStart = async (id: string, opts?: { lan?: boolean; port?: number | null; aa?: boolean }) => {
      const entry = getEntry(id)
      if (entry.status.state === 'starting' || entry.status.state === 'running') return snapshotOf(entry)
      setStatus(entry, { state: 'starting', lastError: null })
      emit(id, entry.status)
      persistSafe()

      try {
        // Port resolution priority:
        //   1. `opts.port` per-call override (e.g. POST /start body)
        //   2. `entry.def.startPort` persisted user-pinned port
        //   3. `probePort(INSTANCE_BASE_PORT)` legacy auto-scan
        // Both explicit paths validate via `assertPortAvailable` so a
        // stale / already-bound pin fails loudly (we never silently
        // bump to a neighbouring port — that surprises users who
        // expected a specific number). `null` / `undefined` opt back
        // into auto-scan, preserving the pre-pin behaviour exactly.
        let port: number
        const pinned = opts?.port !== undefined ? opts.port : entry.def.startPort
        if (typeof pinned === 'number' && Number.isInteger(pinned)) {
          await deps.assertPortAvailable(pinned)
          port = pinned
        } else {
          port = await deps.probePort(INSTANCE_BASE_PORT)
        }
        // `opts.lan` (per-call override from /start) wins over the
        // persisted `def.lan`. Default is loopback — opting in to LAN
        // exposure must be deliberate so a dev's machine doesn't leak
        // workspaces they didn't intend to share.
        const useLan = opts?.lan ?? entry.def.lan ?? false
        const args: string[] = [
          // Loader chain first: node requires every `--loader`/`--import` to
          // appear before the entry script. See childExecArgv for why the
          // child needs them at all (dev runs a .ts entry).
          ...childExecArgv(process.execArgv, process.cwd()),
          cliEntry, 'start', '--managed-child', '--port', String(port), '--no-open',
        ]
        if (useLan) args.push('--lan')
        // 应用 profile 透传：把 `--app <profile>` 传给 child，让 child 的
        // `cli/index.ts` action 落到 `process.env.ZAI_APP`。两个 profile 的
        // 下游消费者各自读它：
        //   - `task-factory` → `routes/agent.ts` 锁定 `mainAgent`；
        //   - `weixin` → `maybeAutoStartWeixinBot()` 才允许启动微信通道
        //     （其余进程一律不碰通道，见 weixinDedicatedInstance.ts）。
        // 值域已在 `routes/instances.ts` 收窄；这里原样透传。
        if (entry.def.app) args.push('--app', entry.def.app)
        // AA 决策(三态 def.aa × per-call override × root 门禁):
        //   - def.aa=undefined  → auto:跟随 root 当前是否带 --aa
        //   - def.aa=true       → force-on:仅在 root 启 AA 时生效
        //   - def.aa=false      → force-off:即便 root 启 AA,该 child 也不带 --aa
        // opts.aa 一旦给出就完全覆盖 def.aa,与 lan 的 per-call override 一致。
        //
        // **root 是硬门禁**:`ZAI_AA_ENABLED=1` 且 rootPort 已知才可能给 child
        // 加 `--aa`。child 端 AA 桥依赖 `ZAI_AA_PARENT_URL` 才能把事件转发给
        // AA Cloud;没有 parent URL 时 childEventReporter.start() 会 early
        // return(child 会白挂一个 WS 客户端却什么都发不出去)。所以 root 没开
        // → 子实例一定关,哪怕 def.aa=true 也不给 `--aa`。
        //
        // ZAI_AA_PARENT_URL must point to the ROOT process (the user's
        // `zai start`), NOT the child itself — otherwise child events loop
        // back to the child's own Express and fail (no RuntimeRegistry
        // there). The supervisor captured this via initInstanceSupervisor().
        const rootPort = getRootPort();
        const rootHasAa = process.env.ZAI_AA_ENABLED === '1' && !!rootPort;
        const defEffective = entry.def.aa === undefined
          ? rootHasAa
          : entry.def.aa === true;
        const useAa = opts?.aa !== undefined ? opts.aa === true : defEffective;
        if (useAa && !rootHasAa) {
          // 用户显式要求 force-on,但 root 没开 AA —— warn 提示这次不会生效。
          // root 启 AA 后下次 start/restart 自动接上,无需重设 def.aa。
          console.warn(
            `[instanceSupervisor] instance ${entry.def.id} (${entry.def.name}) ` +
            `wants --aa but root has no AA (ZAI_AA_ENABLED!=1); ` +
            `child will start WITHOUT --aa. Enable --aa on the root, then restart.`,
          );
        }
        const aaParentUrl = useAa && rootHasAa && rootPort
          ? `http://127.0.0.1:${rootPort}`
          : undefined;
        if (aaParentUrl) args.push('--aa');
        // 进程标题:让 ps / top / macOS Activity Monitor 在 spawn 后立即
        // 显示 `zai[name]:port` 而不是 `node .../bin/zai.js`。`argv0` 改
        // `argv[0]`(Linux ps/macOS ps 列都从 argv[0] 起始读);`ZAI_PROCESS_TITLE`
        // 让 child 启动早期(`start.ts:runStart` 顶部)把内部 `process.title`
        // 也设上,补 macOS Activity Monitor / Linux `top` 取 `comm` 字段
        // 的路径。entry.def.name 由 createInstance 校验非空,这里直接拼。
        const title = `zai[${entry.def.name}]:${port}`
        const childEnv: NodeJS.ProcessEnv = {
          ...process.env,
          ZAI_INSTANCE_ID: id,
          ZAI_SUPERVISOR_PID: String(process.pid),
          ZAI_INSTANCE_HEARTBEAT_MS: '5000',
          ZAI_PROCESS_TITLE: title,
          ...(aaParentUrl
            ? { ZAI_AA_PARENT_URL: aaParentUrl, ZAI_AA_PARENT_PORT: rootPort ?? undefined }
            : {}),
        }
        // `isAaEnabled()` 只读 env、不读 argv,而上面是 `...process.env` 全量
        // 继承 —— root 带 `--aa` 时 `ZAI_AA_ENABLED=1` 会原样传给每个子实例。
        // 于是 def.aa=false 的实例(没拿到 `--aa`、也没拿到 ZAI_AA_PARENT_URL)
        // 仍然 isAaEnabled()=true,在 init.ts 的 isChild 判定里落进 ROOT 分支,
        // 拿同一个 connectorId 去连 AA 云 → 403 + 每 5s 无限重连。
        // 不变式:子进程 env 说开 AA ⟺ argv 里有 `--aa`,即 aaParentUrl 有值。
        if (!aaParentUrl) {
          delete childEnv.ZAI_AA_ENABLED
          delete childEnv.ZAI_AA_PARENT_URL
          delete childEnv.ZAI_AA_PARENT_PORT
        }
        const child = deps.spawn(
          process.execPath,
          args,
          {
            cwd: entry.def.cwd,
            stdio: ['ipc', 'inherit', 'inherit'],
            detached: false,
            argv0: title,
            env: childEnv,
          },
        )
        attachChild(entry, child)
        return snapshotOf(entry)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setStatus(entry, {
          state: 'down',
          port: null,
          pid: null,
          lastError: { at: new Date(deps.now()).toISOString(), message },
        })
        emit(id, entry.status)
        persistSafe()
        throw err
      }
    }

    const doStop = async (id: string) => {
      const entry = getEntry(id); const child = entry.child; const childState = entry.childState
      if (!child || !childState) {
        // `starting` 期间 entry.child 仍是 null(还在端口探测 / spawn 之前),
        // 此时无条件翻成 stopped 会**撤销 in-flight start 设的 starting 态**;
        // 那个 doStart 随后会穿过 doStart 顶部的 state 守卫直接 spawn,
        // 叠加上另一个已排队的 start → 双 child(见 fix-plan-10-05 H3)。
        // 正确做法:不碰状态,让 in-flight start 自己跑完(或失败后落 down)。
        if (entry.status.state === 'starting') return snapshotOf(entry)
        setStatus(entry, { state: 'stopped', port: null, pid: null }); emit(id, entry.status); persistSafe(); return snapshotOf(entry)
      }
      setStatus(entry, { state: 'stopping' }); emit(id, entry.status); persistSafe()
      childState.userStopping = true
      // Resolve only from the actual `exit` event (or already-exited state).
      // `child.killed === true` only means kill() was called — it is not
      // evidence of termination, so we no longer short-circuit on it.
      const exitPromise = new Promise<void>((resolve) => { let done = false; const finish = () => { if (!done) { done = true; resolve() } }; child.once('exit', finish); if (child.exitCode != null || child.signalCode != null) finish() })
      try { child.kill('SIGINT') } catch { /* ignore */ }
      const timeout = deps.sleep(STOP_TIMEOUT_MS).then(() => 'timeout' as const)
      if (await Promise.race([exitPromise.then(() => 'exit' as const), timeout]) === 'timeout') {
        // Child ignored SIGINT. Escalate to SIGKILL and keep awaiting exit
        // up to a bounded post-SIGKILL window. If exit still doesn't fire
        // we settle the state to `stopped` so callers don't see a hung
        // `stopping` snapshot.
        try { child.kill('SIGKILL') } catch { /* ignore */ }
        const settled = await Promise.race([exitPromise, deps.sleep(POST_SIGKILL_EXIT_GRACE_MS).then(() => 'grace' as const)])
        if (settled === 'grace' && entry.child === child) {
          setStatus(entry, { state: 'stopped', port: null, pid: null, lastError: null }); emit(id, entry.status); persistSafe()
        }
      }
      return snapshotOf(entry)
    }

    const doRemove = async (id: string) => {
      ensureNotCurrent(id)
      const entry = getEntry(id)
      if (entry.child) await doStop(id)
      entries.delete(id)
      // Serialise the delete write through writeChain: a queued persistSafe
      // (e.g. the exit handler's `stopped`/`down` write, which still contains
      // the instance) must not land AFTER this removal and resurrect the
      // deleted definition on disk. `persistSafe` chains + we drain the chain.
      persistSafe()
      await writeChain
    }
    const tickHeartbeat = () => {
      const nowMs = deps.now()
      for (const entry of entries.values()) {
        // Fallback for child-less entries stuck in an active state (e.g.
        // hydrated as `running` from a previous supervisor lifetime). They
        // can never reach the SIGKILL path below, so force-reset once the
        // stale window elapses. Entries WITH a live child are untouched here
        // and keep the 20s → down behaviour.
        if (resetStaleActive(entry, nowMs)) { emit(entry.def.id, entry.status); persistSafe(); continue }
        if (entry.status.state !== 'running') continue
        const last = entry.status.lastHeartbeatAt ? new Date(entry.status.lastHeartbeatAt).getTime() : 0
        if (nowMs - last <= HEARTBEAT_TIMEOUT_MS) continue
        const child = entry.child
        const childState = entry.childState
        if (!child || !childState) continue
        // Mark BEFORE sending SIGKILL so the exit handler recognises the kill
        // as a heartbeat timeout and skips overwriting the state we set below.
        childState.timeoutKilled = true
        try { child.kill('SIGKILL') } catch { /* ignore */ }
        setStatus(entry, { state: 'down', port: null, pid: null, lastError: { at: new Date(nowMs).toISOString(), message: `heartbeat timeout (>${HEARTBEAT_TIMEOUT_MS}ms)` } }); emit(entry.def.id, entry.status); persistSafe()
      }
    }

    const supervisor = {
      getSnapshots: () => [currentSnapshot(), ...[...entries.values()].map(snapshotOf)],
      // Test-only escape hatch: await all queued best-effort writes so
      // assertions can observe the latest persisted snapshot deterministically.
      // Production callers should never invoke this.
      __flushPendingWrites: async () => { await writeChain },
      async createInstance({ name, cwd, lan, port, app, aa }: { name: string; cwd: string; lan?: boolean; port?: number | null; app?: InstanceDefinition['app']; aa?: boolean }) {
        const trimmed = name.trim(); for (const entry of entries.values()) if (entry.def.name === trimmed) throw new InstanceSupervisorError('DUPLICATE_NAME', `duplicate name: ${trimmed}`)
        const def: InstanceDefinition = {
          id: `inst_${randomUUID().slice(0, 8)}`,
          name: trimmed,
          cwd,
          createdAt: new Date(deps.now()).toISOString(),
          lan: lan === true,
          // Persist a user-pinned port on creation. `null` / `undefined`
          // round-trip to `undefined` on disk so older readers continue
          // to treat it as "no pin set" — same shape as `lan`.
          startPort: typeof port === 'number' && Number.isInteger(port) ? port : undefined,
          // 应用 profile；同样 undefined → "无 profile"，旧 reader 无感。
          // 路由层已经收窄到 `undefined | 'task-factory'`，此处不再校验。
          app,
          // AA per-instance 覆盖:路由层已用 `parseBoolField` 收窄到 boolean;
          // 落盘保留 `true | false | undefined` 三态 —— `undefined` 表示"跟随
          // root"(默认),旧 JSON 文件无此字段时 hydrate 出来也是 undefined。
          aa: typeof aa === 'boolean' ? (aa === true) : undefined,
        }
        const entry: Entry = { def, status: { ...EMPTY_INSTANCE_STATUS }, child: null, childState: null }
        entries.set(def.id, entry)
        await persist()
        emit(def.id, entry.status)
        return doStart(def.id)
      },
      startInstance: async (id: string, opts?: { lan?: boolean; port?: number | null; aa?: boolean }) => { ensureNotCurrent(id); return doStart(id, opts) },
      stopInstance: async (id: string) => { ensureNotCurrent(id); return doStop(id) },
      restartInstance: async (id: string, opts?: { lan?: boolean; port?: number | null; aa?: boolean }) => { ensureNotCurrent(id); await doStop(id); return doStart(id, opts) },
      removeInstance: async (id: string) => doRemove(id),
      async updateInstance(id: string, patch: { lan?: boolean; port?: number | null; cwd?: string; aa?: boolean | null }) {
        ensureNotCurrent(id)
        const entry = getEntry(id)
        // Refuse unknown / no-op patches explicitly so a typo in the
        // API caller doesn't silently no-op. Allowed fields here must
        // stay in sync with the `InstanceSupervisor['updateInstance']`
        // signature; adding one forces the same narrowing in the route.
        const next: Partial<InstanceDefinition> = {}
        // Tracked separately from `next`: clearing must REMOVE the key from
        // the merged definition, and a spread-merge can't express "delete".
        // Keeping it as a flag is also what makes `{ aa: null }` count as a
        // non-empty patch below — otherwise the "clear" request would be
        // rejected as an empty patch and the toggle could never be turned off.
        let clearAa = false
        if (patch.lan !== undefined) next.lan = patch.lan === true
        if (patch.port !== undefined) {
          // `null` clears the pin back to auto (so the next start scans);
          // `number` sets a new pin (route already validated 1..65535).
          next.startPort = patch.port === null ? null : patch.port
        }
        // Takes effect on the next `doStart` (it reads `entry.def.cwd` at
        // spawn time). A running child keeps its old cwd until restarted —
        // callers that need it live must stop/restart explicitly.
        if (patch.cwd !== undefined) next.cwd = patch.cwd
        // AA per-instance 覆盖(`undefined` 透传保持「跟随 root」;`true` / `false`
        // 显式落地)。下一次 start/restart 立即生效 —— 与 `lan` 行为对齐。
        // `null` = 删除 def.aa,回到 auto —— 与 `false`(force-off)是两件事。
        if (patch.aa !== undefined) {
          if (patch.aa === null) clearAa = true
          else next.aa = patch.aa === true
        }
        if (Object.keys(next).length === 0 && !clearAa) throw new InstanceSupervisorError('INVALID_STATE', 'no patchable fields supplied')
        const merged: InstanceDefinition = { ...entry.def, ...next }
        if (clearAa) delete merged.aa
        entry.def = merged
        await persist()
        emit(id, entry.status)
        return snapshotOf(entry)
      },
      async shutdown() {
        // Snapshot the child references first. The supervisor may receive
        // exit events mid-shutdown; we must continue to wait for each
        // snapshot child even if its entry has been replaced.
        const tracked: Array<{ child: ChildProcess; childState: ChildState }> = []
        for (const entry of entries.values()) {
          if (!entry.child || !entry.childState) continue
          entry.childState.userStopping = true
          try { entry.child.kill('SIGINT') } catch { /* ignore */ }
          tracked.push({ child: entry.child, childState: entry.childState })
        }
        const killPromises: Array<Promise<void>> = tracked.map(({ child, childState }) => new Promise<void>((resolve) => {
          let done = false
          const finish = () => { if (done) return; done = true; resolve() }
          const onExit = () => { if (childState.scheduledKill) { clearTimeout(childState.scheduledKill); childState.scheduledKill = null }; finish() }
          child.once('exit', onExit)
          if (child.exitCode != null || child.signalCode != null) { onExit(); return }
          scheduleKill(child, 'SIGKILL', SHUTDOWN_TIMEOUT_MS, childState, finish)
        }))
        await Promise.all(killPromises)
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
      },
    } as InstanceSupervisor

    heartbeatTimer = setInterval(tickHeartbeat, HEARTBEAT_POLL_MS); heartbeatTimer.unref()
    ;(supervisor as unknown as { __tickHeartbeat: () => void }).__tickHeartbeat = tickHeartbeat
    // Hydrate before exposing mutating operations. `initInstanceSupervisor`
    // is now `async` so callers must `await` it; `getInstanceSupervisor()`
    // then guarantees entries are loaded (or load failed and we logged it).
    try {
      const file = await deps.readFile()
      for (const def of file.definitions) {
        // Pull the persisted status if present; fall back to EMPTY so a
        // definitions-only file still loads cleanly. Without this fallback
        // every restart would silently rewind a `running` instance to
        // `stopped`.
        const persisted = file.statuses[def.id] as InstanceStatus | undefined
        const status: InstanceStatus = persisted ? { ...persisted } : { ...EMPTY_INSTANCE_STATUS }
        entries.set(def.id, { def, status, child: null, childState: null })
      }
      // Server-authoritative stale reset: hydrated entries have no child, so
      // a persisted active state is only trustworthy while its last activity
      // is recent. Anything older than STALE_RUNNING_RESET_MS is normalised
      // to `stopped` before the supervisor is exposed to callers.
      const hydrateNow = deps.now()
      let anyStaleReset = false
      for (const entry of entries.values()) {
        if (resetStaleActive(entry, hydrateNow)) anyStaleReset = true
      }
      if (anyStaleReset) persistSafe()
    } catch (err) {
      const msg = err instanceof Error ? err.stack ?? err.message : String(err)
      console.warn(`[instanceSupervisor] failed to hydrate from disk: ${msg}`)
    }
    singleton = supervisor
    return supervisor
  })()
  try { return await initPromise } finally { initPromise = null }
}

export async function shutdownInstanceSupervisor(): Promise<void> { if (!singleton) return; await singleton.shutdown(); singleton = null }
