/**
 * Ambient module declarations for the opencc vendor tree.
 *
 * tsconfig.server.json only includes the 6 server/* files, but tsc
 * still typechecks their transitive imports across `src/opencc-src/**`.
 * The vendor tree was copied verbatim from upstream opencc and expects
 * a handful of npm packages that we either don't ship (Ant-only stubs)
 * or never wired up in our narrower type surface.
 *
 * This file lives under `src/opencc-src/server/` so it's picked up
 * by the `include` list once added. Each declaration below resolves
 * a `Cannot find module` error that was surfacing in the tsc -p
 * tsconfig.server.json pass.
 *
 * SCOPE: Only declare modules that genuinely don't ship types.
 * Do NOT augment react / highlight.js / lodash here — those packages
 * have proper type definitions that just need to be installed as
 * direct dependencies (@types/lodash, @types/react, etc.).
 *
 * Last reviewed: 2026-08-16 (zai patch).
 */

// ── npm deps without published types (truly untyped) ──

declare module 'duck-duck-scrape' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const search: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const DDGResults: any
  export const SafeSearchType: {
    STRICT: string
    MODERATE: string
    OFF: string
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _default: any
  export default _default
}

declare module 'cli-highlight' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const highlight: (input: string, opts?: any) => string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const theme: any
  export function supportsLanguage(language: string): boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _default: any
  export default _default
}

// ── npm deps we don't install (stub-only, runtime never reaches them) ──
// These were added when the original vendor had these as runtime deps;
// zai doesn't depend on them but tsc still sees the static imports
// from the vendored source. The bundle script's `optionalStubPlugin`
// stubs them at runtime (see scripts/bundle-opencc.ts:381-397).

declare module '@ant/claude-for-chrome-mcp' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const BROWSER_TOOLS: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const createClaudeForChromeMcpServer: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const ClaudeForChromeContext: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const Logger: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const PermissionMode: any
}

declare module '@ant/computer-use-mcp/types' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type ComputerUseHostAdapter = any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Logger = any
}

declare module '@ant/computer-use-input' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type ComputerUseInput = any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type ComputerUseInputAPI = any
}

declare module '@anthropic-ai/mcpb' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type McpbManifest = any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type McpbUserConfigurationOption = any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const McpbManifestSchema: any
}

// ── npm deps whose types are too heavy to install for the server typecheck ──
// The vendored server surface only reaches these via `import type` /
// dynamic `await import(...)` in dead or stub-wired code paths. Ambient
// `any` declarations keep the tsconfig.server.json pass clean without
// pulling in the real packages. The bundle script's `optionalStubPlugin`
// stubs their runtime imports (see scripts/bundle-opencc.ts:381-397).

declare module 'vscode-languageserver-types' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type DocumentSymbol = any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Hover = any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Location = any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type LocationLink = any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type SymbolInformation = any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type SymbolKind = any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type MarkedString = any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type MarkupContent = any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type CallHierarchyItem = any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type CallHierarchyIncomingCall = any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type CallHierarchyOutgoingCall = any
}

declare module 'vscode-jsonrpc/node.js' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function createMessageConnection(...args: any[]): any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type MessageConnection = any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export class StreamMessageReader {
    constructor(...args: any[])
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export class StreamMessageWriter {
    constructor(...args: any[])
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const Trace: any
}

declare module '@mendable/firecrawl-js' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export class FirecrawlClient {
    constructor(...args: any[])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scrape(url: string, options?: any): Promise<any>
  }
}

declare module 'google-auth-library' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const GoogleAuth: any
}
