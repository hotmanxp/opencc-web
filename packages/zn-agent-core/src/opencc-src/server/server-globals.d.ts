/**
 * Ambient type declarations for the server public surface.
 *
 * The server module (`src/opencc-src/server/`) and its only runtime
 * sibling (`createHeadlessContext.ts`) reach into vendored opencc-src
 * modules whose types reference ambient globals that don't exist in
 * the server emit graph:
 *
 *   - `MACRO` — opencc's build-time macro substitution is normally
 *     injected via `bun --define MACRO=...`. We pre-populate
 *     `globalThis.MACRO` at runtime via `installMacroStub()` (compat
 *     shim). The type declaration here mirrors that shape so the
 *     vendored files' `MACRO.X` references don't error during
 *     `tsc -p tsconfig.server.json` declaration emit.
 *
 *   - `@anthropic-ai/mcpb` — vendored at v2.1.2 but `McpbManifestSchema`
 *     lives behind the v2 surface. Declared here as `unknown` so
 *     `utils/dxt/helpers.ts:16` (which references it) type-checks
 *     without dragging the v2 types into the server emit graph.
 *
 * This file is included by tsconfig.server.json's `include` list so
 * the declarations are in scope for the server emit but NOT for the
 * main `tsc -b` (which already handles MACRO via its own globals.d.ts).
 */

declare const MACRO: {
  readonly VERSION: string
  readonly DISPLAY_VERSION: string
  readonly BUILD_TIME: string
  readonly IS_DEVELOPMENT_BUILD: boolean
  readonly PACKAGE_URL: string
  readonly NATIVE_PACKAGE_URL: string | undefined
  readonly ISSUES_EXPLAINER: string
  readonly FEEDBACK_CHANNEL: string
  readonly VERSION_CHANGELOG: string
}

declare module '@anthropic-ai/mcpb' {
  // Vendored mcpb v2 surface — opencc's utils/dxt/helpers.ts imports
  // `McpbManifestSchema` from it. We don't emit the full mcpb types
  // (they're an excluded dep on the server surface); an `unknown`
  // schema keeps the import legal without exposing internals.
  export const McpbManifestSchema: unknown
}