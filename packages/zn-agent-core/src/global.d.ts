/**
 * Ambient declarations for the main `tsc -b` type-check pass.
 *
 * `MACRO` — opencc's build-time macro substitution, normally injected
 * via `bun --define MACRO=...` and pre-populated at runtime by
 * `installMacroStub()` (see `compat/runtime/bun-shim.ts`). The
 * canonical type declaration lives in `src/opencc-src/global.d.ts`,
 * but `tsconfig.json` excludes `src/opencc-src/` — so that declaration
 * is invisible to the main project's ambient scope. tsc still walks
 * the transitive vendor type graph (composite: false disables the
 * "all referenced files must be in the project file list" enforcement
 * but does not stop tsc from following imports), and every `MACRO.X`
 * reference in those excluded-but-followed vendor files surfaces as
 * TS2304 "Cannot find name 'MACRO'".
 *
 * Mirroring the declaration here puts MACRO in the main project's
 * ambient scope. Field set mirrors `src/opencc-src/global.d.ts` (the
 * canonical source). When the vendor adds new MACRO.* keys, sync both
 * files. Keeping two in sync is intentional — see the comment in
 * `opencc-src/server/server-globals.d.ts`: the main tsc and the
 * server tsc each need their own ambient copy because they live in
 * disjoint project scopes.
 *
 * `resolveAntModel` — same pattern, used by stripped vendor code.
 */
declare const MACRO: {
  VERSION: string
  DISPLAY_VERSION: string
  BUILD_TIME?: string
  ISSUES_EXPLAINER?: string
  PACKAGE_URL: string
  NATIVE_PACKAGE_URL?: string
  VERSION_CHANGELOG?: string
  FEEDBACK_CHANNEL?: string
  IS_DEVELOPMENT_BUILD?: string
}

declare const resolveAntModel: string

/**
 * Ambient module declarations for packages that `scripts/bundle-opencc.ts`'s
 * `optionalStubPlugin` stubs out at runtime (the runtime value is `null` /
 * a no-op proxy — see `bundle-opencc.ts` OPTIONAL_STUB_BARE_MODULES +
 * STUB_EXPORTS). Vendor code statically imports these, and tsc walks the
 * transitive type graph even for excluded files (composite: false doesn't
 * stop the walk; only the "all files must be in project" enforcement).
 *
 * The matching set in OPTIONAL_STUB_BARE_MODULES is the authoritative
 * runtime stub list; this file is its type-level mirror. Keep in sync
 * if the bundle plugin adds a new bare stub or removes one.
 */
declare module 'vscode-jsonrpc'
declare module 'vscode-jsonrpc/node'
/**
 * The vendor `LSPClient` does a static named import of
 * `{ createMessageConnection, MessageConnection, StreamMessageReader,
 *   StreamMessageWriter, Trace }` from `'vscode-jsonrpc/node.js'` —
 * no `@ts-expect-error` guard. Declaring the symbols below (as `any`)
 * satisfies the import without dragging in the full `vscode-jsonrpc`
 * .d.ts graph (which itself imports `vscode-jsonrpc/node` etc. and
 * creates a chain we don't want in the type surface). Runtime value is
 * stubbed by `optionalStubPlugin` (zai never runs an LSP client).
 */
declare module 'vscode-jsonrpc/node.js' {
  export function createMessageConnection(...args: any[]): any
  export type MessageConnection = any
  export const StreamMessageReader: any
  export const StreamMessageWriter: any
  export const Trace: any
}
/**
 * Vendor statically imports the LSP protocol types listed below.
 * Declared as `any` so the named imports type-check; runtime LSP path
 * is stubbed by `optionalStubPlugin`.
 */
declare module 'vscode-languageserver-protocol' {
  export type ServerCapabilities = any
  export type InitializeParams = any
  export type InitializeResult = any
  export type PublishDiagnosticsParams = any
}
/**
 * Vendor's LSPTool/formatters.ts imports LSP data types from
 * `vscode-languageserver-types`. Declared as `any` to satisfy the
 * named imports without bringing the full type graph into the project.
 */
declare module 'vscode-languageserver-types' {
  export type CallHierarchyIncomingCall = any
  export type CallHierarchyItem = any
  export type CallHierarchyOutgoingCall = any
  export type DocumentSymbol = any
  export type Hover = any
  export type Location = any
  export type LocationLink = any
  export type MarkedString = any
  export type MarkupContent = any
  export type SymbolInformation = any
  export type SymbolKind = any
}
declare module '@ant/claude-for-chrome-mcp'
declare module '@mendable/firecrawl-js'
declare module 'turndown'
/**
 * Vendor's `utils/cliHighlight.ts` does `typeof import('cli-highlight')`
 * for both `highlight` (function) and `supportsLanguage` (function).
 * No `@ts-ignore` — declarations below match the vendor usage.
 */
declare module 'cli-highlight' {
  export function highlight(...args: any[]): any
  export function supportsLanguage(...args: any[]): boolean
}
/**
 * Vendor's `tools/WebSearchTool/providers/duckduckgo.ts` does
 * `typeof import('duck-duck-scrape').search` and `.SafeSearchType`.
 * `SafeSearchType` is used as a type; `search` as a function value.
 */
declare module 'duck-duck-scrape' {
  export function search(...args: any[]): Promise<any>
  // Vendor does `typeof import('duck-duck-scrape').SafeSearchType` —
  // `typeof` operates on values (not types), so declare as a const
  // (which the actual package exports as an enum-like object).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const SafeSearchType: any
}
/**
 * Vendor's `utils/computerUse/{gates,hostAdapter,inputLoader}.ts` use
 *   `// @ts-ignore\nimport type { ... } from '@ant/computer-use-mcp/types'`
 * Declaring the types below makes the named imports resolve cleanly.
 * The `// @ts-ignore` then becomes unused (TS2579) — a 1-line noise
 * error per import site, accepted as the cost of avoiding a deeper
 * stub layer. The runtime path is reached only via
 * `new Function('return import(...)')` (opencc's optional/lazy pattern),
 * so the package is never actually loaded by zai.
 */
declare module '@ant/computer-use-mcp/types' {
  export type CoordinateMode = any
  export type CuSubGates = any
  export type ComputerUseHostAdapter = any
  export type Logger = any
}
declare module '@ant/computer-use-input' {
  export type ComputerUseInputAPI = any
  export type ComputerUseInput = any
}
/**
 * Vendor's `services/analytics/growthbook.ts` uses
 *   `import(/* @ts-expect-error *\/ '@growthbook/growthbook')`
 * wrapped in a cast to a local `GrowthBookModule` type. **We intentionally
 * do NOT declare `@growthbook/growthbook` here** — declaring it (even
 * with no exports) makes the dynamic import resolve cleanly, which would
 * make the `@ts-expect-error` directive unused (TS2578). Leaving it
 * undeclared keeps TS2307 "Cannot find module" firing, which the
 * `@ts-expect-error` legitimately suppresses. The directive is correct
 * as long as the package is genuinely optional (it is — see
 * `OPTIONAL_STUB_BARE_MODULES` in `bundle-opencc.ts`).
 */
declare module '@anthropic-ai/mcpb' {
  // Vendor uses `McpbManifest` (TS2724) and casts the dynamic import to
  // a `{ McpbManifestSchema: { safeParse(...) } }` shape (TS2352). zai
  // never statically imports this module; runtime reaches it via
  // `createRequire` at the call site. `McpbManifest` is declared as
  // `any` (not `unknown`) so chained property access in vendor code
  // (`result.data.manifest`) does not surface TS18046.
  export const McpbManifestSchema: { safeParse(input: unknown): unknown }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type McpbManifest = any
}