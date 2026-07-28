/**
 * Plugin runtime compat shim barrel — ported verbatim from
 * `@zn-ai/zai-agent-core/src/plugins/index.ts` as a compat shim.
 *
 * Path adjustments: none. All exports resolve to sibling files in
 * `compat/plugins/`.
 */

export { PluginRegistry, DefaultPluginRuntime } from './registry.js'
export { HookRunner } from './HookRunner.js'
export { createDefaultHookExecutor } from './defaultHookExecutor.js'
export { emptyPluginSnapshot } from './types.js'
export type * from './types.js'