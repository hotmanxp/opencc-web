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
