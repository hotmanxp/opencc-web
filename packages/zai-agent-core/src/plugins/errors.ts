import type {
  PluginComponent,
  PluginLoadError,
  PluginSourceName,
} from './types.js'

/**
 * Factory helpers for `PluginLoadError`. Kept tiny on purpose — only the
 * shape used by manifest + path-boundary code (Task 2). Later tasks
 * extend this file as new error codes appear.
 *
 * Every helper returns a fully populated object literal so callers can
 * `throw` or `return` directly without filling in fields twice. The
 * `code` is a string literal union over known load error codes; unknown
 * codes can still be produced by constructing the object directly.
 */

export type PluginLoadErrorOptions = {
  source?: PluginSourceName
  pluginId?: string
  component?: PluginComponent
  path?: string
  detail?: unknown
}

function make(code: string, message: string, opts: PluginLoadErrorOptions = {}): PluginLoadError {
  return {
    code,
    message,
    ...(opts.source !== undefined ? { source: opts.source } : {}),
    ...(opts.pluginId !== undefined ? { pluginId: opts.pluginId } : {}),
    ...(opts.component !== undefined ? { component: opts.component } : {}),
    ...(opts.path !== undefined ? { path: opts.path } : {}),
    ...(opts.detail !== undefined ? { detail: opts.detail } : {}),
  }
}

export function manifestNotFoundError(opts: PluginLoadErrorOptions = {}): PluginLoadError {
  return make(
    'manifest_not_found',
    'No plugin manifest found (looked for .claude-plugin/plugin.json and plugin.json).',
    opts,
  )
}

export function manifestDuplicatePathsError(
  primaryPath: string,
  secondaryPath: string,
  opts: PluginLoadErrorOptions = {},
): PluginLoadError {
  return make(
    'manifest_duplicate_paths',
    `Both .claude-plugin/plugin.json and root plugin.json are present. Remove one.`,
    { ...opts, detail: { primaryPath, secondaryPath } },
  )
}

export function manifestParseError(
  manifestPath: string | null,
  cause: unknown,
  opts: PluginLoadErrorOptions = {},
): PluginLoadError {
  return make(
    'manifest_parse_error',
    `Failed to parse plugin manifest JSON at ${manifestPath ?? '<unknown>'}.`,
    { ...opts, path: manifestPath ?? undefined, detail: serializeError(cause) },
  )
}

export function manifestInvalidError(
  reason: string,
  opts: PluginLoadErrorOptions = {},
): PluginLoadError {
  return make('manifest_invalid', `Plugin manifest is invalid: ${reason}`, opts)
}

export function pathOutsideRootError(
  root: string,
  relPath: string,
  component: PluginComponent,
  resolved: string,
  opts: PluginLoadErrorOptions = {},
): PluginLoadError {
  return make(
    'plugin_path_outside_root',
    `Plugin component path "${relPath}" resolves outside the plugin root.`,
    { ...opts, component, path: relPath, detail: { root, resolved } },
  )
}

/**
 * Convert an unknown thrown value into a JSON-serializable shape so it can
 * live in `PluginLoadError.detail`. Strips non-serializable bits; never
 * throws.
 */
export function serializeError(err: unknown): unknown {
  if (err === null || err === undefined) return null
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      ...(err.stack !== undefined ? { stack: err.stack } : {}),
    }
  }
  if (typeof err === 'object') {
    try {
      return JSON.parse(JSON.stringify(err))
    } catch {
      return String(err)
    }
  }
  return err
}