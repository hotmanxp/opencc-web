// @ts-nocheck -- this module bridges opencc-internals McpServerSpec types from
// zai-agent-core with the .mcp.json wire format. The McpServerSpec variants
// differ between zod v3 (zai-agent-core) and zod/v4 (opencc-internals), so
// we keep the boundary type-checked at runtime only.

import { readFileSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, parse } from 'node:path'
import type { McpServerSpec } from '@zn-ai/zai-agent-core'

type McpJsonServer = {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  type?: 'stdio' | 'sse' | 'http' | 'ws'
  headers?: Record<string, string>
  bearerEnvVar?: string
  headerEnvVars?: Record<string, string>
}

type McpJsonFile = {
  mcpServers?: Record<string, McpJsonServer>
  // Claude Code compat: per-file allowlist/blocklist for .mcp.json.
  // Only honored in project scope.
  enabledMcpjsonServers?: unknown
  disabledMcpjsonServers?: unknown
  // Claude Code compat: global disable list, typically in user-scope
  // (~/.claude.json / ~/.zai.json). Applied as final filter across all
  // scopes' merged spec list.
  disabledMcpServers?: unknown
}

type ParsedMcpFile = {
  servers: McpServerSpec[]
  // `null` = key absent or non-array (treated as "not set" — no filter
  // applied). `[]` = present but empty (allowlist with 0 entries → nothing
  // loads from this file).
  enabledMcpjsonServers: string[] | null
  disabledMcpjsonServers: string[] | null
  disabledMcpServers: string[] | null
}

type Scope = 'enterprise' | 'user' | 'project' | 'local'

type ScopeLoadResult = {
  scope: Scope
  source: string
  servers: McpServerSpec[]
}

/**
 * Load MCP server configs from all 4 scopes (mirrors opencc's
 * `getClaudeCodeMcpConfigs` precedence):
 *
 *   enterprise > user > local > project
 *
 * Sources:
 *
 *   enterprise (exclusive if present):
 *     - $ZAI_MANAGED_MCP_CONFIG env (absolute path)
 *     - $XDG_CONFIG_HOME/zai/managed-mcp.json
 *     - /etc/zai/managed-mcp.json
 *
 *   user (cross-project, override project):
 *     - $HOME/.zai.json
 *     - $HOME/.claude.json
 *
 *   local (project-scoped, override project, gitignored):
 *     - $cwd/.claude/settings.local.json
 *
 *   project (committed to repo, walk up from cwd to root):
 *     - $cwd/.mcp.json, $parent/.mcp.json, ..., $root/.mcp.json
 *
 * Returns merged list with scope tag. Same name in a higher-scope source
 * overrides lower-scope entries.
 */
export function loadMcpServers(cwd: string): McpServerSpec[] {
  const byName = new Map<string, { spec: McpServerSpec; scope: Scope }>()
  // Union of `disabledMcpServers` declared anywhere (typically user scope).
  // Applied as a final filter after all scopes merge.
  const globalDisabled = new Set<string>()

  // Helper: ingest a parsed file. For project scope, apply the per-file
  // enabled/disabledMcpjsonServers filter before adding to byName. For all
  // scopes, collect disabledMcpServers into the global disable set.
  // Returns a ScopeLoadResult for callers that want the per-file view
  // (used by `describeMcpSources`).
  const ingest = (parsed: ParsedMcpFile, scope: Scope, source: string): ScopeLoadResult => {
    if (parsed.disabledMcpServers) {
      for (const name of parsed.disabledMcpServers) globalDisabled.add(name)
    }
    let filtered = parsed.servers
    if (scope === 'project') {
      if (parsed.enabledMcpjsonServers !== null) {
        // Allowlist (even empty → load nothing from this file).
        const allowed = new Set(parsed.enabledMcpjsonServers)
        filtered = filtered.filter((s) => allowed.has(s.name))
      } else if (parsed.disabledMcpjsonServers !== null) {
        // Blocklist (only set if enabled is absent).
        const blocked = new Set(parsed.disabledMcpjsonServers)
        filtered = filtered.filter((s) => !blocked.has(s.name))
      }
    }
    for (const spec of filtered) {
      byName.set(spec.name, { spec, scope })
    }
    return { scope, source, servers: filtered }
  }

  // 1. project: walk up from cwd to root, collect .mcp.json files.
  //    Deeper dirs override parents (process from root → cwd).
  const projectLoads: ScopeLoadResult[] = []
  const dirs: string[] = []
  let cur = cwd
  while (true) {
    dirs.push(cur)
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  for (const dir of dirs.reverse()) {
    const path = join(dir, '.mcp.json')
    const parsed = parseFile(path)
    if (parsed) {
      projectLoads.push(ingest(parsed, 'project', path))
    }
  }

  // 2. local: $cwd/.claude/settings.local.json (zai's project-local).
  //    Falls back to ~/.claude/settings.local.json only if cwd version missing
  //    (rare — opencc keeps project-local inside .claude/).
  const localPaths = [
    join(cwd, '.claude', 'settings.local.json'),
    join(homedir(), '.claude', 'settings.local.json'),
  ]
  const localLoads: ScopeLoadResult[] = []
  for (const p of localPaths) {
    const parsed = parseFile(p)
    if (parsed) {
      localLoads.push(ingest(parsed, 'local', p))
    }
  }

  // 3. user: $HOME/.zai.json (zai-specific) if present, else fall back to
  //    $HOME/.claude.json (opencc compat). Mutually exclusive —
  //    zai.json fully shadows claude.json so users on a shared box can't leak
  //    MCP servers across tools.
  const home = homedir()
  const userLoads: ScopeLoadResult[] = []
  const zaiJsonPath = join(home, '.zai.json')
  const claudeJsonPath = join(home, '.claude.json')
  let userPath: string | null = null
  if (existsSync(zaiJsonPath)) {
    userPath = zaiJsonPath
  } else if (existsSync(claudeJsonPath)) {
    userPath = claudeJsonPath
  }
  if (userPath) {
    const parsed = parseFile(userPath)
    if (parsed) {
      userLoads.push(ingest(parsed, 'user', userPath))
    }
  }

  // 4. enterprise: explicit env var, then XDG, then /etc.
  //    If present, it takes exclusive control: drop everything else.
  //    `disabledMcpServers` does NOT filter enterprise — admins want their
  //    managed config honored regardless of user-side toggle state.
  const enterprisePath = resolveEnterpriseMcpPath()
  const enterpriseParsed = enterprisePath ? parseFile(enterprisePath) : null
  if (enterpriseParsed && enterpriseParsed.servers.length > 0) {
    return enterpriseParsed.servers.map((s) =>
      s.roots ? s : { ...s, roots: [cwd] }
    )
  }

  // Apply global disabledMcpServers filter (post-merge).
  for (const name of globalDisabled) byName.delete(name)

  return Array.from(byName.values()).map((v) =>
    v.spec.roots ? v.spec : { ...v.spec, roots: [cwd] }
  )
}

/**
 * Returns the ordered list of sources actually consulted, with whether
 * each one contributed any servers. Useful for `/mcp` debug UI and for
 * the "did we read ~/.zai.json" diagnostic.
 */
export function describeMcpSources(cwd: string): ScopeLoadResult[] {
  const out: ScopeLoadResult[] = []
  // project
  let cur = cwd
  const dirs: string[] = []
  while (true) {
    dirs.push(cur)
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  for (const dir of dirs.reverse()) {
    const path = join(dir, '.mcp.json')
    out.push({ scope: 'project', source: path, servers: parseFile(path)?.servers ?? [] })
  }
  // local
  for (const p of [join(cwd, '.claude', 'settings.local.json'),
                   join(homedir(), '.claude', 'settings.local.json')]) {
    out.push({ scope: 'local', source: p, servers: parseFile(p)?.servers ?? [] })
  }
  // user
  const zj = join(homedir(), '.zai.json')
  const cj = join(homedir(), '.claude.json')
  const userSource = existsSync(zj) ? zj : existsSync(cj) ? cj : zj
  out.push({
    scope: 'user',
    source: userSource,
    servers: parseFile(userSource)?.servers ?? [],
  })
  // enterprise
  const ent = resolveEnterpriseMcpPath()
  if (ent) {
    out.push({ scope: 'enterprise', source: ent, servers: parseFile(ent)?.servers ?? [] })
  }
  return out
}

function resolveEnterpriseMcpPath(): string | null {
  if (process.env.ZAI_MANAGED_MCP_CONFIG) {
    return existsSync(process.env.ZAI_MANAGED_MCP_CONFIG)
      ? process.env.ZAI_MANAGED_MCP_CONFIG
      : null
  }
  const xdg = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, 'zai', 'managed-mcp.json')
    : join(homedir(), '.config', 'zai', 'managed-mcp.json')
  if (existsSync(xdg)) return xdg
  const system = '/etc/zai/managed-mcp.json'
  if (existsSync(system)) return system
  return null
}

function parseFile(path: string): ParsedMcpFile | null {
  if (!existsSync(path)) return null
  let stat
  try {
    stat = statSync(path)
  } catch {
    return null
  }
  if (!stat.isFile()) return null
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return null
  }
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  // Tolerate a top-level object with `mcpServers` OR a bare `mcpServers` object.
  const serversObj =
    parsed.mcpServers ??
    (!parsed.mcpServers && typeof parsed === 'object' ? parsed : null)
  const servers: McpServerSpec[] = []
  if (serversObj && typeof serversObj === 'object') {
    for (const [name, def] of Object.entries(serversObj)) {
      const spec = parseOne(name, def as McpJsonServer)
      if (spec) servers.push(spec)
    }
  }

  return {
    servers,
    enabledMcpjsonServers: toStringArrayOrNull(parsed.enabledMcpjsonServers),
    disabledMcpjsonServers: toStringArrayOrNull(parsed.disabledMcpjsonServers),
    disabledMcpServers: toStringArrayOrNull(parsed.disabledMcpServers),
  }
}

/**
 * Coerce a JSON-decoded value to a string array, or null if the field
 * is absent / not an array. `null` is the sentinel callers use to
 * distinguish "not configured" (skip filter) from "configured but empty"
 * (allowlist with 0 entries → nothing loads).
 */
function toStringArrayOrNull(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  return v.filter((x): x is string => typeof x === 'string')
}

function parseOne(name: string, def: McpJsonServer): McpServerSpec | null {
  if (!def || typeof def !== 'object') return null
  if (def.command) {
    return {
      name,
      transport: {
        kind: 'stdio',
        command: def.command,
        ...(def.args ? { args: def.args } : {}),
        ...(def.env ? { env: def.env } : {}),
      },
      ...(def.bearerEnvVar
        ? { auth: { bearerEnvVar: def.bearerEnvVar } }
        : def.headerEnvVars
        ? { auth: { headerEnvVars: def.headerEnvVars } }
        : {}),
    }
  }
  if (def.url) {
    const kind = def.type === 'sse' ? 'sse' : 'http'
    return {
      name,
      transport: {
        kind,
        url: def.url,
        ...(def.headers ? { headers: def.headers } : {}),
      },
    }
  }
  return null
}

/**
 * Build a default sandbox config. Honors:
 *   - ZAI_SANDBOX=off → undefined (BashTool refuses to run)
 *   - ZAI_SANDBOX_ENV_ALLOWLIST → restrict env passthrough
 *   - ZAI_SANDBOX_TIMEOUT_MS → cap foreground command wall time
 */
export function defaultSandbox(cwd: string): {
  executor: 'child_process'
  workdir: string
  envAllowlist?: string[]
  maxCpuMs?: number
  networkEgress: 'allow'
} | undefined {
  if (process.env.ZAI_SANDBOX === 'off') return undefined
  const envAllowlist = process.env.ZAI_SANDBOX_ENV_ALLOWLIST
    ? process.env.ZAI_SANDBOX_ENV_ALLOWLIST.split(',').map(s => s.trim()).filter(Boolean)
    : undefined
  const maxCpuMs = process.env.ZAI_SANDBOX_TIMEOUT_MS
    ? parseInt(process.env.ZAI_SANDBOX_TIMEOUT_MS, 10)
    : undefined
  return {
    executor: 'child_process',
    workdir: cwd,
    networkEgress: 'allow',
    ...(envAllowlist ? { envAllowlist } : {}),
    ...(maxCpuMs ? { maxCpuMs } : {}),
  }
}