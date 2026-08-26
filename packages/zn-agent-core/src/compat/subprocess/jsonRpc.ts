import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import type { SubprocessHandle } from './types.js'

/**
 * A JSON-RPC 2.0 frame as transported by Codex's app-server over stdio:
 *
 *   - Requests  : `{"id": <n>, "method": "...", "params": {...}}`
 *   - Responses : `{"id": <n>, "result": ...}` OR `{"id": <n>, "error": {...}}`
 *   - Notifications (server → client, no reply expected):
 *                 `{"method": "...", "params": {...}}`
 *
 * Frames are newline-delimited; partial frames are buffered until `\n`. Each
 * line is one and only one frame. The wire protocol stays in this shape across
 * 0.147.0 and is unlikely to gain batch encoding given upstream's stdio
 * constraints.
 */
export interface JsonRpcRequestFrame {
  readonly id: number
  readonly method: string
  readonly params?: unknown
}

export interface JsonRpcSuccessResponse<TResult = unknown> {
  readonly id: number
  readonly result: TResult
}

export interface JsonRpcErrorResponse {
  readonly id: number
  readonly error: { readonly code: number; readonly message: string; readonly data?: unknown }
}

export type JsonRpcResponse<TResult = unknown> =
  | JsonRpcSuccessResponse<TResult>
  | JsonRpcErrorResponse

export interface JsonRpcNotification {
  readonly method: string
  readonly params?: unknown
}

/**
 * Loose union describing every shape we may see on the wire. `id` is optional
 * because notifications omit it; unknown fields are tolerated (Codex sometimes
 * adds keys in newer patch versions, and a strict decoder would block fixes).
 * `method` lives at the union root so listeners can access `frame.method`
 * without a narrowing cascade across the three variants — the standard
 * `JsonRpcResponse` shape does not require one, but a stray one does no harm.
 */
export type JsonRpcFrame =
  | JsonRpcResponse
  | JsonRpcNotification
  | { readonly id?: number; readonly method?: string; readonly [k: string]: unknown }

export type JsonRpcNotificationHandler = (method: string, params: unknown) => void

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: Error) => void
  readonly method: string
}

/**
 * Thin JSON-RPC 2.0 client over a {@link SubprocessHandle}'s `stdout` /
 * `stdin`. Designed for exactly one peer (codex app-server); it does not
 * support batch frames and it owns id allocation for outbound requests.
 *
 * Lifetime:
 *   - constructed with an open SubprocessHandle
 *   - `request` / `notify` use the handle's `stdin` / `stdout`
 *   - on stream EOF or transport error, every pending request rejects with a
 *     peer-closed error; subsequent `request()` calls also reject before any
 *     frame is sent (the wire is gone)
 *   - `dispose()` ends stdin, awaits `killTree()`, and rejects no outstanding
 *     requests itself — the transport close handler does that work first so
 *     the cause is observable to the caller
 *
 * Re-entrancy: `request()` is not safe to call from inside a notification
 * handler while the handler runs on the same tick. Use `queueMicrotask` or
 * defer the call by one frame when nesting.
 */
export class JsonRpcClient {
  readonly #handle: SubprocessHandle
  readonly #pending = new Map<number, PendingRequest>()
  readonly #listeners = new Set<JsonRpcNotificationHandler>()
  readonly #rl: ReturnType<typeof createInterface>
  /** Next id to allocate; monotonic per client instance. */
  #nextId = 1
  #closed = false
  #closeReason: Error | null = null

  constructor(handle: SubprocessHandle) {
    this.#handle = handle
    this.#rl = createInterface({ input: handle.stdout, crlfDelay: Infinity })
    this.#rl.on('line', (line) => this.#onLine(line))
    // `close` fires when the parent stream EOFs (process exit) or when the
    // interface is `.close()`d explicitly. Treat both as transport loss.
    this.#rl.on('close', () => this.#onTransportClosed('peer closed the stream'))
    handle.stderr.on('data', (chunk: Buffer) => {
      // Diagnostics only. Codex app-server 0.147.0 keeps stderr quiet during
      // normal operation; any content here is worth surfacing through the
      // caller's logger in production. The seam doesn't pick a logger.
      void chunk
    })
  }

  /** True once the underlying stream has closed; subsequent calls fail-fast. */
  get closed(): boolean {
    return this.#closed
  }

  /**
   * Send a JSON-RPC request and await the matching response. `params` is
   * serialized with `JSON.stringify`; round-trip JSON objects (no BigInt,
   * no cycles). Rejects on transport close, parse failures, or server-side
   * `error` frames.
   */
  request<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    if (this.#closed) {
      return Promise.reject(
        new Error(`json-rpc: cannot send '${method}' — transport is closed (${this.#closeReason?.message ?? 'unknown'})`),
      )
    }
    const id = this.#nextId++
    const frame: JsonRpcRequestFrame = params === undefined ? { id, method } : { id, method, params }
    return new Promise<TResult>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject,
        method,
      })
      try {
        this.#write(JSON.stringify(frame) + '\n')
      } catch (err) {
        // write failed synchronously — drop the entry so memory doesn't leak
        this.#pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /**
   * Send a JSON-RPC notification. No id, no response expected. Throws if the
   * underlying write fails — the caller can choose to treat that as fatal or
   * ignore it. Returns synchronously.
   */
  notify(method: string, params?: unknown): void {
    if (this.#closed) {
      throw new Error(`json-rpc: cannot notify '${method}' — transport is closed`)
    }
    const frame: JsonRpcNotification = params === undefined ? { method } : { method, params }
    this.#write(JSON.stringify(frame) + '\n')
  }

  /**
   * Subscribe to incoming notifications (frames without `id`). Multiple
   * handlers may be attached; each is invoked in registration order. Returns
   * the unsubscribe function — symmetry for cleanup in providers that mount /
   * unmount listeners around turns.
   *
   * Response frames are NOT delivered here; they are routed only to the
   * matching pending `request()`'s resolver. This split keeps wire-level
   * fan-out simple for the only known consumer.
   */
  onNotification(handler: JsonRpcNotificationHandler): () => void {
    this.#listeners.add(handler)
    return () => {
      this.#listeners.delete(handler)
    }
  }

  /**
   * Best-effort shutdown: ends stdin (so the peer sees EOF and may exit
   * gracefully) and waits for the underlying process to exit. Does not
   * reject outstanding requests — that's the transport close handler's
   * job, which runs from the readline `close` event before `dispose()`
   * finishes its await.
   */
  async dispose(): Promise<void> {
    try {
      this.#handle.stdout.unpipe() // no-op if nothing piped, but harmless
    } catch {
      // ignore
    }
    try {
      this.#rl.close()
    } catch {
      // ignore — already closed
    }
    // `killTree` is idempotent; awaiting it guarantees whole-tree exit.
    try {
      await this.#handle.killTree()
    } catch {
      // killTree is best-effort in this seam; nothing useful to do here.
    }
  }

  // -- internals --

  #write(line: string): void {
    this.#handle.stdin.write(line)
  }

  #onLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let frame: JsonRpcFrame
    try {
      frame = JSON.parse(trimmed) as JsonRpcFrame
    } catch (err) {
      // A malformed line is a wire contract violation. Don't kill the client:
      // the peer may recover on the next frame. Log the bad payload via the
      // caller's logger if they attach one; the seam itself stays quiet
      // because every read site would otherwise have to import a logger.
      void err
      return
    }
    // Distinguish response (has id matching pending) from notification (no id).
    // Cast through `unknown` first: JsonRpcFrame is a union of three shapes
    // and TS's narrowing across the union is brittle. The cast projects
    // whatever variant the server emitted onto the record shape, which is
    // what this parse-and-dispatch loop expects.
    const f = frame as unknown as Record<string, unknown>
    if (typeof f.id === 'number') {
      const resp = f as unknown as { id: number; error?: { message?: unknown; code?: unknown }; result?: unknown }
      const pending = this.#pending.get(resp.id)
      if (!pending) {
        // Late response for a request we already gave up on. Drop silently.
        return
      }
      this.#pending.delete(resp.id)
      if (resp.error && typeof resp.error === 'object') {
        const errObj = resp.error
        const message = typeof errObj.message === 'string' ? errObj.message : '<no message>'
        const code = errObj.code
        pending.reject(
          new Error(
            `json-rpc: server error for '${pending.method}' (id=${resp.id}): ${message} (code=${code})`,
          ),
        )
      } else if ('result' in resp) {
        pending.resolve(resp.result)
      } else {
        pending.reject(
          new Error(`json-rpc: response for '${pending.method}' (id=${resp.id}) missing both result and error`),
        )
      }
      return
    }
    // Notification (or unrecognized). Dispatch to listeners.
    {
      const notification = frame as unknown as { method?: string; params?: unknown }
      if (typeof notification.method === 'string') {
        for (const handler of this.#listeners) {
          try {
            handler(notification.method, notification.params)
          } catch (err) {
            // A throwing handler must not break the wire loop.
            void err
          }
        }
      }
    }
    // Frames that are neither response nor notification (rare; protocol
    // extensions) are silently ignored — adding a new method on the server
    // side never crashes a client still on the older contract.
  }

  #onTransportClosed(reason: string): void {
    if (this.#closed) return
    this.#closed = true
    this.#closeReason = new Error(reason)
    // Reject every pending request with the same close error so callers see a
    // consistent cause rather than individual timeouts racing.
    for (const [, pending] of this.#pending) {
      pending.reject(new Error(`json-rpc: transport closed before '${pending.method}' responded: ${reason}`))
    }
    this.#pending.clear()
  }
}
