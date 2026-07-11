const MCP_PREFIX = 'mcp__'

export function makeMcpToolName(serverName: string, toolName: string): string {
  return `${MCP_PREFIX}${serverName}__${toolName}`
}

export function parseMcpToolName(
  name: string
): { serverName: string; originalName: string } | null {
  if (!name.startsWith(MCP_PREFIX)) return null
  const rest = name.slice(MCP_PREFIX.length)
  const sep = rest.indexOf('__')
  if (sep < 0) return null
  return {
    serverName: rest.slice(0, sep),
    originalName: rest.slice(sep + 2),
  }
}