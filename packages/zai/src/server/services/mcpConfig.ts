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

  // Helper: merge a scope's results into the running map. Higher-scope
  // sources write last so they win on name collision.
  const apply = (entries: ScopeLoadResult[]) => {
    for (const e of entries) {
      for (const spec of e.servers) {
        byName.set(spec.name, { spec, scope: e.scope })
      }
    }
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
      projectLoads.push({ scope: 'project', source: path, servers: parsed })
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
    const parsed = parseFile(p, 'mcpServers')
    if (parsed) {
      localLoads.push({ scope: 'local', source: p, servers: parsed })
    }
  }

  // 3. user: $HOME/.zai.json (zai-specific) if present, else fall back to
  //    $HOME/.claude.json (claude code / opencc compat). Mutually exclusive —
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
    const parsed = parseFile(userPath, 'mcpServers')
    if (parsed) {
      userLoads.push({ scope: 'user', source: userPath, servers: parsed })
    }
  }

  // 4. enterprise: explicit env var, then XDG, then /etc.
  //    If present, it takes exclusive control: drop everything else.
  const enterprisePath = resolveEnterpriseMcpPath()
  const enterpriseParsed = enterprisePath ? parseFile(enterprisePath, 'mcpServers') : null
  if (enterpriseParsed && enterpriseParsed.length > 0) {
    return enterpriseParsed
  }

  // Merge in precedence order (lowest first, highest last).
  apply(projectLoads)
  apply(localLoads)
  apply(userLoads)

  return Array.from(byName.values()).map(v => v.spec)
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
    const servers = parseFile(path) ?? []
    out.push({ scope: 'project', source: path, servers })
  }
  // local
  for (const p of [join(cwd, '.claude', 'settings.local.json'),
                   join(homedir(), '.claude', 'settings.local.json')]) {
    out.push({ scope: 'local', source: p, servers: parseFile(p, 'mcpServers') ?? [] })
  }
  // user
  const zj = join(homedir(), '.zai.json')
  const cj = join(homedir(), '.claude.json')
  const userSource = existsSync(zj) ? zj : existsSync(cj) ? cj : zj
  out.push({
    scope: 'user',
    source: userSource,
    servers: parseFile(userSource, 'mcpServers') ?? [],
  })
  // enterprise
  const ent = resolveEnterpriseMcpPath()
  if (ent) {
    out.push({ scope: 'enterprise', source: ent, servers: parseFile(ent, 'mcpServers') ?? [] })
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

function parseFile(path: string, mcpKey: 'mcpServers' = 'mcpServers'): McpServerSpec[] | null {
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
  // Tolerate a top-level object with `mcpServers` OR a bare `mcpServers` object.
  const servers = parsed?.[mcpKey] ?? (parsed && typeof parsed === 'object' && !parsed[mcpKey] ? parsed : null)
  if (!servers || typeof servers !== 'object') return null
  const out: McpServerSpec[] = []
  for (const [name, def] of Object.entries(servers)) {
    const spec = parseOne(name, def as McpJsonServer)
    if (spec) out.push(spec)
  }
  return out
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