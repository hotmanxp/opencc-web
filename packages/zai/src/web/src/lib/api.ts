// 浏览器端 fetch 客户端 — 两种调用方式并存:
//
// 1. 推荐: 类型化 RPC stub — `apiRpc.agent.command.post({...})` 风格
//    单一真相源在 `packages/zai/src/shared/rpc.ts` 的 `RpcMethodMap`。
//    新增 route 时改 RpcMethodMap + 跑 codegen, 调用方立刻有完整类型。
//    SPEC: docs/superpowers/specs/2026-08-16-rpc-type-safe-client-stubs.md
//
// 2. 兼容: 通用 `api.get/post/put(path, body)` — 老调用方继续工作,
//    走 apiBase.request 同样的实现。命名空间为 `api` 而非 `apiRpc`
//    以最小化改动; 新代码优先用 `apiRpc`。
//
// 内部 fetch 逻辑 (Content-Type / 错误处理 / notifyApiError) 全部在
// `apiBase.ts` 里, 两套出口共享同一段实现, 行为一致。

export { api as apiRpc } from './api.generated.js'
export { request } from './apiBase.js'

import { request } from './apiBase.js'

// 兼容老 api.get/post/put 调用 — 迁移期间保留, 后续渐进迁移到 apiRpc。
export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  // 加 init 参数让调用方能传 headers (e.g. X-Session-Id). 兼容老调用
  // (init 可选). body 优先用 body, headers 走 init.headers, Content-Type
  // 由 request() 内部合并 — 调用方传进来的 headers 不会覆盖 Content-Type.
  post: <T>(path: string, body?: unknown, init?: RequestInit) =>
    request<T>('POST', path, body, init),
  put: <T>(path: string, body: unknown) =>
    request<T>('PUT', path, body),
}
