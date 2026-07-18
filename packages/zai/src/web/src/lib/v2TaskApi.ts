// V2 TaskList 客户端. 写操作(zai-agent-core 内部 tool call)不在这里,
// 这里只暴露只读: 因为 store 已经通过 SSE 增量更新, 但首次进入会话时
// 需要 GET 一次把磁盘上 ~/.zai/tasks.json 现有内容拉过来覆盖本地缓存.

import type { V2TaskItem } from '../store/useAgentStore.js'

const API = '/api/agent/sessions'

function getHeaders(): HeadersInit {
  const token = (typeof localStorage !== 'undefined' && localStorage.getItem('zai-token')) || ''
  return token ? { 'X-Zai-Token': token } : {}
}

export async function fetchV2Tasks(sessionId: string): Promise<V2TaskItem[]> {
  const res = await fetch(`${API}/${encodeURIComponent(sessionId)}/v2-tasks`, {
    headers: getHeaders(),
  })
  if (!res.ok) throw new Error(`v2-tasks fetch failed: ${res.status}`)
  const data = (await res.json()) as { tasks: V2TaskItem[] }
  return data.tasks
}