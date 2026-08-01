// Bun ambient declarations for code that runs under both `tsc` and `bun`.
// `import.meta.main` is a Bun-specific feature; declare it here so `tsc -b`
// doesn't error when a CLI entrypoint gates on it.

declare global {
  interface ImportMeta {
    /** True when this module is the program entrypoint (Bun). */
    readonly main: boolean
  }
}

export {}
