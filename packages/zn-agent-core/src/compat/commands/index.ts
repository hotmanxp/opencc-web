// @zn-ai/zn-agent-core compat shim — port of zai-agent-core commands/index.ts.

export * from './types.js'
export { renderPrompt } from './promptRender.js'
export type { RenderArgs } from './promptRender.js'
export { getCommandRegistry, setCommandRegistry } from './registry.js'
export type { CommandRegistry, ResolvedCommand } from './registry.js'
// zai patch (2026-09-10, tf-mynh1twy): plugin command channel — zai registers
// vendor-loaded plugin commands (source === 'plugin') into the compat registry.
export { getLoadedPluginCommands } from './pluginCommands.js'