import { getCommandRegistry } from '@zn-ai/zn-agent-core'
import type { CommandContext } from '@zn-ai/zn-agent-core'
import { clearCommand } from './builtin/clear.js'
import { compactCommand } from './builtin/compact.js'
import { statusCommand } from './builtin/status.js'
import { handoffCommand } from './builtin/handoffCommand.js'
import { reloadUserCommands } from './userLoader.js'

let initialized = false

/**
 * Registers built-in commands into the agent-core singleton registry. Idempotent.
 */
export function registerBuiltinCommands(): void {
  if (initialized) return
  const reg = getCommandRegistry()
  reg.register(clearCommand)
  reg.register(compactCommand)
  reg.register(statusCommand)
  reg.register(handoffCommand)
  initialized = true
}

/**
 * Idempotent. Registers built-ins (once) + (re)loads user commands from disk.
 */
export async function initCommands(context: CommandContext): Promise<void> {
  registerBuiltinCommands()
  await reloadUserCommands(context)
}