// @ts-nocheck — zai-local stub for upstream opencc's utils/bufferedWriter.ts.
// Upstream is excluded from the opencc-internals cherry-pick mirror (see
// packages/zai-agent-core/scripts/sync-from-opencc.ts). Minimal exports
// needed by debug.ts → openaiClient.ts → shim runtime load chain. If a
// future task needs richer behaviour, extend THIS file rather than
// pulling upstream. Listed in HARD_EXCLUDE_FILES.

export interface BufferedWriter {
  write(content: string): void
  flush(): void
  dispose(): void
}

export interface BufferedWriterOptions {
  writeFn: (content: string) => void
  flushIntervalMs?: number
  maxBufferSize?: number
  immediateMode?: boolean
}

export function createBufferedWriter(_options: BufferedWriterOptions): BufferedWriter {
  return {
    write(_content: string) {
      // no-op: debug logs are irrelevant in this stub
    },
    flush() {
      // no-op
    },
    dispose() {
      // no-op
    },
  }
}
