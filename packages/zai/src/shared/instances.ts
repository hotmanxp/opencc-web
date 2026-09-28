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
  /**
   * Per-instance override of the AA bridge flag.
   *   - `undefined` (默认) = auto:跟随 root 的 `--aa` 决策(行为与既有实例一致)。
   *   - `true` = 请求启用:在 root 已启 AA 的前提下给该子进程 spawn 加 `--aa`。
   *   - `false` = 强制禁用:即便 root 启了 AA,该子进程 spawn 也不带 `--aa`,
   *     适合"同一台机器上某项目不该被 AA Cloud 看到"的场景。
   *
   * **root 是硬门禁**:root 没启 AA(`ZAI_AA_ENABLED!=1`)时,子实例一定不带
   * `--aa` —— 即便 `aa === true`。child 端的 AA 桥必须靠 supervisor 注入的
   * `ZAI_AA_PARENT_URL` 才能把事件转发给 AA Cloud;没有 parent URL 时
   * `childEventReporter.start()` early return,child 会白挂一个 WS 客户端
   * 却不产出任何转发。因此 `aa=true` + root 没开 = 静默降级为关 + 一条 warn,
   * root 启 AA 后下次 start/restart 自动生效。
   *
   * UI 表面目前只暴露 2 态开关(关=auto、开=请求启用);`false` 仅 API 层
   * 可设置,保留给"per-instance 关掉"的用例。
   */
  aa?: boolean
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
