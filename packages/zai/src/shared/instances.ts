// Shared instance-manager types — single source of truth for backend + frontend.
// See docs/superpowers/specs/2026-08-03-zai-agent-instance-manager-design.md.

export type InstanceState = 'stopped' | 'starting' | 'running' | 'stopping' | 'down'

export const INSTANCE_STATES: readonly InstanceState[] = [
  'stopped',
  'starting',
  'running',
  'stopping',
  'down',
]

export interface InstanceDefinition {
  id: string
  name: string
  cwd: string
  createdAt: string
  /**
   * When `true`, the supervisor spawns the child with `--lan` so the
   * instance binds `0.0.0.0` and is reachable from other devices on the
   * LAN. Defaults to `false` (loopback only) — opt-in per-instance so a
   * dev's notebook doesn't accidentally expose unrelated workspaces.
   */
  lan?: boolean
  /**
   * Optional fixed port for `start`/`restart`. When a positive integer is
   * set the supervisor MUST start the child on that exact port and fails
   * the start (instance → `down`) if the port is already bound. `null` or
   * omitted preserves the legacy behaviour: the supervisor scans from
   * `INSTANCE_BASE_PORT` (9201) upward via `probePort`. Kept on the
   * definition so a user-set port persists across restarts and is
   * overridable per-start (see `startInstance({ port })`).
   *
   * Named `startPort` (not `port`) to disambiguate from
   * `InstanceStatus.port`, which carries the *runtime* port the child
   * bound to — `InstanceSnapshot` extends both interfaces so the two
   * fields cannot share a name without one of them losing precision.
   */
  startPort?: number | null
  /**
   * 启动 profile。
   *   - `'task-factory'` = 任务工厂实例(打开 /super-tasks、锁定调度器 Agent)。
   *   - `'weixin'` = 微信专用实例 —— 机器上唯一持有微信通道 owner 锁、
   *     收发微信消息的进程。由主实例按 `settings.weixinBot` 自动拉起
   *     (见 services/weixinBot/weixinDedicatedInstance.ts),也可以由用户在
   *     实例管理页手动创建。
   *
   * 该值经 supervisor spawn `--app` 传给子进程,并在 `/api/system` 回显。
   * 子进程 `cli/index.ts` 把它落到 `process.env.ZAI_APP`;`routes/agent.ts`
   * 看到 `task-factory` 后强制把所有新建会话的 `mainAgent` 锁定,
   * `maybeAutoStartWeixinBot()` 则只认 `weixin`(其余进程不碰通道)。
   * `undefined` 是默认(无 profile),行为与既有实例一致。
   */
  app?: 'task-factory' | 'weixin'
}

export interface InstanceStatus {
  state: InstanceState
  port: number | null
  pid: number | null
  startedAt: string | null
  lastHeartbeatAt: string | null
  lastError: { at: string; message: string } | null
}

export interface InstanceSnapshot extends InstanceDefinition, InstanceStatus {
  isCurrent: boolean
}
