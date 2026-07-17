import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { resolvePluginPath, readJsonFileIfPresent } from '../manifest.js'
import { serializeError } from '../errors.js'
import type { LoadedPlugin, PluginSnapshot } from '../types.js'
import type { McpServerSpec } from '../../mcp/types.js'

const MCP_JSON_FILENAME = '.mcp.json'

/**
 * Load plugin MCP servers and append them to `snapshot.mcpServers`.
 * Names are prefixed with `plugin:<pluginName>:` to avoid collisions
 * with user-configured servers, and the same prefixed name is added to
 * `snapshot.pluginMcpServerNames`.
 *
 * Discovery order:
 *   1. `<root>/.mcp.json` — read if present.
 *   2. `manifest.mcpServers` — accepted as:
 *      - inline object: `{ name: <serverConfig> }`
 *      - relative JSON path string
 *      - array mixing inline objects and relative JSON paths
 *
 * `.mcpb` / `.dxt` bundle paths push `unsupported-mcp-bundle` errors and
 * are skipped; other entries continue loading.
 *
 * Failure modes (invalid shape, IO errors, parse failures, unsupported
 * transport, path-outside-root) all surface as structured errors on
 * `snapshot.errors` and never abort the loop.
 */
export async function loadPluginMcpServers(
  plugin: LoadedPlugin,
  snapshot: PluginSnapshot,
): Promise<void> {
  const pluginId = plugin.id
  const pluginName = plugin.manifest.name
  const pluginRoot = plugin.root

  // 1. .mcp.json at the plugin root (preferred).
  const mcpJsonPath = join(pluginRoot, MCP_JSON_FILENAME)
  const mcpJsonRaw = await readJsonFileIfPresent(mcpJsonPath)
  if (mcpJsonRaw !== null) {
    await ingestMcpConfig({
      raw: mcpJsonRaw,
      origin: MCP_JSON_FILENAME,
      pluginId,
      pluginName,
      snapshot,
    })
  }

  // 2. manifest.mcpServers (inline / path / array).
  const declared = plugin.manifest.mcpServers
  if (declared === undefined || declared === null) return

  const sources: unknown[] = []
  if (Array.isArray(declared)) {
    sources.push(...declared)
  } else if (
    typeof declared === 'string' ||
    (typeof declared === 'object' && !Array.isArray(declared))
  ) {
    sources.push(declared)
  }

  for (const item of sources) {
    if (typeof item === 'string') {
      await ingestRelativePath({
        relPath: item,
        pluginRoot,
        pluginId,
        pluginName,
        snapshot,
      })
    } else if (typeof item === 'object' && item !== null) {
      await ingestMcpConfig({
        raw: item,
        origin: 'manifest.mcpServers',
        pluginId,
        pluginName,
        snapshot,
      })
    } else {
      snapshot.errors.push({
        code: 'plugin_mcp_invalid_entry',
        message: `Plugin mcpServers entry must be an object or a string path, got ${typeof item}.`,
        component: 'mcp',
        pluginId,
        detail: { value: item },
      })
    }
  }
}

type IngestConfigInput = {
  raw: unknown
  origin: string
  pluginId: string
  pluginName: string
  snapshot: PluginSnapshot
}

/**
 * Ingest one MCP config object. Accepts:
 *   - `{ mcpServers: { name: <serverConfig> } }` (canonical shape)
 *   - `{ name: <serverConfig> }` (already in inline form)
 *
 * Anything else is logged as a structured error.
 */
async function ingestMcpConfig(input: IngestConfigInput): Promise<void> {
  const { raw, origin, pluginId, pluginName, snapshot } = input

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    snapshot.errors.push({
      code: 'plugin_mcp_invalid_entry',
      message: `MCP config from ${origin} must be an object.`,
      component: 'mcp',
      pluginId,
      path: origin,
    })
    return
  }

  const obj = raw as Record<string, unknown>
  const inner =
    obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)
      ? (obj.mcpServers as Record<string, unknown>)
      : obj

  for (const [serverName, serverRaw] of Object.entries(inner)) {
    if (typeof serverName !== 'string' || serverName.length === 0) {
      snapshot.errors.push({
        code: 'plugin_mcp_invalid_entry',
        message: `MCP server name from ${origin} must be a non-empty string.`,
        component: 'mcp',
        pluginId,
        path: origin,
      })
      continue
    }

    // Bundle detection: any value that is a string ending in
    // `.mcpb`/`.dxt` is treated as an unsupported bundle. The brief
    // only requires this when the bundle is referenced as a path,
    // but the same heuristic inside an inline string catches the
    // common case of `"server": "plugin.mcpb"`.
    if (
      typeof serverRaw === 'string' &&
      (serverRaw.toLowerCase().endsWith('.mcpb') ||
        serverRaw.toLowerCase().endsWith('.dxt'))
    ) {
      pushBundleError({
        serverName,
        bundlePath: serverRaw,
        pluginId,
        snapshot,
      })
      continue
    }

    const spec = normalizeServer({
      serverName,
      raw: serverRaw,
      pluginName,
    })
    if (spec.error) {
      snapshot.errors.push({
        ...spec.error,
        component: 'mcp',
        pluginId,
        path: origin,
      })
      continue
    }
    if (!spec.server) continue
    snapshot.mcpServers.push(spec.server)
    snapshot.pluginMcpServerNames.push(spec.server.name)
  }
}

type IngestPathInput = {
  relPath: string
  pluginRoot: string
  pluginId: string
  pluginName: string
  snapshot: PluginSnapshot
}

async function ingestRelativePath(input: IngestPathInput): Promise<void> {
  const { relPath, pluginRoot, pluginId, pluginName, snapshot } = input

  // Bundle path detection happens before path resolution so we don't
  // even attempt to stat the file.
  if (
    relPath.toLowerCase().endsWith('.mcpb') ||
    relPath.toLowerCase().endsWith('.dxt')
  ) {
    pushBundleError({
      serverName: basenameNoExt(relPath),
      bundlePath: relPath,
      pluginId,
      snapshot,
    })
    return
  }

  let resolved: string
  try {
    resolved = await resolvePluginPath(pluginRoot, relPath, 'mcp')
  } catch (cause) {
    snapshot.errors.push({
      code: 'plugin_path_outside_root',
      message: `Plugin mcpServers path "${relPath}" resolves outside the plugin root.`,
      component: 'mcp',
      pluginId,
      path: relPath,
      detail: serializeError(cause),
    })
    return
  }

  const st = await stat(resolved).catch(() => null)
  if (!st) {
    snapshot.errors.push({
      code: 'plugin_component_missing',
      message: `Plugin mcpServers path "${relPath}" does not exist.`,
      component: 'mcp',
      pluginId,
      path: relPath,
    })
    return
  }
  if (st.isDirectory()) {
    // A directory is treated as containing many server files. Walk one
    // level and ingest each `.json`.
    const entries = await readdir(resolved, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (!e.isFile() || !e.name.toLowerCase().endsWith('.json')) continue
      await ingestRelativePath({
        relPath: join(relPath, e.name),
        pluginRoot,
        pluginId,
        pluginName,
        snapshot,
      })
    }
    return
  }

  let raw: unknown
  try {
    raw = await readJsonFileIfPresent(resolved)
  } catch (cause) {
    snapshot.errors.push({
      code: 'plugin_mcp_parse_error',
      message: `Failed to parse MCP config at ${resolved}.`,
      component: 'mcp',
      pluginId,
      path: resolved,
      detail: serializeError(cause),
    })
    return
  }
  if (raw === null) {
    snapshot.errors.push({
      code: 'plugin_component_missing',
      message: `Plugin mcpServers path "${relPath}" could not be read.`,
      component: 'mcp',
      pluginId,
      path: relPath,
    })
    return
  }

  await ingestMcpConfig({
    raw,
    origin: relPath,
    pluginId,
    pluginName,
    snapshot,
  })
}

type NormalizeResult =
  | { server: McpServerSpec; error?: undefined }
  | { server?: undefined; error: { code: string; message: string; detail?: unknown } }

function normalizeServer(input: {
  serverName: string
  raw: unknown
  pluginName: string
}): NormalizeResult {
  const { serverName, raw, pluginName } = input

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      error: {
        code: 'plugin_mcp_invalid_server',
        message: `MCP server "${serverName}" must be an object.`,
      },
    }
  }

  const obj = raw as Record<string, unknown>
  const exposedName = `plugin:${pluginName}:${serverName}`

  // OpenCC-compatible transport detection: `type` is the canonical
  // discriminator; some manifests write `command`/`url` directly without
  // an explicit type.
  const explicitType = typeof obj.type === 'string' ? obj.type.toLowerCase() : undefined

  if (explicitType === 'stdio' || (explicitType === undefined && typeof obj.command === 'string')) {
    if (typeof obj.command !== 'string' || obj.command.length === 0) {
      return {
        error: {
          code: 'plugin_mcp_invalid_server',
          message: `MCP server "${serverName}" (stdio) requires a non-empty "command".`,
        },
      }
    }
    const args = Array.isArray(obj.args)
      ? obj.args.filter((a): a is string => typeof a === 'string')
      : undefined
    const env = isStringRecord(obj.env) ? obj.env : undefined
    return {
      server: {
        name: exposedName,
        transport: {
          kind: 'stdio',
          command: obj.command,
          ...(args ? { args } : {}),
          ...(env ? { env } : {}),
        },
      },
    }
  }

  if (explicitType === 'sse' || (explicitType === undefined && typeof obj.url === 'string' && obj.url.includes('/sse'))) {
    if (typeof obj.url !== 'string' || obj.url.length === 0) {
      return {
        error: {
          code: 'plugin_mcp_invalid_server',
          message: `MCP server "${serverName}" (sse) requires a non-empty "url".`,
        },
      }
    }
    const headers = isStringRecord(obj.headers) ? obj.headers : undefined
    return {
      server: {
        name: exposedName,
        transport: {
          kind: 'sse',
          url: obj.url,
          ...(headers ? { headers } : {}),
        },
      },
    }
  }

  if (explicitType === 'http' || explicitType === 'streamable-http') {
    if (typeof obj.url !== 'string' || obj.url.length === 0) {
      return {
        error: {
          code: 'plugin_mcp_invalid_server',
          message: `MCP server "${serverName}" (http) requires a non-empty "url".`,
        },
      }
    }
    const headers = isStringRecord(obj.headers) ? obj.headers : undefined
    return {
      server: {
        name: exposedName,
        transport: {
          kind: 'http',
          url: obj.url,
          ...(headers ? { headers } : {}),
        },
      },
    }
  }

  // Unsupported transport type.
  return {
    error: {
      code: 'plugin_mcp_unsupported_transport',
      message: `MCP server "${serverName}" has unsupported transport "${
        explicitType ?? '<missing>'
      }".`,
      detail: { explicitType, raw: obj },
    },
  }
}

function pushBundleError(input: {
  serverName: string
  bundlePath: string
  pluginId: string
  snapshot: PluginSnapshot
}): void {
  input.snapshot.errors.push({
    code: 'unsupported-mcp-bundle',
    message: `MCP bundle "${input.bundlePath}" is not supported (only inline/JSON MCP configs are).`,
    component: 'mcp',
    pluginId: input.pluginId,
    path: input.bundlePath,
    detail: { serverName: input.serverName },
  })
}

function basenameNoExt(p: string): string {
  const base = p.split(/[\\/]+/).pop() ?? p
  return base.replace(/\.[^.]+$/, '')
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  for (const value of Object.values(v as Record<string, unknown>)) {
    if (typeof value !== 'string') return false
  }
  return true
}