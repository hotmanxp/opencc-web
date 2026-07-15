import { getCommandRegistry } from '@zn-ai/zai-agent-core'
import { clearCommand } from './builtin/clear.js'
import { compactCommand } from './builtin/compact.js'
import { statusCommand } from './builtin/status.js'

let initialized = false

/**
 * Registers built-in commands into the agent-core singleton registry.
 * Idempotent. User commands are loaded separately via reloadUserCommands
 * (see Task 4) and wired into a final initCommands in Task 4 Step 5.
 */
export function registerBuiltinCommands(): void {
  if (initialized) return
  const reg = getCommandRegistry()
  reg.register(clearCommand)
  reg.register(compactCommand)
  reg.register(statusCommand)
  initialized = true
}
