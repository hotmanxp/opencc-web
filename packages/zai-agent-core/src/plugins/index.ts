import { PluginRegistry, registryOptionsFromConfig } from './registry.js'
import { emptyPluginSnapshot } from './types.js'
import type { PluginRuntime, PluginRuntimeConfig, PluginSnapshot } from './types.js'

export class DefaultPluginRuntime implements PluginRuntime {
  private readonly registry: PluginRegistry
  private cache?: Promise<PluginSnapshot>

  constructor(private readonly config: PluginRuntimeConfig = {}) {
    this.registry = new PluginRegistry(registryOptionsFromConfig(config))
  }

  load(input: { cwd: string; signal?: AbortSignal }): Promise<PluginSnapshot> {
    if (this.config.enabled === false) return Promise.resolve(emptyPluginSnapshot())
    this.cache ??= this.registry.loadSnapshot(input)
    return this.cache
  }

  clearCache(): void {
    this.cache = undefined
    this.registry.clearCache()
  }
}

export { PluginRegistry } from './registry.js'
export { HookRunner } from './HookRunner.js'
export { createDefaultHookExecutor } from './defaultHookExecutor.js'
export { emptyPluginSnapshot } from './types.js'
export type * from './types.js'

