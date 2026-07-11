import type { SandboxConfig } from '../../src/runtime/types.js'

export function makeMockSandbox(workdir: string, opts: Partial<SandboxConfig> = {}): SandboxConfig {
  return { executor: 'child_process', workdir, ...opts }
}
