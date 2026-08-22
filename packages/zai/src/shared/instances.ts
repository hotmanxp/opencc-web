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

export type InstanceKernel = 'opencc' | 'dsh'

export const INSTANCE_KERNELS: readonly InstanceKernel[] = ['opencc', 'dsh']

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
   * 启动期覆盖 agent.kernel — 实例级别独立配置,与全局 settings.agent.kernel
   * 解耦:
   *
   *   - 缺省 / `undefined`:不写 `--kernel`,子进程走 resolveAgentKernel
   *     自身优先级(子进程项目级 → 用户级 → 'opencc')。**这是 "继承全局" 语义**。
   *   - `'opencc' | 'dsh'`:子进程 spawn args 加 `--kernel <id>`,启动时
   *     走 CLI 覆盖路径(优先级最高),与 `~/.zai/settings.json` 解耦。
   *   - `null`(仅 PATCH):清回 "继承全局",等价于缺省。POST 不接受 `null`,
   *     镜像 `startPort: null` 的现有约束。
   *
   * 运行期不允许切换 — 重启 instance 后生效(主计划 §4.1 红线)。
   */
  kernel?: InstanceKernel | null
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
