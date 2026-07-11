import type { QueryOptions, RuntimeConfig } from './types.js'

export function buildSubagentContext(
  options: QueryOptions,
  _config: RuntimeConfig,
  _sessionId: string,
): { initialUserMessage?: { role: 'user'; content: string } } {
  return {
    initialUserMessage: typeof options.prompt === 'string'
      ? { role: 'user', content: options.prompt }
      : undefined,
  }
  // sessionId 与 parentSessionId 关联在 transcript 写入时处理
}
