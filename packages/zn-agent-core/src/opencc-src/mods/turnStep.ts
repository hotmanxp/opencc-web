/**
 * `turn.step` chunk shapes (upstream `claude-code.d.ts:10401-10530`).
 *
 * Upstream is explicit that `turn.step` "alone" is a streaming event: "the
 * model's response arrives in pieces, and a hook that saw it whole could not
 * change what had already been shown". `TurnStepInputChunk` is the reason the
 * event exists at all — a tool call's arguments arrive as partial JSON, and a
 * hook that only saw the parsed result could not rewrite them.
 *
 * `ref` is upstream's "the engine's handle on the item; opaque, this step's
 * only" (`ChunkRef`). opencc has no block-registry to hand out, so it is a
 * per-step counter a hook can carry back but cannot forge meaningfully — the
 * same opacity upstream relies on for its `engine` chunks.
 */

import type { ModModelUsage } from './nouns.js'

/**
 * Upstream `TurnUsage = ModelForkUsage & { model }` (d.ts:10530) — the same
 * four counters `$.model.fork` already reports, plus which model answered.
 */
export type TurnUsage = ModModelUsage & { model: string }

/** Opaque per-step handle, carried back and forth unchanged. */
export type ChunkRef = { ref: number }

/** An engine event the other kinds do not model — passed on unread. */
export type TurnStepEngineChunk = ChunkRef & { kind: 'engine' }

/** Visible text as it arrives, in block `index`. */
export type TurnStepTextChunk = ChunkRef & {
  kind: 'text'
  index: number
  text: string
}

/** Thinking as it arrives, in block `index`. */
export type TurnStepThinkingChunk = ChunkRef & {
  kind: 'thinking'
  index: number
  text: string
}

/** The model begins a tool call: its id and name. Arguments follow as `input`. */
export type TurnStepToolChunk = ChunkRef & {
  kind: 'tool'
  index: number
  id: string
  name: string
}

/** A piece of a tool call's argument JSON. */
export type TurnStepInputChunk = ChunkRef & {
  kind: 'input'
  index: number
  json: string
}

/** The response is whole: why the model stopped and what it cost. */
export type TurnStepStopChunk = ChunkRef & {
  kind: 'stop'
  stopReason: string | null
  usage: TurnUsage | null
}

export type TurnStepChunk =
  | TurnStepTextChunk
  | TurnStepThinkingChunk
  | TurnStepToolChunk
  | TurnStepInputChunk
  | TurnStepStopChunk
  | TurnStepEngineChunk

/** What `next(e)` resolves to and what a hook returns. */
export type TurnStepResult = {
  turnId: string
  index: number
  answer: string
  toolUses: readonly { name: string; input: unknown }[]
  stopReason: string | null
  usage: TurnUsage | null
}

/** The event's input — dispatched once per model request, before it is sent. */
export type TurnStepInput = {
  turnId: string
  index: number
  model: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number
  messageCount: number
  agentId?: string
}
