export type McpServerSpec = {
  name: string
  transport:
    | { kind: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
    | { kind: 'sse'; url: string; headers?: Record<string, string> }
    | { kind: 'http'; url: string; headers?: Record<string, string> }
  auth?: {
    bearerEnvVar?: string
    headerEnvVars?: Record<string, string>
  }
  reconnect?: { maxRetries?: number; backoffMs?: number }
  callTimeoutMs?: number
}
