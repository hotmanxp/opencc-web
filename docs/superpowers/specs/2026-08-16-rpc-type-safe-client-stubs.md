# 类型化 RPC Client Stub — Design

**Date:** 2026-08-16
**Status:** Implemented (2026-08-16)
**Author:** 借鉴 deepseek-harness `RpcMethodMap` + Typert 远程服务的调研

## Goal

消除 `packages/zai/src/web/src/lib/api.ts` 的手写客户端,改为从服务端 routes 自动生成类型化 stub。新增/修改 route 时,前端签名同步零成本,杜绝"后端换了字段前端忘记改 → 静默 `any`"。

## Background

现状(`packages/zai/src/web/src/lib/api.ts`):

```ts
export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown, init?: RequestInit) => ...
  put: <T>(path: string, body: unknown) => ...
}
```

调用方:

```ts
const r = await api.post<{ type: string; payload: { ... } }>('/agent/command', body)
if (r.type === 'cleared') { ... }            // <- 类型完全靠手写,没约束
```

风险:
- 字段漂移(`${sid ...}` 之类拼写错误编译期发现不了)
- 服务端改 response schema,前端 `<T>` 不会报错
- 每次新增 route 都要在 `api.ts` 周边手写一遍路径常量

deepseek-harness 的做法(`packages/host/apiproxy/src/api/rpc-map.ts`):

```ts
export interface RpcMethodMap {
  'commands.list': { params: { sessionId: string }; result: CommandDescriptor[] }
  'commands.execute': { params: { sessionId: string; line: string }; result: CommandExecution }
  // ...
}
```

stub 由 codegen 扫 `RpcMethodMap` 生成 `ctx.remote.commands.list(...)` 类型化方法,IDE 内可见、自动补全、参数错位直接报错。

## Scope

- 在 `packages/zai/src/server/` 下新增 `rpcMethodMap.ts`(server-side 单源真相)
- 加 codegen 脚本 `scripts/generate-rpc-client.ts`,扫 `rpcMethodMap` → 生成 `packages/zai/src/web/src/lib/api.generated.ts`
- `web/src/lib/api.ts` 简化为 `export * from './api.generated'`(向后兼容老的 `api.get`/`api.post` 通用调用)
- 迁移 ~30 个 route 中的高频调用点到 generated stub;特殊场景(自定义 headers、流式)回落到通用 `api.post<T>`

非目标(留作后续):
- WebSocket 双向 RPC(目前 opencc-web 是 REST+SSE,无 server→client 调用需求)
- 运行时模式校验(zod schema 仍在,但生成 stub 只读类型,不强制运行时校验)

## Architecture

```
[server/routes/*.ts]
   │
   │  手工补充(每个 route 一行)
   ▼
[server/rpcMethodMap.ts]
   │  RpcMethodMap 是单一真相源 — path / method / request / response
   │  Zod schema 在 shared/* 已有,直接复用 type
   │
   │  pnpm run codegen:rpc
   ▼
[scripts/generate-rpc-client.ts]
   │
   ▼
[web/src/lib/api.generated.ts]   ← git 跟踪,运行时使用
   │  export const api = {
   │    command: { post: (body: { name: string; ... }) => Promise<CommandResponse> },
   │    prompt: { post: (body: PromptBody) => Promise<PromptResponse> },
   │    ...
   │  }
   ▼
[web/src/components / hooks]     ← 调用方,IDE 类型化
```

## rpcMethodMap 形态

```ts
// packages/zai/src/server/rpcMethodMap.ts
import type { CommandResponse, PromptBody, PromptResponse } from './routes/...'
// 或直接 import shared/* 的 zod schema,用 z.infer 取类型

export interface RpcMethodMap {
  'POST /api/agent/command': {
    request: { name?: string; args?: string; sessionId?: string }
    response: CommandResponse
  }
  'POST /api/agent/prompt': {
    request: PromptBody
    response: PromptResponse
  }
  'GET /api/cli/status': {
    request: undefined
    response: CliStatus
  }
  // ...
}
```

key 用 `${METHOD} ${path}` 是为了跟 routes 一眼对应,跟 deepseek-harness 的纯方法名不同(它面向 `ctx.remote.xxx` 命名空间,适合 WebSocket 双向 RPC;opencc-web 保留 REST path 命名,跟现有 invoke 习惯一致)。

## 生成 stub 示例

```ts
// web/src/lib/api.generated.ts —— 机械生成,勿手改
import { request } from './apiBase'
import type { RpcMethodMap } from '../../../server/rpcMethodMap'

type _Map = RpcMethodMap

export const api = {
  agent: {
    command: {
      post: (body: _Map['POST /api/agent/command']['request']) =>
        request<_Map['POST /api/agent/command']['response']>('POST', '/api/agent/command', body),
    },
    prompt: {
      post: (body: _Map['POST /api/agent/prompt']['request']) =>
        request<_Map['POST /api/agent/prompt']['response']>('POST', '/api/agent/prompt', body),
    },
  },
  cli: {
    status: {
      get: () => request<_Map['GET /api/cli/status']['response']>('GET', '/api/cli/status'),
    },
  },
  // ...
} as const
```

调用方:

```ts
// 之前
const r = await api.post<{ type: 'cleared' } | { type: 'message'; payload: { text: string } }>(
  '/agent/command', { name, args, sessionId }
)
if ((r as any).type === 'cleared') ...

// 之后
const r = await api.agent.command.post({ name, args, sessionId })
if (r.type === 'cleared') { ... }   // discriminated union 自动收窄
```

## Files

### New files (~3)

| Path | Purpose |
|---|---|
| `packages/zai/src/server/rpcMethodMap.ts` | `RpcMethodMap` 单源真相,server 与 generated stub 共用 |
| `packages/zai/src/web/src/lib/apiBase.ts` | 抽出来的 `request<T>(method, path, body?)`,保留 headers / notifyApiError 逻辑 |
| `scripts/generate-rpc-client.ts` | 扫 `rpcMethodMap`,输出 `api.generated.ts`(ts-morph 或字符串拼接均可) |

### Edited files (~5)

| Path | Change |
|---|---|
| `packages/zai/src/web/src/lib/api.ts` | 改为 `export * from './api.generated'`,保留 "api.get/post/put" 旧签名作为 fallback |
| `packages/zai/src/server/routes/*.ts` | 在每个 route 注释或导出处,把 request/response 类型登记到 `rpcMethodMap`(可半自动:从已有的 `interface CommandRequestBody` 直接搬) |
| `packages/zai/package.json` | `scripts.codegen:rpc` 加 `tsx scripts/generate-rpc-client.ts`;`build:zai` 前置 `codegen` |
| `packages/zai/test/web/api.test.ts` | 单测:generated stub 调用 → 真实 fetch 路径正确、类型回归(快照) |
| `docs/superpowers/specs/2026-08-16-rpc-type-safe-client-stubs.md` | 本文档 |

### Edit range

- 路由侧: 30 个 routes 文件, 优先做高频命令/会话类(`command.ts`、`prompt.ts`、`cli.ts`、`agent.ts`), 其余渐进迁移
- 调用方: 同步改对应调用(可以通过 `ts-prune` 找还没迁移的 `api.post<...>` 老调用)

## Migration Steps (建议顺序)

1. **抽 `apiBase.ts`** — 把现有 `api.ts` 里的 `request()` 挪到 `apiBase.ts`, 无功能变更;保留旧 `api.get/post/put` 兼容所有调用
2. **建 `rpcMethodMap.ts` 骨架** — 先收录 5 个最常用 route(`command` / `prompt` / `cli/status` / `health` / `agent/sessions`)
3. **写 codegen 脚本** — 用最简单实现(字符串模板),先跑通 5 个 → 验证 generated stub 类型正确
4. **AI 改调用方** — 把这 5 个 route 的所有调用点切到 `api.agent.command.post(...)` 风格,跑 `tsc --noEmit` 验证
5. **PG**: 逐 route 往 `rpcMethodMap` 加,跑 codegen,跑 build,逐步切完
6. **CI 校验** — `pnpm run build:zai` 失败时 codegen 产物过期 → 加 `git diff --exit-code` 检查

## Trade-offs

| 风险 | 缓解 |
|---|---|
| Codegen 失误导致类型静默错(never / any) | 限制 stub 用 `as const` + 严禁 `any`; 每个 route 至少一个测试覆盖 |
| `rpcMethodMap` 自身漂移(只改 route 忘改 map) | build:zai 强制 codegen 跑在 tsc 之前;git diff 校验生成文件 |
| 旧 `api.post<T>(path, body)` 调用残留 | `ts-prune` / `no-restricted-syntax` ESLint 规则禁掉;给迁移窗口期 |
| 类型膨胀(整个 response shape 暴露到所有调用) | response 用 `z.infer` 取,discriminated union 保留;前端按需 import |
| 跨 workspace 导入(generated stub 要 import server 的 `RpcMethodMap`) | 把 `RpcMethodMap` 抽到 `packages/zai/src/shared/rpc.ts`,server + web 共用 |

## Open Questions

- 是否引入 `ts-rest` / `zodios` 等现成 RPC 框架? 调研下来成本高于自写 codegen(它们的 request type 推导对 SSR 友好的设计 zai 用不上)
- `rpcMethodMap` 用 zod schema 还是纯 TS 类型? 纯 TS 轻、足够; 如果后续要 runtime 校验, 再加 zod
- shared/ 目录现已有 `events.ts`(Zod), 可以以它为模板给 `rpc.ts` 定一个 zod-backed pattern
