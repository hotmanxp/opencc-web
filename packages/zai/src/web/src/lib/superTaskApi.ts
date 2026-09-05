import type { IntakeDocCheck, TaskBucket, TaskDetails, TaskSummary } from '@zn-ai/zn-agent-core'

/**
 * GET /api/super-tasks 响应(2026-09-03 起支持 since-hash 短路)。
 * 全量响应(modified 缺省或 true)带 buckets/managed/supervisorSessionId + hash;
 * 短路响应(modified:false)只有 hash,旧字段全部缺席。
 * 旧调用方不传 since 时永远拿到全量分支,向后兼容。
 */
export interface SuperTaskFullDto {
  modified?: true
  /** 服务端内容指纹(fingerprint|managed|sid),下轮 load 作 `?since=` 回传。 */
  hash?: string
  buckets: TaskBucket
  managed: boolean
  /**
   * 后端 state.json 的任务调度官会话 id(2026-09-02 起允许 null:
   * reset 路由清空后到 mount 引导完成前的窗口期为 null)。
   * 前端 SuperTasks.tsx 引导逻辑看到 null 视为"未绑定",
   * 走新建分支(createAgentSession + setSupervisorSession)。
   */
  supervisorSessionId: string | null
}
export interface SuperTaskUnchangedDto {
  modified: false
  hash: string
}
export type SuperTaskListDto = SuperTaskFullDto | SuperTaskUnchangedDto

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

/**
 * 拉取任务列表。`since` 传上一轮返回的 hash,服务端内容未变时短路为
 * `{ modified:false }` 极小响应;首轮/失效后传 null/undefined 走全量。
 */
export function fetchSuperTasks(since?: string | null): Promise<SuperTaskListDto> {
  const url = since ? `/api/super-tasks?since=${encodeURIComponent(since)}` : '/api/super-tasks'
  return fetch(url).then((r) => json<SuperTaskListDto>(r))
}
export function fetchSuperTaskDetail(id: string): Promise<TaskDetails> {
  return fetch(`/api/super-tasks/${encodeURIComponent(id)}`).then((r) => json<{ task: TaskDetails }>(r)).then((d) => d.task)
}
/**
 * intake 文档强校验(2026-09-03):新建任务弹窗关闭前检查
 * docs/spec.md / docs/plan.md / docs/brainstorm.md 是否已填实质内容。
 * 缺失时弹窗拦截关闭,并把 missing 清单回流给 task-intake 会话。
 */
export function checkSuperTaskIntakeDocs(id: string): Promise<IntakeDocCheck> {
  return fetch(`/api/super-tasks/${encodeURIComponent(id)}/intake-check`).then((r) => json<IntakeDocCheck>(r))
}
export async function deleteSuperTasks(ids: string[]): Promise<void> {
  await fetch('/api/super-tasks', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  }).then((r) => json<{ ok: true }>(r))
}
export async function setSuperTasksManaged(enabled: boolean): Promise<void> {
  await fetch('/api/super-tasks/managed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  }).then((r) => json<{ ok: true }>(r))
}
/**
 * 上报任务调度官会话 id(2026-09-02)。/super-tasks 引导(沿用/新建调度官会话)后调用,
 * 让后端托管循环与注入端点始终打在用户可见的调度官会话上。
 */
export async function setSupervisorSession(sessionId: string): Promise<void> {
  await fetch('/api/super-tasks/supervisor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  }).then((r) => json<{ ok: true }>(r))
}
/**
 * 重置任务调度官会话(2026-09-02)。后端清 state.json.supervisorSessionId
 * 并同步关托管;前端需在调用成功后 reload 触发 mount 引导。
 *
 * 旧 session transcript 保留在 ~/.zai/tasks/,与新调度官不再关联;
 * 用户的"重置"心智 = 「换一个干净的调度官对话」,不是「删除历史」。
 */
export async function resetSupervisorSession(): Promise<void> {
  await fetch('/api/super-tasks/supervisor/reset', { method: 'POST' })
    .then((r) => json<{ ok: true }>(r))
}
export async function injectSuperTaskCommand(
  action: 'dispatch' | 'resume' | 'accept' | 'pause',
  id?: string,
): Promise<void> {
  await fetch('/api/super-tasks/inject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, id }),
  }).then((r) => json<{ ok: true }>(r))
}

export function startSuperTask(id: string): Promise<void> {
  return fetch(`/api/super-tasks/${encodeURIComponent(id)}/start`, { method: 'POST' })
    .then((r) => json<{ ok: true }>(r)).then(() => undefined)
}
export function pauseSuperTask(id: string): Promise<void> {
  return fetch(`/api/super-tasks/${encodeURIComponent(id)}/pause`, { method: 'POST' })
    .then((r) => json<{ ok: true }>(r)).then(() => undefined)
}
export function resumeSuperTask(id: string): Promise<void> {
  return fetch(`/api/super-tasks/${encodeURIComponent(id)}/resume`, { method: 'POST' })
    .then((r) => json<{ ok: true }>(r)).then(() => undefined)
}
export function acceptSuperTask(id: string): Promise<void> {
  return fetch(`/api/super-tasks/${encodeURIComponent(id)}/accept`, { method: 'POST' })
    .then((r) => json<{ ok: true }>(r)).then(() => undefined)
}

// ─── 工厂设置(~/.zai/factory-settings.json,tf-pnsl5m5e)──────────────

export interface FactorySettingsDto {
  docsDir: string
  repoRoot: string
  maxParallelTasks: number
  preferSpawnAgent: 'opencc' | 'dsh' | 'opencode' | null
  /** finished-tasks 终态任务过期自动归档阈值(小时,1–8760)。 */
  historyArchiveHours: number
  /** 派生字段(服务端 stat):目录存在性徽标,不进 PUT schema。 */
  docsDirExists: boolean
  repoRootExists: boolean
}

export type FactorySettingsPatch = Partial<
  Pick<FactorySettingsDto, 'docsDir' | 'repoRoot' | 'maxParallelTasks' | 'preferSpawnAgent' | 'historyArchiveHours'>
>

export interface SpawnAgentStatus {
  name: string
  commandFound: boolean
  commandPath: string | null
  registered: boolean
  active: boolean
}

/** 设置端点专用错误解析:把 zod 400 的 detail/issues 拼进 message 供 UI 展示。 */
async function factorySettingsJson(res: Response): Promise<FactorySettingsDto> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string
      detail?: string[]
      issues?: string[]
    }
    const parts = [...(body.detail ?? []), ...(body.issues ?? [])]
    throw new Error([body.error, ...parts].filter(Boolean).join(': ') || `HTTP ${res.status}`)
  }
  return res.json() as Promise<FactorySettingsDto>
}

export function fetchFactorySettings(): Promise<FactorySettingsDto> {
  return fetch('/api/super-tasks/settings').then((r) => factorySettingsJson(r))
}

export function putFactorySettings(patch: FactorySettingsPatch): Promise<FactorySettingsDto> {
  return fetch('/api/super-tasks/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).then((r) => factorySettingsJson(r))
}

export function fetchSpawnAgents(): Promise<SpawnAgentStatus[]> {
  return fetch('/api/super-tasks/spawn-agents')
    .then((r) => json<{ agents: SpawnAgentStatus[] }>(r))
    .then((d) => d.agents)
}

export function registerSpawnAgent(
  name: string,
): Promise<{ ok: true; restartRequired: boolean }> {
  return fetch(`/api/super-tasks/spawn-agents/${encodeURIComponent(name)}/register`, {
    method: 'POST',
  }).then((r) => json<{ ok: true; restartRequired: boolean }>(r))
}

export type { TaskBucket, TaskSummary, TaskDetails, IntakeDocCheck }
