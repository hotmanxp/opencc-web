// @zn-ai/zn-agent-core compat shim — port of zai-agent-core commands/index.ts.

export * from './types.js'
export { renderPrompt } from './promptRender.js'
export type { RenderArgs } from './promptRender.js'
export { getCommandRegistry, setCommandRegistry } from './registry.js'
export type { CommandRegistry, ResolvedCommand } from './registry.js'