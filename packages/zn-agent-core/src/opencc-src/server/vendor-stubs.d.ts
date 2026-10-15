/**
 * Ambient module declarations for the opencc vendor tree.
 *
 * tsconfig.server.json only includes the 6 server/* files, but tsc
 * still typechecks their transitive imports across `src/opencc-src/**`.
 * tsconfig.typecheck.json widens that further: it puts the whole vendor
 * tree in the root file set, so dead CLI / gRPC / LSP paths are checked
 * too (and need their own stubs).
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
 * Last reviewed: 2026-10-04 (zai patch — 覆盖 tsconfig.typecheck.json
 * 把整个 vendor 树纳入 root file set 后的新增 TS2307)。
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

// ── zai 裁剪掉的 opencc 入口路径(zai patch 2026-10-04)───────────────
// 以下 4 个包 zai 既没安装、也不在 esbuild 产物里(已核 `grep -c` 于
// dist/opencc-core.mjs 全部为 0),它们只被 opencc 的 CLI / gRPC server /
// LSP 集成路径引用 —— 这三条路径 zai 整个砍掉了(headless runtime 只走
// createOpenccRuntime)。tsconfig.typecheck.json 把整个 src/opencc-src 纳入
// root file set 后,这些静态 import 会以 TS2307 暴露出来。
//
// 为什么用 ambient 声明而不是装包:装进来等于为 zai 从不执行的代码路径
// 引入 4 棵依赖树(opencc CLI 的 commander 扩展、gRPC 的 2 个包、LSP 的
// protocol 包),而它们的运行时入口在 bundle 里根本不存在。声明为 `any`
// 与本文件其余条目的处理一致。

declare module '@commander-js/extra-typings' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type OptionValues = any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Command = any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const Command: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Argument = any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const Argument: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Option = any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const Option: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export class InvalidArgumentError extends Error {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type OptionValueSource = any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type ArgumentValueSource = any
}

declare module '@grpc/grpc-js' {
  // 声明成 class 而不是 const:`grpc.Server` 在 grpc/server.ts:87 既当值
  // (new grpc.Server()) 又当类型 (`typeof grpc.Server` / `grpc.ServerDuplexStream`),
  // `export const Server: any` 会让类型位置报 TS2749。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export class Server {
    constructor(...args: any[])
    addService(...args: any[]): void
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bindAsync(...args: any[]): any
    start(...args: any[]): void
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    forceShutdown(...args: any[]): any
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export interface ServerDuplexStream<Req = any, Res = any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, cb: (...args: any[]) => void): this
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    write(chunk: any): any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    end(...args: any[]): any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    metadata: any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendMetadata(...args: any[]): any
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const ServerCredentials: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const status: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const Metadata: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const loadPackageDefinition: any
}

declare module '@grpc/proto-loader' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const loadSync: any
}

declare module 'vscode-languageserver-protocol' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type InitializeParams = any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type InitializeResult = any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type ServerCapabilities = any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type TextDocumentPositionParams = any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type DefinitionParams = any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type ReferenceParams = any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type HoverParams = any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type PublishDiagnosticsParams = any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const TextDocumentSyncKind: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const DiagnosticSeverity: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const CompletionItemKind: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const SymbolKind: any
}
