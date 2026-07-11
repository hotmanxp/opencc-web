// @ts-nocheck -- this module bridges opencc-internals McpServerSpec types from
// zai-agent-core with the .mcp.json wire format. The McpServerSpec variants
// differ between zod v3 (zai-agent-core) and zod/v4 (opencc-internals), so
// we keep the boundary type-checked at runtime only.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
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

/**
 * Read `cwd/.mcp.json` and return a list of McpServerSpec entries.
 * Missing file or empty `mcpServers` returns [] — never throws.
 */
export function loadMcpServers(cwd: string): McpServerSpec[] {
  const path = join(cwd, '.mcp.json')
  if (!existsSync(path)) return []
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return []
  }
  let parsed: McpJsonFile
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const servers = parsed.mcpServers ?? {}
  const out: McpServerSpec[] = []
  for (const [name, def] of Object.entries(servers)) {
    const spec = parseOne(name, def)
    if (spec) out.push(spec)
  }
  return out
}

function parseOne(name: string, def: McpJsonServer): McpServerSpec | null {
  // stdio form: {command, args, env}
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
  // HTTP / SSE form: {url, type?: 'sse' | 'http'}
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