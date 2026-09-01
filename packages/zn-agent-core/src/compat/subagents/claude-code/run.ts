import process from 'node:process'
import {
  spawnSubprocess,
  type SubprocessHandle,
} from '../../subprocess/index.js'
import type {
  SubagentRequest,
  SubagentContext,
  SubagentResult,
  SubagentRun,
} from '../registry.js'
import {
  CLAUDE_OUTPUT_FORMAT,
  type ClaudePermissionMode,
  type ClaudeSpawnArgs,
  type ClaudeStreamEvent,
} from './wire.js'
import {
  failClaudeCode,
} from './invariant.js'
import { resolveFinalAnswer, stopReasonFromClaudeResult } from './result.js'
import {
  createCliRunShell,
  toMessage,
  type CliRunShell,
} from '../cliAgent/runShell.js'
import { defaultCliRunId } from '../cliAgent/ids.js'

/**
 * Compute the argv for spawning `claude --print` against a one-shot prompt.
 *
 * Mirrors the deepseek-harness `claude-code` provider's contract: parent
 * cwd is propagated, foreground-only, `--print` (non-interactive) is
 * required, output format follows the deployment's `config.outputFormat`,
 * permission mode follows `config.permissionMode`. Persist-session,
 * settingSources, MCP-config, hooks etc. are NOT carried by this provider
 * — the deployment's native `~/.claude/` is the only state we read.
 */
export function claudeSpawnArgv(
  command: string,
  args: readonly string[],
  spec: ClaudeSpawnArgs,
): { command: string; args: string[] } {
  const finalArgs: string[] = [...args]
  // Upstream Claude Code CLI requires `--verbose` whenever
  // `--output-format stream-json` is requested; without it the child
  // rejects the run before any assistant frame and the provider settles
  // with "produced no assistant messages before settling".
  if (
    spec.outputFormat === CLAUDE_OUTPUT_FORMAT.streamJson &&
    !finalArgs.includes('--verbose')
  ) {
    finalArgs.push('--verbose')
  }
  finalArgs.push('--permission-mode', spec.permissionMode)
  if (spec.model) {
    finalArgs.push('--model', spec.model)
  }
  // The prompt is positional and must be the LAST argument. Append last.
  finalArgs.push('--', spec.prompt)
  return { command, args: finalArgs }
}

/**
 * Drive one Claude Code CLI one-shot delegation end-to-end.
 *
 *   1. Spawn the OS process through {@link spawnSubprocess}.
 *   2. Read stdout line-by-line (json / stream-json flavor).
 *   3. Forward each parsed frame as a {@link SubagentEvent}.
 *   4. Wait for the canonical `result` event (stream-json) or the single
 *      final-frame (json), then resolve.
 *   5. Tear down via `handle.killTree()` on cancel / failure.
 *
 * Returns a {@link SubagentRun} whose `events` is the streaming line iterator
 * and whose `result` resolves with the final text. `cancel()` best-effort
 * kills the OS tree so the bridge's barrier can unwind.
 */
export async function startClaudeCodeRun(
  request: SubagentRequest,
  ctx: SubagentContext,
  spec: ClaudeRunSpec,
): Promise<SubagentRun> {
  const cwd = request.cwd ?? ctx.parentCwd
  if (!cwd) {
    throw failClaudeCode('no cwd for child', 'pass request.cwd or a parent session cwd')
  }
  if (!request.prompt.trim()) {
    throw failClaudeCode(
      'refusing empty prompt',
      'prompt must be a non-empty string',
    )
  }

  const spawnSpec: ClaudeSpawnArgs = {
    prompt: request.prompt,
    cwd,
    outputFormat: spec.outputFormat,
    permissionMode: spec.permissionMode,
    // dsh parity: per-call model already resolved by the provider
    // (`req.model ?? config.model`); request.env-style last-write-wins here.
    ...(spec.model ? { model: spec.model } : {}),
  }

  const { command, args } = claudeSpawnArgv(
    spec.command,
    spec.args,
    spawnSpec,
  )

  const handle: SubprocessHandle = spawnSubprocess({
    command,
    args,
    cwd,
    env: { ...(spec.env ?? {}), ...(request.env ?? {}) },
    signal: request.signal,
  })

  // The same producer/consumer shape as dsh/run.ts: declare cancellable
  // promise, then drive the pump on a microtask so startClaudeCodeRun
  // returns the handle to the caller immediately.
  const { run, finalizeResult, finalizeError, internal } = createCliRunShell(
    handle,
    { id: defaultCliRunId('opencc') },
  )

  void pumpClaudeStream({
    handle,
    outputFormat: spec.outputFormat,
    internal,
    finalizeResult,
    finalizeError,
  }).catch((err: unknown) => {
    finalizeError(toMessage(err))
  })

  return run
}

/** Deployable knobs for one Claude Code child run. */
export interface ClaudeRunSpec {
  disposeGraceMs: number
  command: string
  args: readonly string[]
  outputFormat: 'json' | 'stream-json' | 'text'
  permissionMode: ClaudePermissionMode
  /** Resolved child model (`request.model ?? config.model`); omit for CLI default. */
  model?: string
  env?: Readonly<Record<string, string>>
}

interface PumpArgs {
  handle: SubprocessHandle
  outputFormat: 'json' | 'stream-json' | 'text'
  internal: CliRunShell['internal']
  finalizeResult: (r: SubagentResult) => void
  finalizeError: (message: string) => void
}

async function pumpClaudeStream({
  handle,
  outputFormat,
  internal,
  finalizeResult,
}: PumpArgs): Promise<void> {
  // For `json`, the cli emits exactly ONE frame on stdout. Buffer the whole
  // thing, parse on close, emit a single SubagentEvent, then resolve.
  if (outputFormat === CLAUDE_OUTPUT_FORMAT.json) {
    let buf = ''
    return new Promise<void>((resolve, reject) => {
      handle.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
      })
      handle.stdout.on('end', () => {
        try {
          const parsed = JSON.parse(buf.trim()) as { type?: string; result?: unknown; is_error?: boolean; error?: string; usage?: { input_tokens?: number; output_tokens?: number } }
          internal.pushEvent({
            type: 'json_result',
            text: typeof parsed.result === 'string' ? parsed.result : '',
            raw: parsed,
          })
          const mapped = stopReasonFromClaudeResult(parsed)
          if (mapped.stopReason !== 'completed') {
            finalizeResult({
              text: '',
              stopReason: 'error',
              errorMessage: mapped.errorMessage,
              ...(mapped.diagnostic !== undefined ? { diagnostic: mapped.diagnostic } : {}),
            })
            resolve()
            return
          }
          finalizeResult({
            text: typeof parsed.result === 'string' ? parsed.result.trim() : '',
            stopReason: 'completed',
          })
          resolve()
        } catch (err) {
          reject(err)
        }
      })
      handle.stdout.on('error', (err) => reject(err))
    })
  }

  // stream-json / text: line-delimited. Each line is either JSON or text;
  // we project to SubagentEvent with `type` derived from the parsed frame
  // (assistant / tool_use / tool_result / result / system).
  return new Promise<void>((resolve, reject) => {
    let buf = ''
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }
    const finish = () => {
      const resolved = resolveFinalAnswer(internal.events, 'stream-json')
      if (resolved.stopReason === 'completed') {
        finalizeResult({ text: resolved.text, stopReason: 'completed' })
      } else {
        finalizeResult({
          text: '',
          stopReason: 'error',
          errorMessage: resolved.errorMessage,
          ...(resolved.diagnostic !== undefined ? { diagnostic: resolved.diagnostic } : {}),
        })
      }
      settle(resolve)
    }
    handle.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        if (outputFormat === CLAUDE_OUTPUT_FORMAT.text) {
          internal.pushEvent({ type: 'assistant', text: line, raw: line })
          continue
        }
        let frame: ClaudeStreamEvent | { type: string; [k: string]: unknown }
        try {
          frame = JSON.parse(line) as ClaudeStreamEvent
        } catch {
          // Tolerate stray lines — they're rare and uninformative.
          continue
        }
        const t = typeof frame.type === 'string' ? frame.type : 'unknown'
        if (t === 'assistant') {
          // The assistant frame's text lives on `.message.content[].text`
          // for SDK style; simpler shim: stringify the whole frame and
          // accept that the test fixture emits text directly.
          const text =
            typeof (frame as unknown as { message?: unknown }).message === 'string'
              ? ((frame as unknown) as { message: string }).message
              : extractAssistantText(frame as unknown as ClaudeStreamEvent)
          internal.pushEvent({ type: 'assistant', text, raw: frame })
        } else if (t === 'tool_use' || t === 'tool_result' || t === 'user' || t === 'system' || t === 'result') {
          const text =
            typeof (frame as unknown as { content?: unknown }).content === 'string'
              ? ((frame as unknown) as { content: string }).content
              : ''
          internal.pushEvent({ type: t, text, raw: frame })
        } else {
          internal.pushEvent({ type: t, raw: frame })
        }
      }
    })
    handle.stdout.on('end', () => {
      finish()
    })
    handle.stdout.on('error', (err) => {
      settle(() => reject(err))
    })
  })
}

function extractAssistantText(frame: ClaudeStreamEvent): string {
  const f = frame as {
    text?: unknown
    content?: unknown
    message?: { content?: unknown }
  }
  if (typeof f.text === 'string') return f.text
  if (typeof f.content === 'string') return f.content
  if (Array.isArray(f.content)) {
    return f.content
      .map((c) => {
        if (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string') {
          return (c as { text: string }).text
        }
        return ''
      })
      .filter(Boolean)
      .join('')
  }
  if (f.message && Array.isArray(f.message.content)) {
    return f.message.content
      .map((c) => {
        if (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string') {
          return (c as { text: string }).text
        }
        return ''
      })
      .filter(Boolean)
      .join('')
  }
  return ''
}

// Avoid `process` being unused when nothing on this file references it.
void process
