import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServerSpec } from './types.js'

export function injectAuth(spec: McpServerSpec): McpServerSpec {
  const resolved: McpServerSpec = structuredClone(spec)

  // Build the resolved-headers map (only meaningful for non-stdio transports)
  const resolvedHeaders: Record<string, string> = {}
  if (resolved.transport.kind !== 'stdio') {
    Object.assign(resolvedHeaders, resolved.transport.headers ?? {})
  }

  if (resolved.auth?.bearerEnvVar) {
    const tok = process.env[resolved.auth.bearerEnvVar]
    if (tok) resolvedHeaders.Authorization = `Bearer ${tok}`
  }
  for (const [header, envVar] of Object.entries(resolved.auth?.headerEnvVars ?? {})) {
    const v = process.env[envVar]
    if (v) resolvedHeaders[header] = v
  }

  if (resolved.transport.kind === 'stdio') {
    // Headers live in the stdio env block instead.
    resolved.transport = {
      ...resolved.transport,
      env: { ...resolved.transport.env, ...resolvedHeaders },
    }
  } else {
    resolved.transport = { ...resolved.transport, headers: resolvedHeaders }
  }
  return resolved
}

export function createMcpTransport(spec: McpServerSpec, signal: AbortSignal) {
  const resolved = injectAuth(spec)

  if (resolved.transport.kind === 'stdio') {
    return new StdioClientTransport({
      command: resolved.transport.command,
      args: resolved.transport.args,
      env: resolved.transport.env,
    })
  }

  if (resolved.transport.kind === 'sse' || resolved.transport.url.endsWith('/sse')) {
    return new SSEClientTransport(new URL(resolved.transport.url), {
      requestInit: { headers: resolved.transport.headers, signal },
    })
  }

  return new StreamableHTTPClientTransport(new URL(resolved.transport.url), {
    requestInit: { headers: resolved.transport.headers, signal },
  })
}