import type { TranscriptMessage } from '../../transcript/types.js'
import type { TranscriptStore } from '../../transcript/store.js'
import type { ModelCaller } from '../types.js'

export type CompactTrigger =
  | 'auto'
  | 'manual'
  | 'reactive-ptl'
  | 'reactive-media'
  | 'reactive-max-tokens'

export type ForceReason = 'memory-pressure' | 'message-count'

export interface AutoCompactTrackingState {
  compacted: boolean
  turnCounter: number
  turnId: string
  consecutiveFailures?: number
  nextRetryAtMs?: number
  lastFailureAtMs?: number
  forceReason?: ForceReason
}

export type CircuitBreakerAction =
  | { action: 'allow'; effectiveConsecutiveFailures: number; wasHalfOpen: boolean }
  | { action: 'skip'; consecutiveFailures: number; nextRetryAtMs: number; circuitBreakerActive: true }

// CompactionResult 占位 — 完整定义在 Task 10 实现
export interface CompactionResult {
  boundaryMarker: TranscriptMessage
  summaryMessages: TranscriptMessage[]
  attachments: TranscriptMessage[]
  hookResults: TranscriptMessage[]
  messagesToKeep?: TranscriptMessage[]
  preCompactTokenCount?: number
  postCompactTokenCount?: number
  compactionUsage?: { input_tokens?: number; output_tokens?: number }
}

// 旧接口 — 保持 runtime/compactService 旧 contract
export interface CompactSessionOptions {
  store: TranscriptStore
  sessionId: string
  modelCaller: ModelCaller
  cwd: string
  model?: string
}

export type CompactSessionResult =
  | { kind: 'compacted'; summary: string; newMessages: TranscriptMessage[] }
  | { kind: 'error'; message: string }

export interface TokenWarningState {
  percentLeft: number
  isAboveWarningThreshold: boolean
  isAboveErrorThreshold: boolean
  isAboveAutoCompactThreshold: boolean
  isAtBlockingLimit: boolean
}
