/**
 * Bg daemon IPC protocol — frame codec + zod schemas.
 *
 * Ported verbatim from upstream OpenCC 2.1.177. Wire format and field
 * names are part of the cross-process contract; any drift triggers `EPROTO`
 * once a client connects to a server built from this module.
 *
 * Wire format:
 *   [u32 BE length][u8 kind][body]
 *
 * `kind: 0` = payload frame (zod-validated JSON request/response)
 * `kind: 1` = ctrl frame (reserved for future use)
 *
 * Maximum frame size is 1 MiB (1_048_576 bytes). Anything larger is rejected.
 *
 * @see docs/superpowers/plans/2026-06-13-plan-bg-agent-view.md §T2
 */
import { z } from 'zod/v4'

// ---------- Constants ----------

export const BG_PROTO = 1
/** Maximum frame body size, in bytes (1 MiB). */
export const BG_MAX_FRAME_BYTES = 1_048_576

// ---------- Frame codec ----------

/**
 * On-wire frame kind bytes. Anything other than 0/1 in the kind slot is
 * treated as a fatal protocol error by {@link FrameReader}.
 */
export const FRAME_KIND = {payload: 0, ctrl: 1} as const

/** Frame kind: 0 = payload (JSON), 1 = ctrl (reserved). */
export type FrameKind = (typeof FRAME_KIND)[keyof typeof FRAME_KIND]

export interface Frame {
  kind: FrameKind
  body: Buffer
}

/**
 * Serialize a single frame to its on-wire byte representation.
 *
 * Layout: 4-byte big-endian body length, 1-byte kind, then the body bytes.
 * The body buffer is consumed as-is (no copy).
 */
export function encodeFrame(frame: Frame): Buffer {
  const header = Buffer.alloc(5)
  header.writeUInt32BE(frame.body.length, 0)
  header.writeUInt8(frame.kind, 4)
  return Buffer.concat([header, frame.body])
}

/**
 * Serialize multiple frames into a single concatenated buffer.
 *
 * Equivalent to `Buffer.concat(frames.map(encodeFrame))` but expresses intent.
 */
export function encodeFrames(frames: Frame[]): Buffer {
  return Buffer.concat(frames.map(encodeFrame))
}

/**
 * Stateful reader that turns a stream of arbitrary chunks into discrete frames.
 *
 * Feed bytes as they arrive; the reader buffers internally and emits complete
 * frames via the callback. Incomplete headers and partial bodies are held in
 * state until the next chunk arrives. Frames whose declared length exceeds
 * {@link BG_MAX_FRAME_BYTES} cause a synchronous throw — callers should treat
 * that as a fatal protocol error and disconnect.
 */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0)
  constructor(private readonly onFrame: (frame: Frame) => void) {}

  /** Add bytes to the internal buffer and emit any frames that complete. */
  feed(chunk: Buffer): void {
    if (chunk.length === 0) return
    this.buffer =
      this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    // Drain as many frames as the current buffer holds.
    while (this.tryReadFrame()) {
      /* loop */
    }
  }

  private tryReadFrame(): boolean {
    if (this.buffer.length < 5) return false
    const len = this.buffer.readUInt32BE(0)
    if (len > BG_MAX_FRAME_BYTES) {
      throw new Error(`frame too large: ${len} bytes (max ${BG_MAX_FRAME_BYTES})`)
    }
    if (this.buffer.length < 5 + len) return false
    const kindByte = this.buffer.readUInt8(4)
    if (kindByte !== FRAME_KIND.payload && kindByte !== FRAME_KIND.ctrl) {
      throw new Error(
        `frame kind byte must be ${FRAME_KIND.payload} (payload) or ${FRAME_KIND.ctrl} (ctrl), got ${kindByte}`,
      )
    }
    const kind = kindByte as FrameKind
    // Copy the body out so the caller can retain it past the next `feed()`.
    const body = Buffer.from(this.buffer.subarray(5, 5 + len))
    this.buffer = this.buffer.subarray(5 + len)
    this.onFrame({ kind, body })
    return true
  }
}

// ---------- JobShortId brand ----------

export const JOB_SHORT_ID_REGEX = /^[a-f0-9]{8}$/

export const JobShortIdSchema = z
  .string()
  .regex(JOB_SHORT_ID_REGEX, 'must be 8 lowercase hex chars')
  .brand<'JobShortId'>()

export type JobShortId = z.infer<typeof JobShortIdSchema>

// ---------- Error codes ----------

export const ErrorCodeSchema = z.enum([
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
])

export type ErrorCode = z.infer<typeof ErrorCodeSchema>

// ---------- Job launch spec ----------

export const JobSourceSchema = z.enum([
  'shell',
  'slash',
  'fleet',
  'spare',
  'respawn',
])

export type JobSource = z.infer<typeof JobSourceSchema>

export const IsolationSchema = z.enum(['none', 'worktree'])

export type Isolation = z.infer<typeof IsolationSchema>

/**
 * `dispatch` carries a `JobLaunchSpec` — the **outer shared envelope** that
 * wraps a 3-mode `launch` discriminated union (prompt / resume / exec).
 *
 * Outer fields (proto, short, nonce, sessionId, createdAt, source, cwd,
 * env, isolation, respawnFlags) are shared by all dispatch payloads; the
 * `launch` field holds the mode-specific payload. Optional fields
 * (reattachEnv, worktree, attachStallRespawns, agent, routine, seed, cols,
 * rows) are filled in by the caller when relevant and ignored by the
 * daemon otherwise.
 *
 * Field names match upstream 2.1.177 verbatim.
 */
const LaunchSpecSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('prompt'),
    args: z.array(z.string()),
  }),
  z.object({
    mode: z.literal('resume'),
    sessionId: z.string(),
    fork: z.boolean(),
    flagArgs: z.array(z.string()),
  }),
  z.object({
    mode: z.literal('exec'),
    cmd: z.string(),
    args: z.array(z.string()),
  }),
])

export const JobLaunchSpecSchema = z.object({
  proto: z.literal(BG_PROTO),
  short: JobShortIdSchema,
  nonce: z.string(),
  sessionId: z.string(),
  createdAt: z.number(),
  source: JobSourceSchema,
  cwd: z.string(),
  launch: LaunchSpecSchema,
  env: z.record(z.string(), z.string()),
  reattachEnv: z.record(z.string(), z.string()).optional(),
  worktree: z
    .object({ path: z.string(), ownershipToken: z.string() })
    .optional(),
  isolation: IsolationSchema,
  respawnFlags: z.array(z.string()),
  attachStallRespawns: z.number().optional(),
  agent: z.string().optional(),
  routine: z.string().optional(),
  seed: z.object({ intent: z.string(), name: z.string().optional() }).optional(),
  cols: z.number().optional(),
  rows: z.number().optional(),
})

export type JobLaunchSpec = z.infer<typeof JobLaunchSpecSchema>

// ---------- Job record (returned by `list`) ----------

export const JobRecordSchema = z.object({
  short: JobShortIdSchema,
  nonce: z.string(),
  sessionId: z.string(),
  source: JobSourceSchema,
  cwd: z.string(),
  createdAt: z.number(),
  isolation: IsolationSchema,
  agent: z.string().optional(),
  routine: z.string().optional(),
  /** Set true when the job is being killed or retired. */
  dying: z.boolean().optional(),
})

export type JobRecord = z.infer<typeof JobRecordSchema>

// ---------- Lease client (returned by `leases`) ----------

export const LeaseClientSchema = z.object({
  label: z.string(),
  cwd: z.string(),
  pid: z.number(),
  registeredAt: z.number(),
})

export type LeaseClient = z.infer<typeof LeaseClientSchema>

// ---------- Per-op request schemas ----------

const proto = z.literal(BG_PROTO)

const PingSchema = z.object({ proto, op: z.literal('ping') })
const NudgeSchema = z.object({ proto, op: z.literal('nudge') })
const YieldSchema = z.object({ proto, op: z.literal('yield') })

const LeaseSchema = z.object({
  proto,
  op: z.literal('lease'),
  label: z.string(),
  cwd: z.string(),
  pid: z.number(),
})

const LeasesSchema = z.object({ proto, op: z.literal('leases') })

const AwaitAckSchema = z.object({
  proto,
  op: z.literal('await-ack'),
  short: JobShortIdSchema,
  timeoutMs: z.number(),
})

const DispatchSchema = z.object({
  proto,
  op: z.literal('dispatch'),
  auth: z.string(),
  job: JobLaunchSpecSchema,
})

const ListSchema = z.object({ proto, op: z.literal('list') })

const HasSchema = z.object({
  proto,
  op: z.literal('has'),
  short: JobShortIdSchema,
})

const KillSchema = z.object({
  proto,
  op: z.literal('kill'),
  short: JobShortIdSchema,
  signal: z.enum(['SIGTERM', 'SIGKILL']).optional(),
})

const ReplySchema = z.object({
  proto,
  op: z.literal('reply'),
  auth: z.string(),
  short: JobShortIdSchema,
  text: z.string(),
})

const SubscribeSchema = z.object({
  proto,
  op: z.literal('subscribe'),
  short: JobShortIdSchema,
  tail: z.number().optional(),
})

const AttachSchema = z.object({
  proto,
  op: z.literal('attach'),
  auth: z.string(),
  short: JobShortIdSchema,
  cols: z.number(),
  rows: z.number(),
  attachId: z.string(),
})

const ResizeSchema = z.object({
  proto,
  op: z.literal('resize'),
  short: JobShortIdSchema,
  cols: z.number(),
  rows: z.number(),
})

const EnsureSpareSchema = z.object({
  proto,
  op: z.literal('ensure-spare'),
  cwd: z.string(),
  cols: z.number(),
  rows: z.number(),
})

const PermissionResponseSchema = z.object({
  proto,
  op: z.literal('permission-response'),
  auth: z.string(),
  short: JobShortIdSchema,
  decision: z.enum(['allow', 'deny', 'ask']),
  reason: z.string().optional(),
})

const RespawnStaleSchema = z.object({
  proto,
  op: z.literal('respawn-stale'),
  short: JobShortIdSchema,
})

const ShutdownSchema = z.object({
  proto,
  op: z.literal('shutdown'),
  reapWorkers: z.boolean().optional(),
})

// `inbox` — drain pending daemon-to-client messages (bg-agent
// completions, kills, etc.) since the last ack cursor. Each call
// returns messages with id > `ackThrough` and updates the server-side
// ack cursor to `highestId`. New in this port (not in upstream 2.1.177).
//
// `clientId` is required: identifies which REPL session is asking
// (port-specific OpenCC extension; upstream uses appState.inbox which
// is implicit). The daemon only returns messages belonging to this
// client; bg-agent events from other opencc sessions are NOT leaked.
const InboxSchema = z.object({
  proto,
  op: z.literal('inbox'),
  clientId: z.string().min(1),
  /** Return only messages with id > ackThrough. Default 0 = all. */
  ackThrough: z.number().int().nonnegative().optional(),
})

/**
 * Discriminated union of all 18 IPC ops.
 *
 * Field names match upstream 2.1.177 verbatim. Adding an op without
 * coordinating with the daemon's response schema is a wire-format break.
 */
export const BGRequestSchema = z.discriminatedUnion('op', [
  PingSchema,
  NudgeSchema,
  YieldSchema,
  LeaseSchema,
  LeasesSchema,
  AwaitAckSchema,
  DispatchSchema,
  ListSchema,
  HasSchema,
  KillSchema,
  ReplySchema,
  SubscribeSchema,
  AttachSchema,
  ResizeSchema,
  EnsureSpareSchema,
  PermissionResponseSchema,
  RespawnStaleSchema,
  ShutdownSchema,
  InboxSchema,
])

export type BGRequest = z.infer<typeof BGRequestSchema>

export type BGRequestOp = BGRequest['op']

// ---------- Response schemas ----------

/**
 * Success-branch response. Each op-specific shape unions with a base
 * `{ok:true, op}` so unknown ops are rejected by the literal op field.
 *
 * The 3 ops with extras (`list` → jobs, `leases` → clients, `has` →
 * short/present/ready) are listed explicitly. The remaining 15 ops
 * collapse to a single minimal `{ok:true, op}` shape via `BGBaseOkShape`.
 */
const BGBaseOkShape = { ok: z.literal(true) } as const

export const BGResponseOkSchema = z.discriminatedUnion('op', [
  z.object({ ...BGBaseOkShape, op: z.literal('ping') }),
  z.object({ ...BGBaseOkShape, op: z.literal('nudge') }),
  z.object({ ...BGBaseOkShape, op: z.literal('yield') }),
  z.object({ ...BGBaseOkShape, op: z.literal('lease') }),
  z.object({
    ...BGBaseOkShape,
    op: z.literal('leases'),
    clients: z.array(LeaseClientSchema),
  }),
  z.object({ ...BGBaseOkShape, op: z.literal('await-ack') }),
  z.object({ ...BGBaseOkShape, op: z.literal('dispatch') }),
  z.object({
    ...BGBaseOkShape,
    op: z.literal('list'),
    jobs: z.array(JobRecordSchema),
  }),
  z.object({
    ...BGBaseOkShape,
    op: z.literal('has'),
    short: JobShortIdSchema,
    present: z.boolean(),
    ready: z.boolean(),
  }),
  z.object({ ...BGBaseOkShape, op: z.literal('kill') }),
  z.object({ ...BGBaseOkShape, op: z.literal('reply') }),
  z.object({ ...BGBaseOkShape, op: z.literal('subscribe') }),
  z.object({ ...BGBaseOkShape, op: z.literal('attach') }),
  z.object({ ...BGBaseOkShape, op: z.literal('resize') }),
  z.object({ ...BGBaseOkShape, op: z.literal('ensure-spare') }),
  z.object({ ...BGBaseOkShape, op: z.literal('permission-response') }),
  z.object({ ...BGBaseOkShape, op: z.literal('respawn-stale') }),
  z.object({ ...BGBaseOkShape, op: z.literal('shutdown') }),
  z.object({
    ...BGBaseOkShape,
    op: z.literal('inbox'),
    messages: z.array(
      z.discriminatedUnion('type', [
        z.object({type: z.literal('idle_notification')}).passthrough(),
        z.object({type: z.literal('task_completed')}).passthrough(),
      ]),
    ),
    highestId: z.number(),
  }),
])

export type BGResponseOk = z.infer<typeof BGResponseOkSchema>

/** Convenience: ops whose success response carries extras beyond `{ok, op}`. */
export type BGResponseExtras = 'leases' | 'list' | 'has'

export type BGResponseOkPayload<Op extends BGRequestOp = BGRequestOp> =
  Op extends BGResponseExtras ? BGResponseOk & {op: Op} : {ok: true; op: Op}

/**
 * Failure-branch response. `error` is human-readable; `code` is the
 * machine-readable enum. `serverProto` and `serverVersion` are populated
 * for `EPROTO` so the client can diagnose a version skew without parsing
 * free-form text.
 */
export const BGResponseErrSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  code: ErrorCodeSchema,
  serverProto: z.number().optional(),
  serverVersion: z.string().optional(),
})

export type BGResponseErr = z.infer<typeof BGResponseErrSchema>

export const BGResponseSchema = z.union([BGResponseOkSchema, BGResponseErrSchema])

export type BGResponse = z.infer<typeof BGResponseSchema>