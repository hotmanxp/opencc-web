export type McpServerErrorContext = {
  serverName: string
  retryable: boolean
  originalError?: unknown
}

export class McpServerError extends Error {
  readonly serverName: string
  readonly retryable: boolean
  readonly originalError: unknown

  constructor(message: string, ctx: McpServerErrorContext) {
    super(message)
    this.name = 'McpServerError'
    this.serverName = ctx.serverName
    this.retryable = ctx.retryable
    this.originalError = ctx.originalError
  }
}

export function formatMcpError(err: unknown, serverName: string): string {
  if (err instanceof McpServerError) return `${err.message} (server: ${err.serverName})`
  if (err instanceof Error) return `MCP tool call failed: ${err.message}`
  return `MCP tool call failed: ${String(err)} (server: ${serverName})`
}