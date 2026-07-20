/**
 * Streaming tool execution — public contract (frozen by spec §2.1).
 *
 * Spec: docs/superpowers/specs/2026-07-19-zai-loop-resilience-b-streaming-tools-design.md
 *
 * `createStreamingToolExecutor` lets the queryLoop dispatch tool_use blocks to a
 * bounded-concurrency pool as soon as each block closes (vs. waiting for the
 * full message to land). It yields `runtime.tool_call` and `runtime.tool_result`
 * events compatible with the existing SSE pipeline.
 *
 * Implementation details (queue vs. semaphore vs. rxjs) are intentionally
 * free per spec §7 — only the contract below is locked.
 */
import type { ToolResult } from '../../opencc-internals/Tool.js'

// `ToolResult<T>` is generic; we re-export it but keep our internal execute
// signature accepting `unknown` so callers can pass through untyped legacy
// results without forcing them to instantiate T. The streaming executor
// only reads `.data` (legacy alias `.content`/`.output`) and `.isError` at
// runtime — same coercion that the existing toolExecution.ts path does.
export type { ToolResult }

/**
 * A single tool_use block as captured at content_block_stop.
 *
 * `input` is the fully-closed JSON object (already parsed upstream). Spec §6.2:
 * streaming may submit only "closed" tool_use; duck-typed — no further parsing
 * here.
 */
export type StreamingToolUse = {
  id: string
  name: string
  input: unknown
}

/** Per-tool registry entry. `execute` mirrors toolExecution.ts's contract. */
export type StreamingTool = {
  name: string
  /**
   * Mirror of toolExecution.ts's per-tool execute step. Takes the parsed input
   * and returns a ToolResult. Must NOT throw — failures should be encoded via
   * `ToolResult.isError = true`. Spec §3.4: executor still yields
   * `runtime.tool_result { ok:false }` even when `execute` throws, but tools
   * that already wrap their errors as ToolResult keep the streaming path
   * simpler.
   */
  execute: (input: unknown) => Promise<ToolResult<unknown>>
}

/** Per-call result returned by `drain()`. Order = completion order, not submit order. */
export type StreamingToolResult = {
  toolUseId: string
  toolName: string
  ok: boolean
  output: string
}

/** Event payload emitted by the executor. Spec §2.2. */
export type ParallelToolEvent =
  | {
      type: 'runtime.tool_call'
      toolUseId: string
      toolName: string
      input: unknown
      sessionId: string
      parallel: true
    }
  | {
      type: 'runtime.tool_result'
      toolUseId: string
      toolName: string
      ok: boolean
      output: string
      sessionId: string
    }

/** Constructor options. `maxParallel` defaults to 4 per spec §2.1. */
export type StreamingToolExecutorOptions = {
  tools: StreamingTool[]
  /**
   * Optional executor override. When provided, takes precedence over the
   * matching `tools` entry. Kept distinct from `tools[].execute` so callers can
   * pass a "raw" registry without writing a wrapper.
   */
  execute?: (toolName: string, input: unknown) => Promise<ToolResult<unknown>>
  /**
   * Maximum concurrent in-flight tool executions. Spec §2.1 default: 4.
   * Spec §6.3: ≤0 falls back to 1 defensively.
   */
  maxParallel?: number
  /** Caller-controlled abort; abort stops accepting new submits (spec §3 #9). */
  signal: AbortSignal
  /** Session id stamped onto every emitted event. */
  sessionId: string
}

/** Imperative handle returned by `createStreamingToolExecutor`. */
export type StreamingToolExecutorHandle = {
  /** Enqueue a closed tool_use. Non-blocking. */
  submit(toolUse: StreamingToolUse): void
  /** Resolves once every submit()'d tool has produced a result (or after cancel/abort). */
  drain(): Promise<StreamingToolResult[]>
  /** Stop accepting new submits; in-flight work still drains. Spec §2.4 / §3 #6. */
  cancel(): void
  /** Async iterator over emitted events. Lazily pulled by the caller. */
  events(): AsyncGenerator<ParallelToolEvent, void, void>
}

/** Defensive default for `maxParallel` when caller passes 0 / negative. */
export const DEFAULT_MAX_PARALLEL = 4
