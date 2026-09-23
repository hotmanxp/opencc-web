/**
 * agentSessionApi — 任务工厂前端建/删 agent 会话的公共 helper(2026-09-02)。
 *
 * 任务调度器引导(SuperTasks.tsx)与新建任务弹窗(NewSuperTaskModal)都需要
 * 「带 mainAgent 冻结的建会话」:POST /api/agent/sessions 的 mainAgent 参数
 * 让 transcript.meta.mainAgent 建会话即锁定(task-factory / task-intake),
 * 首条 prompt 不再回落到全局 settings.mainAgent。
 *
 * model/providerId 继承逻辑与 useAgentStore.createNewSession 同语义:
 * 按 updatedAt 倒序找用户最近手动选过模型的会话。
 */

export type SessionMeta = {
  sessionId: string
  model?: string
  providerId?: string
  updatedAt: number
}

export function pickLastSelectedModel(
  sessions: SessionMeta[],
): { model?: string; providerId?: string } {
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  for (const s of sorted) {
    if (s.model && s.model !== 'unknown') {
      return { model: s.model, ...(s.providerId ? { providerId: s.providerId } : {}) }
    }
  }
  return {}
}

/**
 * 建一条会话并冻结 mainAgent,返回 sessionId。失败抛错。
 *
 * 可选 `cwd`(2026-09-03, tf-pnsl5m5e):会话的逻辑工作目录 —— 任务工厂
 * 需求讨论(task-intake)会话传 factory-settings.docsDir,后端写入 CwdStore
 * (inbox 指令 / pwd 查询以它为基准)。缺省 = 维持现状(实例 cwd)。
 */
export async function createAgentSession(opts: {
  mainAgent: string
  model?: string
  providerId?: string
  cwd?: string
}): Promise<string> {
  const token = localStorage.getItem('zai-token') || ''
  const res = await fetch('/api/agent/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Zai-Token': token },
    body: JSON.stringify(opts),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `create session HTTP ${res.status}`)
  }
  const data = (await res.json()) as { sessionId: string }
  return data.sessionId
}

/** 直接删 transcript(绕开 useAgentStore.deleteSession 的自动切会话副作用)。 */
export async function deleteAgentSession(sessionId: string): Promise<void> {
  const token = localStorage.getItem('zai-token') || ''
  await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    headers: { 'X-Zai-Token': token },
  })
}

/**
 * 手动触发一次会话归档（本实例 cwd）。设置页「立即归档」按钮调它。
 *
 * 永不抛：后端该端点也不返 5xx，任何异常都归一成"零归档"，UI 只需提示用户
 * 「没有需要归档的会话」，不必区分"失败"与"没什么可归档"。
 */
export async function archiveSessions(): Promise<{
  archived: string[]
  kept: number
  skipped: number
}> {
  const token = localStorage.getItem('zai-token') || ''
  try {
    const res = await fetch('/api/agent/sessions/archive', {
      method: 'POST',
      headers: { 'X-Zai-Token': token },
    })
    if (!res.ok) return { archived: [], kept: 0, skipped: 0 }
    const data = (await res.json()) as {
      archived?: string[]
      kept?: number
      skipped?: number
    }
    return {
      archived: Array.isArray(data.archived) ? data.archived : [],
      kept: typeof data.kept === 'number' ? data.kept : 0,
      skipped: typeof data.skipped === 'number' ? data.skipped : 0,
    }
  } catch {
    return { archived: [], kept: 0, skipped: 0 }
  }
}
