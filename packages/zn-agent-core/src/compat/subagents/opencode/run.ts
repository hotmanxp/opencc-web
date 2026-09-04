import {
  spawnSubprocess,
  type SubprocessHandle,
} from '../../subprocess/index.js'
import type {
  SubagentEvent,
  SubagentRequest,
  SubagentContext,
  SubagentResult,
  SubagentRun,
} from '../registry.js'
import { toMessage } from '../cliAgent/runShell.js'
import { defaultCliRunId } from '../cliAgent/ids.js'
import type { OpencodeSpawnArgs } from './wire.js'
import {
  collectOpencodeAnswerParts,
  opencodeLineToEvents,
  resolveOpencodeAnswer,
} from './result.js'
import { failOpencode } from './invariant.js'

/**
 * Hardcoded deployment providers (per `~/.config/opencode/opencode.json`).
 * `pa` serves the `zhiniao-*` model family; everything else routes through
 * the OpenPlatform OAuth2 gateway.
 */
const PA_PROVIDER = 'pa'
const OPEN_PLATFORM_PROVIDER = 'OpenPlatformOAuth2'

/**
 * Normalize a caller-supplied model into the `provider/model` form the
 * opencode CLI's `-m` flag expects.
 *
 * SpawnAgent's `model` param arrives as a bare model id (e.g. `glm-5.2`,
 * `zhiniao-glm-5.1`); passing that raw to `opencode run -m` fails model
 * resolution (the CLI only knows `<provider>/<model>` ids). Routing rule
 * (2026-09-04, operator decision):
 *  - already contains `/`   → pass through (explicit provider wins)
 *  - starts with `zhiniao-` → `pa/<model>`
 *  - anything else          → `OpenPlatformOAuth2/<model>`
 */
export function normalizeOpencodeModelArg(model: string): string {
  const trimmed = model.trim()
  if (!trimmed) return ''
  if (trimmed.includes('/')) return trimmed
  if (trimmed.startsWith('zhiniao-')) return `${PA_PROVIDER}/${trimmed}`
  return `${OPEN_PLATFORM_PROVIDER}/${trimmed}`
}

/**
 * Compute the argv for a one-shot `opencode run`.
 *
 * The cwd is carried by the spawned process's working directory (not a
 * `--dir` flag) so the child sees the delegating session's tree. The model is
 * an optional `-m provider/model` (normalized via
 * {@link normalizeOpencodeModelArg}); the prompt is positional and MUST be
 * last so a message that itself begins with a flag-looking token is not
 * consumed.
 */
export function opencodeSpawnArgv(
  command: string,
  args: readonly string[],
  spec: OpencodeSpawnArgs,
): { command: string; args: string[] } {
  const finalArgs: string[] = [...args]
  if (spec.model) {
    const normalized = normalizeOpencodeModelArg(spec.model)
    if (normalized) finalArgs.push('-m', normalized)
  }
  finalArgs.push(spec.prompt)
  return { command, args: finalArgs }
}

/** Deployable knobs for one opencode child run. */
export interface OpencodeRunSpec {
  disposeGraceMs: number
  command: string
  args: readonly string[]
  /** Resolved child model (`request.model ?? config.model`); omit → CLI default. */
  model?: string
  env?: Readonly<Record<string, string>>
}

interface OpencodeRunShell {
  run: SubagentRun
  finalizeResult(r: SubagentResult): void
  finalizeError(message: string): void
  internal: {
    events: SubagentEvent[]
    pushEvent(e: SubagentEvent): void
  }
}

/**
 * Local pending-run shell (mirrors `cliAgent/runShell.ts` but keeps the
 * provider's own `disposeGraceMs` in control of the tree-kill escalation).
 * Codex's `createPendingRun` is the precedent for a provider-local shell.
 */
function createOpencodeRunShell(
  handle: SubprocessHandle,
  opts: { id: string; disposeGraceMs: number; abortText: () => string },
): OpencodeRunShell {
  const events: SubagentEvent[] = []
  let resolveResult!: (value: SubagentResult) => void
  let rejectResult!: (reason: Error) => void
  const result = new Promise<SubagentResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  let finalized = false
  const finalizeResult = (r: SubagentResult): void => {
    if (finalized) return
    finalized = true
    resolveResult(r)
  }
  const finalizeError = (message: string): void => {
    if (finalized) return
    finalized = true
    rejectResult(new Error(message))
  }

  const cancel = async (): Promise<void> => {
    if (finalized) return
    finalized = true
    // Carry the partial answer best-effort (dsh parity), then settle aborted.
    resolveResult({
      text: opts.abortText(),
      stopReason: 'aborted',
      errorMessage: 'cancelled by caller',
    })
    try {
      await handle.killTree(opts.disposeGraceMs)
    } catch {
      // best-effort
    }
  }

  const run: SubagentRun = {
    id: opts.id,
    events: (async function* () {
      let i = 0
      while (true) {
        const next = await new Promise<SubagentEvent | 'DONE'>((res) => {
          const tick = () => {
            if (i < events.length) {
              res(events[i++]!)
              return
            }
            if (finalized) {
              res('DONE')
              return
            }
            setImmediate(tick)
          }
          tick()
        })
        if (next === 'DONE') return
        yield next
      }
    })(),
    result,
    cancel,
  }

  return {
    run,
    finalizeResult,
    finalizeError,
    internal: { events, pushEvent: (e) => events.push(e) },
  }
}

interface PumpArgs {
  handle: SubprocessHandle
  internal: OpencodeRunShell['internal']
  finalizeResult: (r: SubagentResult) => void
}

/** Bounded stderr tail so a noisy child can't grow the error string unbounded. */
const STDERR_TAIL_BYTES = 8 * 1024

async function pumpOpencodeStream({
  handle,
  internal,
  finalizeResult,
}: PumpArgs): Promise<void> {
  let buf = ''
  let stderrTail = ''

  handle.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES)
  })
  handle.stderr.on('error', () => {
    // Stderr faults are non-fatal for the run; the process result stands.
  })

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }
    const finish = async () => {
      // Drain any trailing partial line before resolving the terminal facts.
      const rest = buf.trim()
      if (rest) {
        for (const ev of opencodeLineToEvents(rest)) internal.pushEvent(ev)
        buf = ''
      }
      const exit = await handle.exitCode
      const mapped = resolveOpencodeAnswer(internal.events, {
        exitCode: exit.code,
        signal: exit.signal,
        stderrTail,
      })
      if (mapped.stopReason === 'completed') {
        finalizeResult({ text: mapped.text, stopReason: 'completed' })
      } else {
        finalizeResult({
          text: mapped.text,
          stopReason: mapped.stopReason,
          ...(mapped.errorMessage !== undefined ? { errorMessage: mapped.errorMessage } : {}),
          ...(mapped.diagnostic !== undefined ? { diagnostic: mapped.diagnostic } : {}),
        })
      }
      settle(() => resolve())
    }

    handle.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        for (const ev of opencodeLineToEvents(line)) internal.pushEvent(ev)
      }
    })
    handle.stdout.on('end', () => {
      void finish()
    })
    handle.stdout.on('error', (err) => {
      settle(() => reject(err))
    })
  })
}

/**
 * Drive one opencode CLI one-shot delegation end-to-end.
 *
 *   1. Spawn `opencode run --format json [-m model] <prompt>` in the child cwd.
 *   2. Read stdout line-by-line, projecting each frame to a SubagentEvent.
 *   3. On stdout close, await the exit code and fold events + process facts
 *      into a SubagentResult (see `resolveOpencodeAnswer`).
 *   4. `cancel()` settles aborted (carrying any partial answer) and tree-kills
 *      the child with the configured grace.
 */
export async function startOpencodeRun(
  request: SubagentRequest,
  ctx: SubagentContext,
  spec: OpencodeRunSpec,
): Promise<SubagentRun> {
  const cwd = request.cwd ?? ctx.parentCwd
  if (!cwd) {
    throw failOpencode('no cwd for child', 'pass request.cwd or a parent session cwd')
  }
  if (!request.prompt.trim()) {
    throw failOpencode('refusing empty prompt', 'prompt must be a non-empty string')
  }

  const { command, args } = opencodeSpawnArgv(spec.command, spec.args, {
    prompt: request.prompt,
    ...(spec.model ? { model: spec.model } : {}),
  })

  const handle: SubprocessHandle = spawnSubprocess({
    command,
    args,
    cwd,
    env: { ...(spec.env ?? {}), ...(request.env ?? {}) },
    signal: request.signal,
  })

  // `opencode run` treats an open stdin pipe as an additional prompt input
  // stream and blocks until EOF. We pass the prompt positionally and never
  // write stdin frames, so close it immediately — without this the child
  // hangs forever (stdout never emits, `pumpOpencodeStream` never settles).
  handle.stdin.end()

  const { run, finalizeResult, finalizeError, internal } = createOpencodeRunShell(
    handle,
    {
      id: defaultCliRunId('opencode'),
      disposeGraceMs: spec.disposeGraceMs,
      abortText: () => collectOpencodeAnswerParts(internal.events).join('\n').trim(),
    },
  )

  void pumpOpencodeStream({ handle, internal, finalizeResult }).catch(
    (err: unknown) => {
      finalizeError(toMessage(err))
    },
  )

  return run
}
