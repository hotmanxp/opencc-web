/**
 * Public facade — runtime/streaming.
 *
 * Spec: docs/superpowers/specs/2026-07-19-zai-loop-resilience-b-streaming-tools-design.md
 *
 * Wire-in entry point used by `runtime/toolExecution.ts` to swap the serial
 * scheduling loop for a bounded-concurrency parallel pool.
 */
export { createStreamingToolExecutor } from './streamingToolExecutor.js'
export type {
  ParallelToolEvent,
  StreamingTool,
  StreamingToolExecutorHandle,
  StreamingToolExecutorOptions,
  StreamingToolResult,
  StreamingToolUse,
} from './types.js'
export { DEFAULT_MAX_PARALLEL } from './types.js'
