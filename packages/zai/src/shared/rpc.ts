// 类型化 RPC client stub 的单源真相 — SPEC:
//   docs/superpowers/specs/2026-08-16-rpc-type-safe-client-stubs.md
//
// 设计:
// - key = `${METHOD} ${path}` (e.g. 'POST /api/agent/command'), 跟 routes
//   一眼对应, 跟 dsh 的纯方法名 (e.g. 'commands.execute') 不同 (后者面向
//   `ctx.remote.xxx` 命名空间, 适合 WebSocket 双向 RPC; zai 保留 REST path
//   命名, 跟现 invoke 习惯一致, 也方便 cross-reference).
// - 每个 entry 有 `request` (body 类型, GET 一律 `undefined`) 和 `response`
//   (response JSON 类型). 严格对齐 routes 的 `res.json(...)` 形状.
// - 由 `scripts/generate-rpc-client.ts` AST 扫描本文件 (typescript 包, 无
//   新依赖) → 生成 `web/src/lib/api.generated.ts`. 调用方明确用
//   `api.agent.command.post(body)` 风格, 字段漂移编译期捕获.
//
// 添加新 route:
// 1. 在 RpcMethodMap 里加一行 `{METHOD} /api/...': { request: ..., response: ... }`
// 2. 跑 `pnpm run codegen:rpc` 重新生成 `api.generated.ts`
// 3. 提交 generated stub 一起
//
// 当前覆盖高频 5 个 route (高频命令 / 会话 / 健康 / CLI 状态 / prompt)。
// 30 个 routes 渐进迁移的进度, 后续 plan 跟进。

import type { CliStatus } from './types.js'

// /api/agent/command 路由的 discriminated union response. 同步
// routes/command.ts 的 res.json type; 新增 kind 必须同步这里 +
// CommandEvent union + 该处 res.json, zod 编译期拦截飘移。
export type CommandResponse =
  | { type: 'cleared'; payload: null }
  | { type: 'compacted'; payload: { removedMessages: number; summary: string } }
  | { type: 'status'; payload: Record<string, unknown> }
  | { type: 'message'; payload: { text: string } }
  | { type: 'prompt'; payload: { rendered: string } }
  | { type: 'error'; payload: { message: string } }
  | { type: 'unknown'; payload: { input: string } }

// /api/agent/prompt 路由的 request 类型, 跟 routes/agent.ts:157 的
// PromptRequest zod schema 严格对齐。
export interface PromptRequest {
  prompt?: string
  contentBlocks?: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  >
  cwd?: string
  sessionId?: string
  permissionMode?: string
}

export interface PromptResponse {
  sessionId: string
  queued: boolean
  queueLength: number
  pending: Array<{ id: string; text: string }>
}

export interface RpcMethodMap {
  /** GET /api/health — 健康检查, 启动探测 + 监控 */
  'GET /api/health': {
    request: undefined
    response: { ok: boolean; version: string }
  }

  /** GET /api/cli — CLI 工具状态列表 (Tools 页) */
  'GET /api/cli': {
    request: undefined
    response: CliStatus[]
  }

  /** GET /api/agent/sessions — 列出当前实例 cwd 对应的 session */
  'GET /api/agent/sessions': {
    request: undefined
    response: { sessions: unknown[] } | { error: string }
  }

  /** POST /api/agent/sessions — 立即建一条空 transcript */
  'POST /api/agent/sessions': {
    request: { model?: string; providerId?: string }
    response: { sessionId: string } | { error: string }
  }

  /** POST /api/agent/command — 跑 slash command (/clear /compact /handoff /help) */
  'POST /api/agent/command': {
    request: { name?: string; args?: string; sessionId?: string }
    response: CommandResponse
  }

  /** POST /api/agent/prompt — 发送用户 prompt (文本或 image 块) */
  'POST /api/agent/prompt': {
    request: PromptRequest
    response: PromptResponse
  }

  // ─── Weixin (微信) 机器人路由 — B4 阶段 ──────────────
  // 详见 docs/superpowers/plans/2026-08-16-zai-weixin-bot-platform.md

  /** GET /api/weixin/status — 微信适配器状态 */
  'GET /api/weixin/status': {
    request: undefined
    response: {
      configured: boolean
      enabled: boolean
      state: 'unconfigured' | 'disabled' | 'failed' | 'connecting' | 'connected' | 'disconnected'
      accountId?: string
      lastError?: string
      lastConnAt?: number
    }
  }

  /** POST /api/weixin/connect — 启用 + 连接 */
  'POST /api/weixin/connect': {
    request: Record<string, never> | undefined
    response: {
      configured: boolean
      enabled: boolean
      state: 'unconfigured' | 'disabled' | 'failed' | 'connecting' | 'connected' | 'disconnected'
      accountId?: string
      lastError?: string
      lastConnAt?: number
    }
  }

  /** POST /api/weixin/disconnect — 断开 */
  'POST /api/weixin/disconnect': {
    request: Record<string, never> | undefined
    response: {
      configured: boolean
      enabled: boolean
      state: 'unconfigured' | 'disabled' | 'failed' | 'connecting' | 'connected' | 'disconnected'
      accountId?: string
      lastError?: string
      lastConnAt?: number
    }
  }

  /** POST /api/weixin/reload — 重启 adapter(settings 改后) */
  'POST /api/weixin/reload': {
    request: Record<string, never> | undefined
    response: {
      configured: boolean
      enabled: boolean
      state: 'unconfigured' | 'disabled' | 'failed' | 'connecting' | 'connected' | 'disconnected'
      accountId?: string
      lastError?: string
      lastConnAt?: number
    }
  }

  /** POST /api/weixin/setup/start — 启动 QR 登录 */
  'POST /api/weixin/setup/start': {
    request: Record<string, never> | undefined
    response: {
      qrcodeId: string
      qrcodeUrl: string
      pollUrl: string
    }
  }

  /** GET /api/weixin/setup/poll?qrcodeId= */
  'GET /api/weixin/setup/poll': {
    request: { qrcodeId: string }
    response: {
      status: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'gone'
      accountId?: string
      baseUrl?: string
    }
  }

  /** POST /api/weixin/setup/confirm — 手动凭据 + reload */
  'POST /api/weixin/setup/confirm': {
    request: { accountId: string; token: string; baseUrl?: string }
    response: {
      configured: boolean
      enabled: boolean
      state: 'unconfigured' | 'disabled' | 'failed' | 'connecting' | 'connected' | 'disconnected'
    }
  }

  /** POST /api/weixin/setup/cancel */
  'POST /api/weixin/setup/cancel': {
    request: Record<string, never> | undefined
    response: { status: 'cancelled' }
  }

  // ─── MCP — 活状态 + 手动重连 ─────────────────────────
  // 后台连接失败后进程内不再有 MCP 工具;这两个端点让设置页展示并重试。
  // 形状与 core 的 OpenccMcpStatus(serverTypes.ts)对齐。

  /** GET /api/mcp/status — 各 MCP server 状态 + 最近失败汇总 */
  'GET /api/mcp/status': {
    request: undefined
    response: McpStatusResponse
  }

  /** POST /api/mcp/reconnect — 重跑一遍连接(含 5s/15s 退避,最坏 ~20s) */
  'POST /api/mcp/reconnect': {
    request: Record<string, never> | undefined
    response: McpStatusResponse
  }
}

/** 见 core `opencc-src/server/serverTypes.ts` 的 OpenccMcpStatus。 */
export type McpStatusResponse = {
  lazyConnect: boolean
  connecting: boolean
  servers: Array<{
    name: string
    /** connected | failed | needs-auth | pending(disabled 已被服务端过滤掉) */
    type: string
    toolCount: number
    commandCount: number
    error?: string
  }>
  commands: Array<{
    name: string
    displayName: string
    description: string
    serverName: string
    argNames?: string[]
  }>
  lastConnectFailure: {
    at: number
    failed: number
    total: number
    servers: string[]
  } | null
}
