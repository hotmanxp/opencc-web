import { join } from 'node:path'

export type ResolveOpenccConfigDirOptions = {
  /** Explicit override; wins over both env vars. */
  configDir?: string
  /** Override `process.env` lookup for testability. */
  env?: NodeJS.ProcessEnv
}

/**
 * Resolve the OpenCC config directory.
 *
 * Priority:
 *   1. `opts.configDir` (explicit)
 *   2. `OPENCC_CONFIG_DIR` env var
 *   3. `CLAUDE_CONFIG_DIR` env var
 *   4. `undefined` — caller decides the default (typically `~/.claude`)
 *
 * Pure function: no filesystem I/O, no implicit `process.env` reads.
 * Pass `opts.env` to inject a deterministic environment in tests.
 */
export function resolveOpenccConfigDir(opts: ResolveOpenccConfigDirOptions = {}): string | undefined {
  if (opts.configDir !== undefined && opts.configDir !== '') {
    return opts.configDir
  }
  const env = opts.env ?? {}
  const opencc = env.OPENCC_CONFIG_DIR
  if (opencc !== undefined && opencc !== '') {
    return opencc
  }
  const claude = env.CLAUDE_CONFIG_DIR
  if (claude !== undefined && claude !== '') {
    return claude
  }
  return undefined
}

/**
 * Resolve the OpenCC plugins directory (`<configDir>/plugins`).
 *
 * `configDir` is required — we never silently fall back to the real
 * filesystem. Callers that need a default should pipe `resolveOpenccConfigDir`
 * through here and supply their own fallback.
 */
export function resolveOpenccPluginsDir(configDir: string): string {
  if (!configDir) {
    throw new Error('resolveOpenccPluginsDir: configDir is required')
  }
  return join(configDir, 'plugins')
}

export type ResolveZaiPluginsDirOptions = {
  /** Override the default `<dataDir>/plugins`. */
  pluginsDir?: string
}

/**
 * Resolve the ZAI plugins directory.
 *
 * Default: `<dataDir>/plugins`. Pass `opts.pluginsDir` to override.
 * `dataDir` is required — never reads the real filesystem.
 */
export function resolveZaiPluginsDir(dataDir: string, pluginsDir?: string): string {
  if (!dataDir) {
    throw new Error('resolveZaiPluginsDir: dataDir is required')
  }
  if (pluginsDir !== undefined && pluginsDir !== '') {
    return pluginsDir
  }
  return join(dataDir, 'plugins')
}