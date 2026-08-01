/**
 * Plugin runtime barrel.
 *
 * Re-exports the plugin runtime's public surface from sibling files in
 * `compat/plugins/`: `PluginRegistry` and `DefaultPluginRuntime` from the
 * registry, `HookRunner` from the hook orchestrator, `createDefaultHookExecutor`
 * from the child-process executor, `emptyPluginSnapshot` and the type
 * namespace from `./types.js`, and `resolveOpenccConfigDir` from `./paths.js`.
 *
 * zai-server's plugin consumer (`services/agentRuntime.ts`,
 * `services/pluginRuntime.ts`) imports from this barrel so the public
 * shape stays stable as the implementation files are split further.
 */

export { PluginRegistry, DefaultPluginRuntime } from './registry.js'
export { HookRunner } from './HookRunner.js'
export { createDefaultHookExecutor } from './defaultHookExecutor.js'
export { emptyPluginSnapshot } from './types.js'
export { resolveOpenccConfigDir } from './paths.js'
export type * from './types.js'