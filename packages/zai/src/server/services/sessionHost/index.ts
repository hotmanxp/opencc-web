/**
 * sessionHost barrel —— zai 主会话运行时 B1 路径(spawn `opencc -p` 子进程)
 * 的统一导出。上层 agentRuntime.ts 只从这里 import。
 */

export { SessionHost } from './SessionHost.js'
export { SessionRegistry } from './SessionRegistry.js'
export { parseNdjson } from './ndjsonStream.js'
export { ControlRequestRegistry } from './controlRequest.js'
export { buildCliArgs, spawnSessionHost, toVendorSessionId } from './cliSpawn.js'
export type * from './types.js'