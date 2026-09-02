/**
 * agentSessionApi — 任务工厂前端建/删 agent 会话的公共 helper(2026-09-02)。
 *
 * 主管引导(SuperTasks.tsx)与新建任务弹窗(NewSuperTaskModal)都需要
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

/** 建一条会话并冻结 mainAgent,返回 sessionId。失败抛错。 */
export async function createAgentSession(opts: {
  mainAgent: string
  model?: string
  providerId?: string
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
