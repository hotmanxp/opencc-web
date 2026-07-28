declare module '@anthropic-ai/mcpb' {
  export interface MCPBClient {
    join(...args: unknown[]): unknown
  }

  export interface McpbManifest {
    // Define manifest properties as needed
    [key: string]: unknown
  }

  export const McpbManifestSchema: {
    safeParse: (obj: unknown) => { success: boolean; error?: { flatten: () => { fieldErrors: Record<string, string[]>; formErrors: string[] } } }
  }

  export function createClient(config?: unknown): MCPBClient
}
