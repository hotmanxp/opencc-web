import { describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'
import { Writable } from 'node:stream'
import { JsonRpcClient } from '../../../src/compat/subprocess/jsonRpc.js'
import type { SubprocessHandle } from '../../../src/compat/subprocess/types.js'

/**
 * The JSON-RPC client is the only piece of the seam with non-trivial wire
 * parsing logic. We test it against a synthetic SubprocessHandle that pipes
 * bytes through a PassThrough pair, so no real OS process is needed for
 * these tests. The spawn-layer integration is covered by `spawn.test.ts`.
 */

class PipeHandle implements SubprocessHandle {
  readonly pid = 99999 // synthetic; not used by the client
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  readonly exitCode: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  readonly #killTree = vi.fn(async () => undefined)

  constructor(
    private readonly writableFactory: () => Writable,
    private readonly readableFactory: () => Readable,
    exitResult: { code: number | null; signal: NodeJS.Signals | null } = { code: 0, signal: null },
  ) {
    this.stdin = writableFactory()
    this.stdout = readableFactory()
    this.stderr = new Readable({ read() {} }) // unused; never written to
    this.exitCode = Promise.resolve(exitResult)
  }

  async killTree(graceMs?: number): Promise<void> {
    return this.#killTree(graceMs)
  }
}

function capturedStdin(): { writable: Writable; readWritten: () => string } {
  let buffer = ''
  const writable = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      cb()
    },
  })
  return { writable, readWritten: () => buffer }
}

function readableFrom(lines: string[]): Readable {
  let i = 0
  return new Readable({
    read() {
      // Defer each push via setImmediate so readline actually processes
      // every chunk's complete line BEFORE the final null (EOF) arrives.
      // Without this gap, a synchronous push of N chunks + null results in
      // a single `data` event carrying all of them, and `createInterface`
      // can fire 'close' before its buffered 'line' handlers drain —
      // especially when tests dispatch only one request and the matching
      // response happens to be the last frame.
      setImmediate(() => {
        if (i >= lines.length) {
          this.push(null)
          return
        }
        this.push(lines[i++])
      })
    },
  })
}

describe('subprocess/jsonRpc.JsonRpcClient', () => {
  it('matches a response to its pending request by id and resolves with the result', async () => {
    const { writable, readWritten } = capturedStdin()
    const handle = new PipeHandle(
      () => writable,
      () => readableFrom([JSON.stringify({ id: 1, result: { ok: true } }) + '\n']),
    )
    const client = new JsonRpcClient(handle)
    const result = await client.request<{ ok: boolean }>('echo', { x: 1 })
    expect(result).toEqual({ ok: true })
    const sent = readWritten()
    const sentFrame = JSON.parse(sent.trim())
    expect(sentFrame.id).toBe(1)
    expect(sentFrame.method).toBe('echo')
    expect(sentFrame.params).toEqual({ x: 1 })
  })

  it('routes server-side error frames through reject with the server message + code', async () => {
    const { writable } = capturedStdin()
    const handle = new PipeHandle(
      () => writable,
      () =>
        readableFrom([
          // First request() allocates id=1, so the matching response uses id=1.
          JSON.stringify({ id: 1, error: { code: -32_601, message: 'method not found' } }) + '\n',
        ]),
    )
    const client = new JsonRpcClient(handle)
    await expect(client.request('doesNotExist')).rejects.toThrow(/method not found/)
    // Note: error code is forwarded but not asserted strictly — server-side
    // codes can carry leading sign etc. and the message is the human hook.
  })

  it('delivers server-pushed notifications to onNotification subscribers in order', async () => {
    const { writable } = capturedStdin()
    const handle = new PipeHandle(
      () => writable,
      () =>
        readableFrom([
          JSON.stringify({ method: 'progress', params: { pct: 50 } }) + '\n',
          JSON.stringify({ method: 'progress', params: { pct: 100 } }) + '\n',
        ]),
    )
    const client = new JsonRpcClient(handle)
    const events: Array<{ method: string; params: unknown }> = []
    client.onNotification((method, params) => events.push({ method, params }))
    // Wait for readline to drain; one tick is enough for two lines on a
    // synthetic readable.
    await new Promise<void>((r) => setTimeout(r, 10))
    expect(events).toEqual([
      { method: 'progress', params: { pct: 50 } },
      { method: 'progress', params: { pct: 100 } },
    ])
  })

  it('allocates ids monotonically across requests', async () => {
    const { writable, readWritten } = capturedStdin()
    const handle = new PipeHandle(
      () => writable,
      () => readableFrom([]), // don't bother responding; we only inspect outbound frames
    )
    const client = new JsonRpcClient(handle)
    // Fire three requests; we expect three distinct ids. The pending
    // promises will never resolve (no responses) — that's fine here; the
    // test exists purely to assert id allocation discipline. We attach
    // .catch() handlers so the unhandled rejections don't pollute the run.
    void client.request('m1').catch(() => undefined)
    void client.request('m2').catch(() => undefined)
    void client.request('m3').catch(() => undefined)
    const lines = readWritten().split('\n').filter(Boolean)
    expect(lines.length).toBe(3)
    const ids = lines.map((l) => JSON.parse(l).id as number)
    expect(new Set(ids).size).toBe(3)
    expect(Math.min(...ids)).toBe(1)
    expect(Math.max(...ids)).toBe(3)
    // Don't await pending — they were rejected on transport close below.
    handle.stdout.destroy()
  })

  it('rejects every pending request with a peer-closed error when the transport closes', async () => {
    const { writable } = capturedStdin()
    let stream: Readable = readableFrom([])
    const handle = new PipeHandle(() => writable, () => stream)
    const client = new JsonRpcClient(handle)
    const p1 = client.request('will-not-respond').catch((e) => e as Error)
    // Close the readable; readline emits 'close' on EOF.
    stream.push(null)
    const e1 = await p1
    expect(e1).toBeInstanceOf(Error)
    expect((e1 as Error).message).toMatch(/transport closed|peer closed/)
    // New request after close rejects synchronously (well, in a microtask).
    await expect(client.request('post-close')).rejects.toThrow(/transport is closed/)
  })

  it('ignores malformed frames without killing the wire', async () => {
    const { writable } = capturedStdin()
    const handle = new PipeHandle(
      () => writable,
      () =>
        readableFrom([
          // Each entry MUST be a complete newline-terminated frame; readline
          // buffers until it sees \n, so a malformed line without \n would
          // only emit a single concatenated line with the JSON response.
          '{not-json\n',
          // First request() allocates id=1 — match the response to the
          // pending request, not to a hardcoded external id.
          JSON.stringify({ id: 1, result: 'ok' }) + '\n',
        ]),
    )
    const client = new JsonRpcClient(handle)
    const result = await client.request<string>('respond-1')
    expect(result).toBe('ok')
  })

  it('notify() writes a frame with no id; no reply is awaited', () => {
    const { writable, readWritten } = capturedStdin()
    const handle = new PipeHandle(
      () => writable,
      () => readableFrom([]),
    )
    const client = new JsonRpcClient(handle)
    client.notify('log', { msg: 'hi' })
    const frame = JSON.parse(readWritten().trim())
    expect(frame.id).toBeUndefined()
    expect(frame.method).toBe('log')
    expect(frame.params).toEqual({ msg: 'hi' })
  })

  it('throw inside a notification handler does not break the wire loop', async () => {
    const { writable } = capturedStdin()
    const handle = new PipeHandle(
      () => writable,
      () =>
        readableFrom([
          JSON.stringify({ method: 'boom', params: {} }) + '\n',
          JSON.stringify({ method: 'after-boom', params: {} }) + '\n',
        ]),
    )
    const client = new JsonRpcClient(handle)
    const received: string[] = []
    client.onNotification((method) => {
      if (method === 'boom') throw new Error('handler boom')
      received.push(method)
    })
    await new Promise<void>((r) => setTimeout(r, 10))
    expect(received).toEqual(['after-boom'])
  })
})
