import { getCommandRegistry } from '@zn-ai/zn-agent-core'
import type { CommandContext, Command } from '@zn-ai/zn-agent-core'
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
 * (Re)load plugin commands from the core runtime channel and register them
 * into the compat command registry with `source === 'plugin'`.
 *
 * tf-oqh9vikn taught slashList to collect these, but nothing registered them
 * (userLoader handles builtin + user only). This closes that gap.
 *
 * Idempotent: previously registered plugin commands are unregistered first,
 * so repeated calls never duplicate and commands from disabled/removed
 * plugins drop out. Degrades safely to a no-op when the core channel is
 * unavailable (e.g. an older core build without the export).
 */
export async function reloadPluginCommands(): Promise<void> {
  const reg = getCommandRegistry()
  // 1. clear stale plugin commands so re-registration never duplicates
  for (const cmd of reg.all().filter((c) => c.source === 'plugin')) {
    reg.unregister(cmd.name)
  }
  // 2. fetch the current loaded plugin commands via the core channel
  let cmds: Command[]
  try {
    const { getLoadedPluginCommands } = await import('@zn-ai/zn-agent-core')
    cmds = await getLoadedPluginCommands()
  } catch (err) {
    console.warn('[registry] plugin command channel unavailable; skipping plugin command registration:', err)
    return
  }
  // 3. register the fresh batch
  for (const cmd of cmds) {
    reg.register(cmd)
  }
}

/**
 * Idempotent. Registers built-ins (once) + (re)loads user commands from disk.
 */
export async function initCommands(context: CommandContext): Promise<void> {
  registerBuiltinCommands()
  await reloadUserCommands(context)
  await reloadPluginCommands()
}