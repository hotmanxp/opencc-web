/**
 * Build-time globals replaced by the bundler at build time.
 *
 * `scripts/build.ts` substitutes these via Bun's `define` option, so at
 * runtime the references are inlined as string literals. This declaration
 * exists only to make `tsc --noEmit` aware of them — without it, every
 * `MACRO.*` access fires TS2304 "Cannot find name 'MACRO'".
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

/**
 * Stub for resolveAntModel - appears to be a build-time resolved constant
 */
declare const resolveAntModel: string

/**
 * PromiseWithResolvers is a ES2023 proposal type that TypeScript 5.2+ includes,
 * but we need to declare it here for older lib configurations.
 */
interface PromiseWithResolvers<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

declare module 'qrcode' {
  export function toString(data: string, options?: object): Promise<string>
  BUILD_TIME: string
  ISSUES_EXPLAINER: string
  FEEDBACK_CHANNEL: string
  PACKAGE_URL: string
  NATIVE_PACKAGE_URL: string | undefined
  VERSION_CHANGELOG: string | undefined
}

declare module '*.md' {
  const content: string
  export default content
}
