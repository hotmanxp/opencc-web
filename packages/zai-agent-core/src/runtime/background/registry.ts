import type { BackgroundRuntime } from './BackgroundRuntime.js'

let _runtime: BackgroundRuntime | null = null

/**
 * 全局 BackgroundRuntime 注册中心。
 * - zai 包在 initBackgroundRuntime() 中调用 setBackgroundRuntime(runtime)
 * - BackgroundAgentTool / BackgroundAgentResultTool 通过 getBackgroundRuntime() 拿
 *
 * 这种间接方式避免了 zai-agent-core 反向依赖 zai,
 * 同时让外部 SDK 也能注入自己的 runtime 实例。
 */
export function setBackgroundRuntime(runtime: BackgroundRuntime | null): void {
  _runtime = runtime
}

export function getBackgroundRuntime(): BackgroundRuntime {
  if (!_runtime) {
    throw new Error(
      'BackgroundRuntime 未初始化。请在调用 query() 之前通过 setBackgroundRuntime() 注入。',
    )
  }
  return _runtime
}

export function hasBackgroundRuntime(): boolean {
  return _runtime !== null
}