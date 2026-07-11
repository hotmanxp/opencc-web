import type { SandboxConfig } from './types.js'
import type { CanUseToolResult } from '../tools/Tool.js'

export function defaultCanUseToolFactory(config: SandboxConfig | undefined) {
  return async (toolName: string, input: unknown): Promise<CanUseToolResult> => {
    if (toolName === 'Bash') {
      if (!config) return { behavior: 'deny', reason: 'Bash disabled: no sandbox configured' }
      const cmd = (input as { command?: string } | undefined)?.command ?? ''
      if (config.commandDenylist?.some(re => re.test(cmd))) {
        return { behavior: 'deny', reason: 'command matches denylist' }
      }
      if (config.commandAllowlist && !config.commandAllowlist.some(re => re.test(cmd))) {
        return { behavior: 'deny', reason: 'command not in allowlist' }
      }
    }
    if (toolName === 'Agent') {
      return { behavior: 'allow' }
    }
    return { behavior: 'allow' }
  }
}
