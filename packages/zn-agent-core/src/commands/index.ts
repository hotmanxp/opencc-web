// @zn-ai/zn-agent-core/commands — re-export the compat commands layer.
//
// The previous implementation re-exported from `../opencc-src/commands/index.js`
// which does not exist (opencc 0.20.0 has `commands.ts` in a different layout).
// zai consumes command metadata through `getCommandRegistry` /
// `renderPrompt` (compat/commands) so the compat layer is the right surface.
export * from '../compat/commands/index.js'
