/**
 * sessionHost 公共类型 —— zai 主会话运行时 B1 路径(spawn `opencc -p`
 * 子进程 + stdio NDJSON + control_request 协议)的最小类型集。
 *
 * 详见 docs/superpowers/specs/2026-08-24-zai-runtime-printts-sse-web-bridge.md
 * §5(协议),本目录各文件是 Phase A 的最小实现。
 */

/** 单个会话进程宿主的生命周期状态。 */
export type SessionHostState =
  | 'pending' // spawn 请求已发出,stdout 尚无 init 行
  | 'initializing' // stdin/stdout pipe 已建立,等待 vendor system/init
  | 'ready' // vendor system/init 已到达,可接收 user message
  | 'killed' // 子进程已退出 / kill() 已调用(不可再 query)

/** spawn 一个会话进程的参数(client 侧,zai → cliSpawn)。 */
export interface SpawnRequest {
  /** zai 侧 sessionId(`sess-<uuid>`);传给 vendor 时剥离前缀。 */
  sessionId: string
  /** 会话工作目录 —— 同时作为 spawn cwd 与 vendor 项目根。 */
  cwd: string
  /** 会话主模型(zai resolvedModel);缺省走 env ANTHROPIC_DEFAULT_*_MODEL。 */
  model?: string
  /** 是否从已有 JSONL hydrate 对话历史(Phase C 启用,Phase A 仅预留)。 */
  resume?: boolean
}

/**
 * vendor stdin/stdout NDJSON 行的最小形状(解析后窄化用)。
 * `type` 是 vendor 事件判别字段:`system` / `stream_event` / `assistant` /
 * `user` / `result` / `control_request` / `control_response` / `keep_alive` …
 */
export interface NdjsonRow {
  type: string
  subtype?: string
  [key: string]: unknown
}

/** vendor stdout 上 control_request 的最小形状(request 方向:子进程 → SDK 宿主)。 */
export interface OutboundControlRequest extends NdjsonRow {
  type: 'control_request'
  request_id: string
  request: {
    subtype: string
    [key: string]: unknown
  }
}

/** vendor stdout `result` 行(一个 turn 的终结信号)。 */
export interface ResultRow extends NdjsonRow {
  type: 'result'
  subtype?: 'success' | 'error'
  is_error?: boolean
  session_id?: string
}