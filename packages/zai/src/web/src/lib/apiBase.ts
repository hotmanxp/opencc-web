// 抽出来的 fetch 内核 — 包装 Content-Type / 错误处理, 供 type-safe
// generated stub 与遗留 `api.get/post/put` 共用. SPEC:
//   docs/superpowers/specs/2026-08-16-rpc-type-safe-client-stubs.md
//
// 改动前, 这些逻辑写在 `lib/api.ts` 内部, 迁调用方时需要复制粘贴。抽到
// 这里后, generated stub (`api.generated.ts`) 与遗留 `api.get/post/put`
// 共享同一段 fetch 实现, 行为一致。
//
// 路径处理:path 已有 `/api` 前缀 (generated stub 用 RpcMethodMap 完整
// 路径) 时不再加; 没有前缀 (老 `api.post('/agent/command', ...)`) 时
// 自动加。这样两套调用方共用同一段实现, 不重复。

import { ApiError, notifyApiError } from './apiError.js'

const API_BASE = '/api'

export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  init?: RequestInit,
): Promise<T> {
  const m = method.toUpperCase()
  const fullPath = path.startsWith('/api') ? path : `${API_BASE}${path}`
  const res = await fetch(fullPath, {
    ...init,
    method: m,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => res.statusText)
    const err = new ApiError(res.status, m, path, errBody)
    notifyApiError(err)
    throw err
  }
  return res.json() as Promise<T>
}
