import type { ExecRequest, ExecResult } from '../../../shared/repl.js'

/**
 * ExecResponse 200 / 409 解码为 hook 友好的 ExecResult。
 * 500 抛 Error（abort / fetch 失败亦然）。
 *
 * opts.wait: true 时路由 await child 完成后返回 code/signal/durationMs,
 * 调用方同步拿到真实终态(MobileQuickDrawer 决定 success/error toast 用)。
 * 默认 false (fire-and-forget):只返回 execId,SSE 'exit' event 推送终态。
 */
export async function execRepl(
  sessionId: string,
  body: ExecRequest,
  opts: { wait?: boolean } = {},
): Promise<ExecResult> {
  // 只在 wait=true 时把 wait 字段塞进 body,保持 fire-and-forget 默认模式下
  // request body 与旧版一致(向后兼容,BashTab 测试期望不带 wait 字段)。
  const requestBody = opts.wait === true ? { ...body, wait: true } : body
  const res = await fetch(`/api/bash/repl/${encodeURIComponent(sessionId)}/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  })
  if (res.status === 200) {
    const json = await res.json()
    if (json.ok) {
      // wait=true 时 server 会补充 code/signal/durationMs 字段;
      // wait=false 时这些字段不存在,保持 undefined(调用方判 !ok.busy 即可)。
      return {
        ok: true,
        execId: json.execId,
        code: json.code,
        signal: json.signal,
        durationMs: json.durationMs,
      }
    }
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