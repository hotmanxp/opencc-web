/**
 * The `turn.step` seam.
 *
 * The model's response arrives as a pump over `iterator.next()` (the
 * `content_block_delta` switch in claude.ts) that mutates `contentBlocks` and
 * yields finished assistant messages. Upstream's contract is the opposite
 * shape: the engine's stream is a generator a hook chain pulls, and "what
 * leaves the outermost hook is what is shown and recorded" — a rewritten
 * `text` chunk rewrites the transcript, a dropped one drops the block.
 *
 * Converting that pump into a generator would mean restructuring its abort
 * races, idle-timer watchdog and stall accounting — the most delicate code in
 * the repo — for no gain. So this is a PUSH adapter over the PULL chain: the
 * chain's bottom is a queue-backed generator, the sink feeds it a chunk and
 * takes back whatever the hooks made of it, all before the next delta arrives.
 *
 * That is the whole point of the event, and the reason it could not be faked:
 * the `input` chunk carries partial argument JSON, so a hook rewrites the
 * arguments the tool will actually run with, not a copy of the finished ones.
 */

import { dispatchModStream } from './dispatch.js'
import type {
  TurnStepChunk,
  TurnStepInput,
  TurnStepResult,
} from './turnStep.js'

/** Sentinel that ends the bottom generator; not a real chunk. */
const CLOSE = Symbol('turn.step close')

/**
 * The chain's bottom: a generator over chunks the sink feeds it.
 *
 * This is what `open` hands the chain, so a handler's `next(e)` — "the stream
 * beneath" — reads what the pump pushed.
 *
 * It is re-entrant on purpose. `runModStreamChain` wraps the bottom in a fresh
 * delegating generator on EVERY `next(e)` call (its `beneath()`), and the
 * documented upstream hook shape calls `next(e)` once per chunk — so the same
 * bottom is entered again and again across one response. Each entry takes the
 * chunks queued since the last one and returns; a chunk is handed out exactly
 * once no matter how many wrappers come through.
 */
function createBottom(
  input: TurnStepInput,
): AsyncGenerator<TurnStepChunk, TurnStepResult> & {
  push(chunk: TurnStepChunk): void
  close(): void
  /** Resolves when the chain asks for its next chunk — the exchange boundary. */
  asked(): Promise<void>
} {
  let asked: (() => void) | null = null
  const queue: TurnStepChunk[] = []
  let waiting: ((value: TurnStepChunk) => void) | null = null
  let closed = false

  // One shared iterator, not a fresh one per entry: `yield*` on a generator
  // that is already running throws, and the wrappers above are created fresh
  // each time. Handing them this object's own `next` keeps a single cursor.
  const drain = (async function* (): AsyncGenerator<
    TurnStepChunk,
    TurnStepResult
  > {
    for (;;) {
      if (queue.length > 0) {
        yield queue.shift()!
        continue
      }
      if (closed) return DONE(input)
      const next = await new Promise<TurnStepChunk>(resolve => {
        waiting = resolve
        const askedNow = asked
        asked = null
        askedNow?.()
      })
      waiting = null
      if (next === (CLOSE as unknown as TurnStepChunk)) return DONE(input)
      yield next
    }
  })()

  const generator = (async function* (): AsyncGenerator<
    TurnStepChunk,
    TurnStepResult
  > {
    // Delegate to the shared cursor. `yield*` would throw on re-entry, so the
    // delegation is spelled out — and because `drain` is a single iterator,
    // concurrent wrappers queue on it rather than each starting their own.
    for (;;) {
      const step = await drain.next()
      if (step.done) return step.value
      yield step.value
    }
  })()

  return Object.assign(generator, {
    /**
     * Resolves the moment the chain asks for its next chunk.
     *
     * The only sound way to end an exchange: a hook that maps or passes yields
     * a chunk and then loops back here, while one that drops a chunk goes
     * straight here without yielding. Both are "done with this chunk", and
     * neither is observable by racing against the microtask queue — a pending
     * promise there loses to an already-settled one and silently truncates the
     * response, which is the failure mode that must not exist.
     */
    asked: () =>
      new Promise<void>(resolve => {
        if (waiting !== null) resolve()
        else asked = resolve
      }),
    push(chunk: TurnStepChunk) {
      // A waiter, when present, is a pull already outstanding from an earlier
      // exchange — it is suspended INSIDE the chain, holding the slot this
      // chunk belongs to. Handing it over directly is what keeps one push to
      // one chunk. Queuing unconditionally as well would leave the chunk in
      // the queue for a second consumer to find, and the response would show
      // the last chunk of every exchange twice.
      const resolve = waiting
      if (resolve) {
        waiting = null
        resolve(chunk)
        return
      }
      queue.push(chunk)
    },
    close() {
      closed = true
      const resolve = waiting
      waiting = null
      resolve?.(CLOSE as unknown as TurnStepChunk)
    },
  })
}

function DONE(input: TurnStepInput): TurnStepResult {
  return {
    turnId: input.turnId,
    index: input.index,
    answer: '',
    toolUses: [],
    stopReason: null,
    usage: null,
  }
}

/**
 * A live `turn.step` chain for one model request.
 *
 * `null` when no mod subscribes — the pump then accumulates directly, exactly
 * as it did before this event existed, and pays nothing.
 */
export type TurnStepSink = {
  /** Feed a chunk; get back the chunks to accumulate in its place. */
  exchange(chunk: TurnStepChunk): Promise<TurnStepChunk[]>
  /** Mint the next opaque `ref`. */
  nextRef(): number
  /** Close the chain; the step's result is whatever the outermost hook returns. */
  close(): Promise<void>
}

/**
 * Open a sink, or return null when nobody is listening.
 *
 * The zero-subscriber check happens BEFORE the chain is built: the sink exists
 * to rewrite what the pump accumulates, so with no handlers there is nothing to
 * rewrite and the pump's direct path is the correct one, not a shortcut.
 */
export function openTurnStepSink(
  input: TurnStepInput,
  hasHandlers: boolean,
): TurnStepSink | null {
  if (!hasHandlers) return null
  let ref = 0
  const bottom = createBottom(input)
  const stream = dispatchModStream<TurnStepChunk, TurnStepResult>(
    'turn.step',
    input,
    () => bottom,
  )

  // One chunk in, whatever the chain emits back out for it. A handler that
  // drops the chunk emits nothing and the caller accumulates nothing —
  // upstream's "one that drops them all drops the block".
  //
  // The pull is remembered across exchanges. An exchange that ends on `asked`
  // leaves its pull outstanding, and that pull is what the NEXT chunk arrives
  // on — starting a second one would make two consumers wait on one chunk.
  let pending: Promise<IteratorResult<TurnStepChunk, TurnStepResult>> | null =
    null
  const pull = (): Promise<IteratorResult<TurnStepChunk, TurnStepResult>> => {
    if (pending) return pending
    const p = stream.next()
    pending = p
    void p.then(
      () => {
        if (pending === p) pending = null
      },
      () => {
        if (pending === p) pending = null
      },
    )
    return p
  }

  return {
    async exchange(chunk: TurnStepChunk) {
      bottom.push(chunk)
      const out: TurnStepChunk[] = []
      for (;;) {
        // Either the chain emits a chunk, or it comes back for the next one.
        // Exactly one of these settles, which is what makes this a boundary
        // rather than a timeout: a hook that drops the chunk goes straight to
        // `asked` without emitting anything.
        const inFlight = pull()
        const step = await Promise.race([
          inFlight,
          bottom.asked().then(() => null),
        ])
        if (step === null) {
          // `asked` won. The pull stays outstanding and becomes the NEXT
          // exchange's pull — it is the very pull that drove the chain to ask.
          // Draining it here instead would consume the following chunk and
          // report it twice, which reads as the model repeating itself.
          break
        }
        if (step.done) {
          bottom.close()
          break
        }
        out.push(step.value)
      }
      return out
    },
    nextRef: () => ref++,
    async close() {
      bottom.close()
      // Let the chain finish so the outermost hook's return value — the step's
      // result — is produced rather than abandoned mid-stream.
      await pull().catch(() => undefined)
    },
  }
}
