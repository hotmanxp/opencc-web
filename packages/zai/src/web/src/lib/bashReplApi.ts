import type { ExecRequest, ExecResult } from '../../../shared/repl.js'

/**
 * ExecResponse 200 / 409 解码为 hook 友好的 ExecResult。
 * 500 抛 Error（abort / fetch 失败亦然）。
 */
export async function execRepl(sessionId: string, body: ExecRequest): Promise<ExecResult> {
  const res = await fetch(`/api/bash/repl/${encodeURIComponent(sessionId)}/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status === 200) {
    const json = await res.json()
    if (json.ok) return { ok: true, execId: json.execId }
    return json
  }
  if (res.status === 409) {
    const json = await res.json()
    return { ok: false, busy: true, currentExecId: json.currentExecId }
  }
  const text = await res.text().catch(() => '')
  throw new Error(`exec failed: ${res.status} ${text}`)
}

export async function abortRepl(sessionId: string): Promise<void> {
  const res = await fetch(`/api/bash/repl/${encodeURIComponent(sessionId)}/abort`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  if (!res.ok && res.status !== 409) {
    const text = await res.text().catch(() => '')
    throw new Error(`abort failed: ${res.status} ${text}`)
  }
}

/** SSE URL — 浏览器 EventSource 用 */
export function replEventsUrl(sessionId: string): string {
  return `/api/bash/repl/${encodeURIComponent(sessionId)}/events`
}