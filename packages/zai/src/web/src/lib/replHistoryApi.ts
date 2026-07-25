import type { TopCommandsResponse } from '../../../shared/repl.js'

/**
 * 拉全局命令历史 topN。
 * 默认 10 条;limit 超过 server MAX_LIMIT 时 server 端静默 clamp,前端不报错。
 * Spec/Plan: docs/superpowers/plans/2026-07-25-zai-bash-repl-top10.md
 */
export async function fetchTopCommands(limit = 10): Promise<TopCommandsResponse> {
  const url = `/api/bash/history/top10${limit !== 10 ? `?n=${limit}` : ''}`
  const res = await fetch(url)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`fetchTopCommands failed: ${res.status} ${text}`)
  }
  return (await res.json()) as TopCommandsResponse
}

/**
 * 拉前缀过滤后的 topN(prefix 由 server 侧做 startsWith 过滤)。
 * 前端拿到结果后可继续做本地过滤,但 server 已经返回了 prefix 后的全集,
 * 没必要再客户端二次过滤 —— UI 上直接用 entries 即可。
 */
export async function fetchTopCommandsWithPrefix(
  prefix: string,
  limit = 10,
): Promise<TopCommandsResponse> {
  const params = new URLSearchParams()
  if (prefix) params.set('q', prefix)
  if (limit !== 10) params.set('n', String(limit))
  const qs = params.toString()
  const url = `/api/bash/history/top10${qs ? `?${qs}` : ''}`
  const res = await fetch(url)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`fetchTopCommandsWithPrefix failed: ${res.status} ${text}`)
  }
  return (await res.json()) as TopCommandsResponse
}