/**
 * Tests for the bg daemon IPC frame codec + zod schemas.
 *
 * The bg daemon IPC protocol is the foundation for T3 (socket), T4 (roster),
 * T5 (supervisor), T7 (agents CLI), T10 (--bg flag). This test file locks
 * down the wire format and schema field names so downstream tasks can rely
 * on them. Any drift is an `EPROTO` once the server is live.
 *
 * @see docs/superpowers/plans/2026-06-13-plan-bg-agent-view.md §T2
 */
import { describe, expect, test } from 'bun:test'
import {
  BG_PROTO,
  BG_MAX_FRAME_BYTES,
  BGRequestSchema,
  BGResponseErrSchema,
  BGResponseOkSchema,
  BGResponseSchema,
  ErrorCodeSchema,
  FrameReader,
  JobLaunchSpecSchema,
  JobShortIdSchema,
  encodeFrame,
  encodeFrames,
} from './protocol.js'

// ---------- Frame codec ----------

describe('encodeFrame', () => {
  test('produces [u32 BE length][u8 kind][body] for kind=0', () => {
    const body = Buffer.from('hello', 'utf8')
    const out = encodeFrame({ kind: 0, body })
    expect(out.length).toBe(5 + body.length)
    expect(out.readUInt32BE(0)).toBe(body.length)
    expect(out.readUInt8(4)).toBe(0)
    expect(out.subarray(5).toString('utf8')).toBe('hello')
  })

  test('produces kind=1 for ctrl frames (reserved)', () => {
    const body = Buffer.from([0x01, 0x02])
    const out = encodeFrame({ kind: 1, body })
    expect(out.readUInt32BE(0)).toBe(2)
    expect(out.readUInt8(4)).toBe(1)
    expect(Array.from(out.subarray(5))).toEqual([0x01, 0x02])
  })

  test('encodes zero-length body as length=0', () => {
    const out = encodeFrame({ kind: 0, body: Buffer.alloc(0) })
    expect(out.length).toBe(5)
    expect(out.readUInt32BE(0)).toBe(0)
    expect(out.readUInt8(4)).toBe(0)
  })

  test('uses big-endian length (rejects naive byte-by-byte)', () => {
    const body = Buffer.from('x'.repeat(0x0102))
    const out = encodeFrame({ kind: 0, body })
    expect(out.readUInt32BE(0)).toBe(0x0102)
    // First byte of length field must be the high byte 0x00 (big-endian)
    expect(out[0]).toBe(0x00)
    expect(out[1]).toBe(0x00)
    expect(out[2]).toBe(0x01)
    expect(out[3]).toBe(0x02)
  })
})

describe('encodeFrames', () => {
  test('concatenates multiple frames in order', () => {
    const a = encodeFrame({ kind: 0, body: Buffer.from('AAA') })
    const b = encodeFrame({ kind: 0, body: Buffer.from('BBBBB') })
    const out = encodeFrames([
      { kind: 0, body: Buffer.from('AAA') },
      { kind: 0, body: Buffer.from('BBBBB') },
    ])
    expect(out.equals(Buffer.concat([a, b]))).toBe(true)
  })

  test('empty input returns empty Buffer', () => {
    expect(encodeFrames([]).length).toBe(0)
  })
})

describe('FrameReader', () => {
  function collect(chunks: Buffer[]): Array<{ kind: number; body: Buffer }> {
    const frames: Array<{ kind: number; body: Buffer }> = []
    const reader = new FrameReader(f => frames.push(f))
    for (const c of chunks) reader.feed(c)
    return frames
  }

  test('emits a complete frame when fed in one chunk', () => {
    const out = encodeFrame({ kind: 0, body: Buffer.from('hi') })
    const frames = collect([out])
    expect(frames.length).toBe(1)
    expect(frames[0].kind).toBe(0)
    expect(frames[0].body.toString('utf8')).toBe('hi')
  })

  test('waits for the header when chunk is short', () => {
    const out = encodeFrame({ kind: 0, body: Buffer.from('hello') })
    // Feed only first 3 bytes (header incomplete)
    const frames = collect([out.subarray(0, 3)])
    expect(frames.length).toBe(0)
  })

  test('reassembles a frame split across two chunks (3 then 7 bytes)', () => {
    const out = encodeFrame({ kind: 0, body: Buffer.from('hello') })
    const frames = collect([out.subarray(0, 3), out.subarray(3)])
    expect(frames.length).toBe(1)
    expect(frames[0].body.toString('utf8')).toBe('hello')
  })

  test('emits multiple frames from one chunk', () => {
    const out = encodeFrames([
      { kind: 0, body: Buffer.from('a') },
      { kind: 0, body: Buffer.from('bb') },
      { kind: 1, body: Buffer.from('ccc') },
    ])
    const frames = collect([out])
    expect(frames.length).toBe(3)
    expect(frames[0].body.toString('utf8')).toBe('a')
    expect(frames[1].body.toString('utf8')).toBe('bb')
    expect(frames[2].kind).toBe(1)
    expect(frames[2].body.toString('utf8')).toBe('ccc')
  })

  test('emits multiple frames split across chunk boundaries', () => {
    const out = encodeFrames([
      { kind: 0, body: Buffer.from('foo') },
      { kind: 0, body: Buffer.from('bar') },
    ])
    const mid = 8 // somewhere inside frame 1 body
    const frames = collect([out.subarray(0, mid), out.subarray(mid)])
    expect(frames.length).toBe(2)
    expect(frames[0].body.toString('utf8')).toBe('foo')
    expect(frames[1].body.toString('utf8')).toBe('bar')
  })

  test('body buffer is independent of internal buffer (safe to retain)', () => {
    const out = encodeFrame({ kind: 0, body: Buffer.from('zzz') })
    const frames = collect([out])
    expect(frames[0].body.toString('utf8')).toBe('zzz')
  })

  test('throws when frame length exceeds 1 MB', () => {
    const reader = new FrameReader(() => {})
    const header = Buffer.alloc(5)
    header.writeUInt32BE(BG_MAX_FRAME_BYTES + 1, 0)
    header.writeUInt8(0, 4)
    expect(() => reader.feed(header)).toThrow(/frame too large/i)
  })

  test('accepts a frame exactly at the 1 MB limit', () => {
    const body = Buffer.alloc(BG_MAX_FRAME_BYTES, 0x41) // 'A'
    const out = encodeFrame({ kind: 0, body })
    const frames = collect([out])
    expect(frames.length).toBe(1)
    expect(frames[0].body.length).toBe(BG_MAX_FRAME_BYTES)
  })

  test('BG_MAX_FRAME_BYTES is 1_048_576 (1 MiB)', () => {
    expect(BG_MAX_FRAME_BYTES).toBe(1_048_576)
  })

  // Issue #1 fix: kind byte must be 0 (payload) or 1 (ctrl).
  test('throws when frame kind byte is not 0 or 1', () => {
    const reader = new FrameReader(() => {})
    const bad = Buffer.alloc(6)
    bad.writeUInt32BE(1, 0) // body length 1
    bad.writeUInt8(2, 4)    // kind byte 2 — invalid
    bad.writeUInt8(0x41, 5) // 'A'
    expect(() => reader.feed(bad)).toThrow(/frame kind byte must be/i)
  })

  test('throws when frame kind byte is 255', () => {
    const reader = new FrameReader(() => {})
    const bad = Buffer.alloc(6)
    bad.writeUInt32BE(1, 0)
    bad.writeUInt8(255, 4)
    bad.writeUInt8(0x41, 5)
    expect(() => reader.feed(bad)).toThrow(/frame kind byte must be/i)
  })

  test('accepts frame with kind byte 0 (payload)', () => {
    const out = encodeFrame({ kind: 0, body: Buffer.from('payload') })
    const frames = collect([out])
    expect(frames.length).toBe(1)
    expect(frames[0].kind).toBe(0)
  })

  test('accepts frame with kind byte 1 (ctrl)', () => {
    const out = encodeFrame({ kind: 1, body: Buffer.from('ctrl') })
    const frames = collect([out])
    expect(frames.length).toBe(1)
    expect(frames[0].kind).toBe(1)
  })
})

// ---------- Constants ----------

describe('BG_PROTO', () => {
  test('is exactly 1', () => {
    expect(BG_PROTO).toBe(1)
  })
})

// ---------- JobShortId ----------

describe('JobShortIdSchema', () => {
  test('accepts an 8-character lowercase hex string', () => {
    const id = JobShortIdSchema.parse('abcd1234')
    // Brand still stringifies back to the same value
    expect(String(id)).toBe('abcd1234')
  })

  test('accepts all hex digits', () => {
    expect(JobShortIdSchema.parse('01234567')).toBeTruthy()
    expect(JobShortIdSchema.parse('89abcdef')).toBeTruthy()
    expect(JobShortIdSchema.parse('ffffffff')).toBeTruthy()
    expect(JobShortIdSchema.parse('00000000')).toBeTruthy()
  })

  test('rejects strings shorter than 8 chars', () => {
    expect(() => JobShortIdSchema.parse('abc123')).toThrow()
    expect(() => JobShortIdSchema.parse('')).toThrow()
  })

  test('rejects strings longer than 8 chars', () => {
    expect(() => JobShortIdSchema.parse('abcd12345')).toThrow()
  })

  test('rejects non-hex characters', () => {
    expect(() => JobShortIdSchema.parse('xyz12345')).toThrow()
    expect(() => JobShortIdSchema.parse('ABC12345')).toThrow() // uppercase not allowed
    expect(() => JobShortIdSchema.parse('ghijklmn')).toThrow()
  })
})

// ---------- ErrorCode enum ----------

describe('ErrorCodeSchema', () => {
  const allCodes = [
    'EPROTO',
    'EAUTH',
    'ENOJOB',
    'ENOREPLY',
    'ESTARTING',
    'ESTALLED',
    'EUNVERIFIED',
    'ERESPAWNING',
    'EKICKED',
    'ENOCONN',
    'ETIMEOUT',
    'EUNKNOWN',
  ] as const

  for (const code of allCodes) {
    test(`accepts ${code}`, () => {
      expect(ErrorCodeSchema.parse(code)).toBe(code)
    })
  }

  test('rejects unknown code', () => {
    expect(() => ErrorCodeSchema.parse('ENOTFOUND')).toThrow()
    expect(() => ErrorCodeSchema.parse('eproto')).toThrow() // case sensitive
    expect(() => ErrorCodeSchema.parse('')).toThrow()
  })
})

// ---------- BGRequestSchema ----------

describe('BGRequestSchema', () => {
  test('rejects proto mismatch (proto=2)', () => {
    expect(() =>
      BGRequestSchema.parse({ proto: 2, op: 'ping' }),
    ).toThrow()
  })

  test('rejects unknown op', () => {
    expect(() =>
      BGRequestSchema.parse({ proto: 1, op: 'frobnicate' }),
    ).toThrow()
  })

  test('accepts ping with proto=1', () => {
    expect(BGRequestSchema.parse({ proto: 1, op: 'ping' }).op).toBe('ping')
  })

  // Each of the 18 ops
  test('accepts nudge', () => {
    expect(BGRequestSchema.parse({ proto: 1, op: 'nudge' }).op).toBe('nudge')
  })

  test('accepts yield', () => {
    expect(BGRequestSchema.parse({ proto: 1, op: 'yield' }).op).toBe('yield')
  })

  test('accepts lease with required fields', () => {
    const r = BGRequestSchema.parse({
      proto: 1,
      op: 'lease',
      label: 'cli',
      cwd: '/tmp',
      pid: 1234,
    })
    if (r.op !== 'lease') throw new Error('op mismatch')
    expect(r.label).toBe('cli')
    expect(r.cwd).toBe('/tmp')
    expect(r.pid).toBe(1234)
  })

  test('rejects lease missing pid', () => {
    expect(() =>
      BGRequestSchema.parse({
        proto: 1,
        op: 'lease',
        label: 'cli',
        cwd: '/tmp',
      }),
    ).toThrow()
  })

  test('accepts leases', () => {
    expect(BGRequestSchema.parse({ proto: 1, op: 'leases' }).op).toBe('leases')
  })

  test('accepts await-ack', () => {
    const r = BGRequestSchema.parse({
      proto: 1,
      op: 'await-ack',
      short: 'abcd1234',
      timeoutMs: 5000,
    })
    if (r.op !== 'await-ack') throw new Error('op mismatch')
    expect(String(r.short)).toBe('abcd1234')
    expect(r.timeoutMs).toBe(5000)
  })

  test('rejects await-ack with bad short id', () => {
    expect(() =>
      BGRequestSchema.parse({
        proto: 1,
        op: 'await-ack',
        short: 'XYZ',
        timeoutMs: 1000,
      }),
    ).toThrow()
  })

  test('accepts dispatch with auth + job (prompt mode)', () => {
    const r = BGRequestSchema.parse({
      proto: 1,
      op: 'dispatch',
      auth: 'secret',
      job: {
        proto: 1,
        short: 'abcd1234',
        nonce: '12345678',
        sessionId: 'sess-1',
        createdAt: 1700000000000,
        source: 'shell',
        cwd: '/tmp',
        env: {},
        isolation: 'none',
        respawnFlags: [],
        launch: { mode: 'prompt', args: ['hello'] },
      },
    })
    if (r.op !== 'dispatch') throw new Error('op mismatch')
    expect(r.auth).toBe('secret')
    expect(r.job.launch.mode).toBe('prompt')
  })

  test('rejects dispatch without auth', () => {
    expect(() =>
      BGRequestSchema.parse({
        proto: 1,
        op: 'dispatch',
        job: { mode: 'prompt', args: [] },
      }),
    ).toThrow()
  })

  test('accepts list', () => {
    expect(BGRequestSchema.parse({ proto: 1, op: 'list' }).op).toBe('list')
  })

  test('accepts has', () => {
    const r = BGRequestSchema.parse({
      proto: 1,
      op: 'has',
      short: 'abcd1234',
    })
    if (r.op !== 'has') throw new Error('op mismatch')
    expect(String(r.short)).toBe('abcd1234')
  })

  test('accepts kill with default signal', () => {
    const r = BGRequestSchema.parse({
      proto: 1,
      op: 'kill',
      short: 'abcd1234',
    })
    if (r.op !== 'kill') throw new Error('op mismatch')
    expect(String(r.short)).toBe('abcd1234')
    // signal is optional with default 'SIGTERM'
  })

  test('accepts kill with SIGKILL', () => {
    const r = BGRequestSchema.parse({
      proto: 1,
      op: 'kill',
      short: 'abcd1234',
      signal: 'SIGKILL',
    })
    if (r.op !== 'kill') throw new Error('op mismatch')
    expect(r.signal).toBe('SIGKILL')
  })

  test('rejects kill with unknown signal', () => {
    expect(() =>
      BGRequestSchema.parse({
        proto: 1,
        op: 'kill',
        short: 'abcd1234',
        signal: 'SIGHUP',
      }),
    ).toThrow()
  })

  test('accepts reply', () => {
    const r = BGRequestSchema.parse({
      proto: 1,
      op: 'reply',
      auth: 'k',
      short: 'abcd1234',
      text: 'hi',
    })
    if (r.op !== 'reply') throw new Error('op mismatch')
    expect(r.text).toBe('hi')
  })

  test('rejects reply without auth', () => {
    expect(() =>
      BGRequestSchema.parse({
        proto: 1,
        op: 'reply',
        short: 'abcd1234',
        text: 'hi',
      }),
    ).toThrow()
  })

  test('accepts subscribe with optional tail', () => {
    const r = BGRequestSchema.parse({
      proto: 1,
      op: 'subscribe',
      short: 'abcd1234',
      tail: 100,
    })
    if (r.op !== 'subscribe') throw new Error('op mismatch')
    expect(r.tail).toBe(100)
  })

  test('accepts subscribe without tail', () => {
    const r = BGRequestSchema.parse({
      proto: 1,
      op: 'subscribe',
      short: 'abcd1234',
    })
    if (r.op !== 'subscribe') throw new Error('op mismatch')
    expect(r.tail).toBeUndefined()
  })

  test('accepts attach', () => {
    const r = BGRequestSchema.parse({
      proto: 1,
      op: 'attach',
      auth: 'k',
      short: 'abcd1234',
      cols: 80,
      rows: 24,
      attachId: 'aid-1',
    })
    if (r.op !== 'attach') throw new Error('op mismatch')
    expect(r.cols).toBe(80)
    expect(r.attachId).toBe('aid-1')
  })

  test('rejects attach without auth', () => {
    expect(() =>
      BGRequestSchema.parse({
        proto: 1,
        op: 'attach',
        short: 'abcd1234',
        cols: 80,
        rows: 24,
        attachId: 'aid-1',
      }),
    ).toThrow()
  })

  test('accepts resize', () => {
    const r = BGRequestSchema.parse({
      proto: 1,
      op: 'resize',
      short: 'abcd1234',
      cols: 100,
      rows: 30,
    })
    if (r.op !== 'resize') throw new Error('op mismatch')
    expect(r.cols).toBe(100)
  })

  test('accepts ensure-spare', () => {
    const r = BGRequestSchema.parse({
      proto: 1,
      op: 'ensure-spare',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    })
    if (r.op !== 'ensure-spare') throw new Error('op mismatch')
    expect(r.cwd).toBe('/tmp')
  })

  test('accepts permission-response (allow)', () => {
    const r = BGRequestSchema.parse({
      proto: 1,
      op: 'permission-response',
      auth: 'k',
      short: 'abcd1234',
      decision: 'allow',
    })
    if (r.op !== 'permission-response') throw new Error('op mismatch')
    expect(r.decision).toBe('allow')
  })

  test('accepts permission-response (deny with reason)', () => {
    const r = BGRequestSchema.parse({
      proto: 1,
      op: 'permission-response',
      auth: 'k',
      short: 'abcd1234',
      decision: 'deny',
      reason: 'not allowed',
    })
    if (r.op !== 'permission-response') throw new Error('op mismatch')
    expect(r.reason).toBe('not allowed')
  })

  test('rejects permission-response with bad decision', () => {
    expect(() =>
      BGRequestSchema.parse({
        proto: 1,
        op: 'permission-response',
        auth: 'k',
        short: 'abcd1234',
        decision: 'maybe',
      }),
    ).toThrow()
  })

  test('accepts respawn-stale', () => {
    const r = BGRequestSchema.parse({
      proto: 1,
      op: 'respawn-stale',
      short: 'abcd1234',
    })
    if (r.op !== 'respawn-stale') throw new Error('op mismatch')
    expect(String(r.short)).toBe('abcd1234')
  })

  test('accepts shutdown', () => {
    const r = BGRequestSchema.parse({ proto: 1, op: 'shutdown' })
    if (r.op !== 'shutdown') throw new Error('op mismatch')
  })

  test('accepts shutdown with reapWorkers', () => {
    const r = BGRequestSchema.parse({
      proto: 1,
      op: 'shutdown',
      reapWorkers: true,
    })
    if (r.op !== 'shutdown') throw new Error('op mismatch')
    expect(r.reapWorkers).toBe(true)
  })
})

// ---------- JobLaunchSpec ----------

describe('JobLaunchSpecSchema — launch field union', () => {
  const outerBase = {
    proto: 1,
    short: 'abcd1234',
    nonce: '12345678',
    sessionId: 'sess-1',
    createdAt: 1700000000000,
    source: 'shell' as const,
    cwd: '/tmp',
    env: { FOO: 'bar' },
    isolation: 'none' as const,
    respawnFlags: [],
  }

  test('accepts prompt mode', () => {
    const j = JobLaunchSpecSchema.parse({
      ...outerBase,
      launch: { mode: 'prompt', args: ['hi'] },
    })
    if (j.launch.mode !== 'prompt') throw new Error('mode mismatch')
    expect(j.launch.args).toEqual(['hi'])
  })

  test('accepts resume mode', () => {
    const j = JobLaunchSpecSchema.parse({
      ...outerBase,
      launch: {
        mode: 'resume',
        sessionId: 'sess-1',
        fork: false,
        flagArgs: ['--no-color'],
      },
    })
    if (j.launch.mode !== 'resume') throw new Error('mode mismatch')
    expect(j.launch.sessionId).toBe('sess-1')
    expect(j.launch.fork).toBe(false)
    expect(j.launch.flagArgs).toEqual(['--no-color'])
  })

  test('accepts exec mode', () => {
    const j = JobLaunchSpecSchema.parse({
      ...outerBase,
      launch: { mode: 'exec', cmd: 'npm', args: ['test'] },
    })
    if (j.launch.mode !== 'exec') throw new Error('mode mismatch')
    expect(j.launch.cmd).toBe('npm')
  })

  test('rejects unknown mode', () => {
    expect(() =>
      JobLaunchSpecSchema.parse({
        ...outerBase,
        launch: { mode: 'repl', args: [] },
      }),
    ).toThrow()
  })

  test('rejects prompt mode missing args', () => {
    expect(() =>
      JobLaunchSpecSchema.parse({
        ...outerBase,
        launch: { mode: 'prompt' },
      }),
    ).toThrow()
  })

  test('rejects resume mode missing fork', () => {
    expect(() =>
      JobLaunchSpecSchema.parse({
        ...outerBase,
        launch: { mode: 'resume', sessionId: 's', flagArgs: [] },
      }),
    ).toThrow()
  })
})

describe('JobLaunchSpecSchema — outer shared fields', () => {
  const validBase = {
    proto: 1,
    short: 'abcd1234',
    nonce: '12345678',
    sessionId: 'sess-1',
    createdAt: 1700000000000,
    source: 'shell' as const,
    cwd: '/tmp',
    launch: { mode: 'prompt' as const, args: ['hi'] },
    env: { FOO: 'bar' },
    isolation: 'none' as const,
    respawnFlags: [],
  }

  test('parses full canonical dispatch payload', () => {
    expect(JobLaunchSpecSchema.parse(validBase)).toBeTruthy()
  })

  test('rejects missing proto', () => {
    const { proto, ...rest } = validBase
    expect(() => JobLaunchSpecSchema.parse(rest)).toThrow()
  })

  test('rejects missing short', () => {
    const { short, ...rest } = validBase
    expect(() => JobLaunchSpecSchema.parse(rest)).toThrow()
  })

  test('rejects invalid short format', () => {
    expect(() => JobLaunchSpecSchema.parse({ ...validBase, short: 'XYZ' })).toThrow()
  })

  test('rejects unknown source', () => {
    expect(() =>
      JobLaunchSpecSchema.parse({ ...validBase, source: 'unknown' }),
    ).toThrow()
  })

  test('rejects unknown isolation', () => {
    expect(() =>
      JobLaunchSpecSchema.parse({ ...validBase, isolation: 'docker' }),
    ).toThrow()
  })

  test('accepts optional worktree', () => {
    expect(() =>
      JobLaunchSpecSchema.parse({
        ...validBase,
        worktree: { path: '/wt', ownershipToken: 'tok' },
      }),
    ).not.toThrow()
  })

  test('accepts optional seed', () => {
    expect(() =>
      JobLaunchSpecSchema.parse({
        ...validBase,
        seed: { intent: 'fix bug', name: 'fix-bug-1' },
      }),
    ).not.toThrow()
  })

  test('accepts optional cols/rows', () => {
    expect(() =>
      JobLaunchSpecSchema.parse({ ...validBase, cols: 80, rows: 24 }),
    ).not.toThrow()
  })
})

// ---------- Response schemas ----------

describe('BGResponseErrSchema', () => {
  test('accepts a minimal error response', () => {
    const r = BGResponseErrSchema.parse({
      ok: false,
      error: 'bad proto',
      code: 'EPROTO',
    })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('EPROTO')
  })

  test('accepts an error with optional serverProto context', () => {
    const r = BGResponseErrSchema.parse({
      ok: false,
      error: 'proto skew',
      code: 'EPROTO',
      serverProto: 2,
      serverVersion: '2.1.178',
    })
    expect(r.serverProto).toBe(2)
    expect(r.serverVersion).toBe('2.1.178')
  })

  test('rejects ok:true branch', () => {
    expect(() =>
      BGResponseErrSchema.parse({ ok: true, error: 'x', code: 'EPROTO' }),
    ).toThrow()
  })

  test('rejects unknown error code', () => {
    expect(() =>
      BGResponseErrSchema.parse({
        ok: false,
        error: 'x',
        code: 'ENOTREAL',
      }),
    ).toThrow()
  })
})

describe('BGResponseOkSchema', () => {
  test('accepts a simple ping response', () => {
    const r = BGResponseOkSchema.parse({ ok: true, op: 'ping' })
    expect(r.ok).toBe(true)
    expect(r.op).toBe('ping')
  })

  test('accepts a kill response', () => {
    const r = BGResponseOkSchema.parse({ ok: true, op: 'kill' })
    expect(r.op).toBe('kill')
  })

  test('accepts a has response with present + ready', () => {
    const r = BGResponseOkSchema.parse({
      ok: true,
      op: 'has',
      short: 'abcd1234',
      present: true,
      ready: true,
    })
    if (r.op !== 'has') throw new Error('op mismatch')
    expect(r.present).toBe(true)
    expect(r.ready).toBe(true)
  })

  test('accepts a list response with jobs array', () => {
    const r = BGResponseOkSchema.parse({
      ok: true,
      op: 'list',
      jobs: [],
    })
    if (r.op !== 'list') throw new Error('op mismatch')
    expect(r.jobs).toEqual([])
  })

  test('accepts a leases response with clients array', () => {
    const r = BGResponseOkSchema.parse({
      ok: true,
      op: 'leases',
      clients: [],
    })
    if (r.op !== 'leases') throw new Error('op mismatch')
    expect(r.clients).toEqual([])
  })

  test('rejects ok:false', () => {
    expect(() =>
      BGResponseOkSchema.parse({ ok: false, op: 'ping' }),
    ).toThrow()
  })

  // Issue #2: minimal ops stay minimal; extras ops require extras.
  test('rejects list response without jobs array', () => {
    expect(() =>
      BGResponseOkSchema.parse({ ok: true, op: 'list' }),
    ).toThrow(/expected array.*received undefined|Jobs/i)
  })

  test('rejects leases response without clients array', () => {
    expect(() =>
      BGResponseOkSchema.parse({ ok: true, op: 'leases' }),
    ).toThrow(/expected array.*received undefined|clients/i)
  })

  test('rejects has response without present/ready', () => {
    expect(() =>
      BGResponseOkSchema.parse({ ok: true, op: 'has', short: 'abcd1234' }),
    ).toThrow()
  })

  test('rejects has response with non-boolean present', () => {
    expect(() =>
      BGResponseOkSchema.parse({
        ok: true,
        op: 'has',
        short: 'abcd1234',
        present: 'yes',
        ready: true,
      }),
    ).toThrow()
  })

  test('accepts dispatch as minimal {ok, op}', () => {
    const r = BGResponseOkSchema.parse({ ok: true, op: 'dispatch' })
    expect(r.ok).toBe(true)
    expect(r.op).toBe('dispatch')
  })

  test('accepts attach as minimal {ok, op}', () => {
    const r = BGResponseOkSchema.parse({ ok: true, op: 'attach' })
    expect(r.op).toBe('attach')
  })

  test('accepts shutdown as minimal {ok, op}', () => {
    const r = BGResponseOkSchema.parse({ ok: true, op: 'shutdown' })
    expect(r.op).toBe('shutdown')
  })
})

describe('BGResponseSchema (union)', () => {
  test('accepts ok:true branch', () => {
    expect(BGResponseSchema.parse({ ok: true, op: 'ping' }).ok).toBe(true)
  })

  test('accepts ok:false branch', () => {
    const r = BGResponseSchema.parse({
      ok: false,
      error: 'bad',
      code: 'EAUTH',
    })
    if (r.ok) throw new Error('expected err')
    expect(r.code).toBe('EAUTH')
  })

  test('rejects ok:undefined', () => {
    expect(() => BGResponseSchema.parse({ op: 'ping' })).toThrow()
  })
})