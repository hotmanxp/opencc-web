/**
 * BackgroundAgentTool — spawns a background agent via the bg daemon.
 *
 * The LLM can call this tool to fork a long-running agent that lives in the
 * bg daemon's roster (persists across CLI restarts, visible via
 * `claude bg-agents` and the in-REPL `/background` dialog). The LLM-side
 * tool name is `BackgroundAgent`; the IPC target is the
 * `dispatch` op on the daemon's loopback socket.
 *
 * Multi-agent parallel: this tool is intentionally a no-single-call-guard
 * tool. LLM can issue N parallel `BackgroundAgent` calls in a single turn
 * (Anthropic API supports parallel tool_use). Each call becomes an
 * independent `JobRecord` in the daemon's `state.jobs` map, executed
 * concurrently in separate worker processes.
 *
 * @see docs/superpowers/plans/2026-06-13-plan-bg-agent-view.md §T5 (dispatch op)
 * @see docs/ports/bg-agent-view.md §Follow-up T12 #3
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { platform } from 'node:process'
import { z } from 'zod/v4'
import { buildTool } from '../../Tool.ts'
import { lazySchema } from '../../utils/lazySchema.ts'
import { logError } from '../../utils/log.ts'
import { sleep } from '../../utils/sleep.ts'
import { DaemonError, pingDaemon, requestDaemon } from '../../utils/daemon/socket.ts'
import {
  BG_PROTO,
  type JobSource,
  type JobShortId,
} from '../../utils/daemon/protocol.ts'
import {getReplClientId, isBgAgentRuntimeEnabled, markBackgroundAgentDispatched} from '../../utils/daemon/mailbox.ts'

export const BACKGROUND_AGENT_TOOL_NAME = 'BackgroundAgent'

const inputSchema = lazySchema(() =>
  z.strictObject({
    prompt: z
      .string()
      .min(1)
      .describe(
        'The prompt / task for the background agent. Same shape as a regular ' +
          'user prompt — describes what the agent should do.',
      ),
    cwd: z
      .string()
      .optional()
      .describe(
        'Working directory for the spawned agent. Defaults to the calling ' +
          "REPL's cwd.",
      ),
    agent: z
      .string()
      .optional()
      .describe(
        'Optional named agent type (e.g., "explore", "plan", or a custom ' +
          'agent from .claude/agents/). Maps to the JobLaunchSpec.agent field.',
      ),
    label: z
      .string()
      .optional()
      .describe(
        'Human-readable short label shown in the /background dialog ' +
          '(e.g., "refactor-foo", "scan-slow-queries").',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
export type BackgroundAgentInput = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    shortId: z
      .string()
      .describe('8-hex job ID; use this with `/background` dialog or `bg-agents kill`.'),
    status: z.literal('dispatched'),
    message: z.string().describe('Human-readable confirmation.'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type BackgroundAgentOutput = z.infer<OutputSchema>

function generateShortId(): JobShortId {
  // 4 bytes -> 8 hex chars, lowercase. Matches JOB_SHORT_ID_REGEX.
  return randomBytes(4).toString('hex') as JobShortId
}

// ---------- Daemon auto-start ----------
//
// When the bg daemon is not running (ENOCONN), the tool can either:
//   1. Return a graceful "not running" error and force the user to manually
//      `opencc daemon install` — high friction, easy to miss.
//   2. Auto-spawn `daemon run` detached, wait for it to come up, and retry.
//
// We pick (2) by default because the tool's whole point is convenience.
// The in-flight lock prevents N parallel tool calls from spawning N daemons.
// Set `CLAUDE_CODE_DISABLE_DAEMON_AUTOSTART=1` to opt out.

let autoStartInFlight: Promise<boolean> | null = null

const AUTOSTART_POLL_MS = 200
const AUTOSTART_TIMEOUT_MS = 5_000

/**
 * Spawn the same binary as `opencc daemon run` detached, then poll the
 * loopback socket until it answers ping or we hit the timeout.
 * Returns true if the daemon came up; false otherwise.
 *
 * Idempotent under load: parallel callers share one in-flight promise.
 */
async function tryAutoStartDaemon(): Promise<boolean> {
  if (autoStartInFlight) return autoStartInFlight
  if (process.env.CLAUDE_CODE_DISABLE_DAEMON_AUTOSTART === '1') {
    return false
  }
  autoStartInFlight = (async () => {
    if (platform !== 'darwin') return false

    // Build the spawn argv. Two strategies, tried in order:
    //   1. `process.execPath` + `process.argv[1]` — works when the user
    //      invoked opencc via `node dist/cli.mjs` / `bun dist/cli.mjs`.
    //   2. `opencc` from PATH — works for npm-installed `opencc` (the
    //      bin script on PATH is a thin wrapper around the same dist).
    // We try both because argv[1] is undefined in inline-script contexts
    // (e.g. `bun -e ...` or `node -e ...`) and we can't tell at runtime
    // whether the user is in dev (no global opencc) or installed.
    const entry = process.argv[1]
    const candidates: Array<{cmd: string; args: string[]}> = []
    if (entry) {
      candidates.push({cmd: process.execPath, args: [entry, 'daemon', 'run']})
    }
    candidates.push({cmd: 'opencc', args: ['daemon', 'run']})

    for (const {cmd, args} of candidates) {
      try {
        const child = spawn(cmd, args, {
          detached: true,
          stdio: 'ignore',
          env: {
            ...process.env,
            CLAUDE_CODE_DISABLE_DAEMON_AUTOSTART: '1', // prevent recursion in the child
          },
        })
        child.on('error', () => {/* try next candidate */})
        child.unref()
        break
      } catch {
        // try next candidate
      }
    }

    const deadline = Date.now() + AUTOSTART_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (await pingDaemon(AUTOSTART_POLL_MS)) return true
      await sleep(AUTOSTART_POLL_MS)
    }
    return false
  })()
  try {
    return await autoStartInFlight
  } finally {
    // Don't reset autoStartInFlight to null on failure: a successful
    // spawn followed by a flaky ping would otherwise let parallel
    // callers retry the spawn and end up with 2 daemons racing.
    // Reset only on success after a short grace period is overkill for
    // the current single-user model; leaving the cached result is fine.
  }
}

export const BackgroundAgentTool = buildTool({
  name: BACKGROUND_AGENT_TOOL_NAME,
  searchHint: 'spawn a background agent via the bg daemon',
  maxResultSizeChars: 1_000,
  async description() {
    return (
      'Spawn a background agent that runs in the bg daemon. The agent ' +
      'persists across CLI restarts and is visible in the `/background` ' +
      "REPL dialog and `claude bg-agents` list. This tool is safe to call " +
      'multiple times in a single turn to fan out parallel work — each ' +
      'call becomes an independent daemon-managed job. ' +
      'After spawning, the worker\'s output is captured to ' +
      '`~/.claude/background/<shortId>.log`; pair with `BackgroundAgentResult` ' +
      'to fetch the result in a follow-up turn.'
    )
  },
  async prompt() {
    return (
      '## BackgroundAgent\n\n' +
      'Use the `BackgroundAgent` tool to fork a long-running task into the bg ' +
      'daemon. The agent runs in a separate process that survives CLI restarts ' +
      'and is visible in `/background` (REPL) and `claude bg-agents` (CLI).\n\n' +
      '**When to use:** tasks that take >30s, would block the main REPL, or ' +
      'should run in parallel with other work.\n\n' +
      '**Multi-agent parallel:** this tool is safe to call multiple times in a ' +
      'single turn. Each call becomes an independent daemon-managed job that ' +
      'runs concurrently. Use this to fan out independent subtasks.\n\n' +
      '**Required:** the bg daemon must be running (`opencc daemon install` for ' +
      'persistent, or `opencc daemon run` for foreground). If the daemon is ' +
      'not running, the tool returns a helpful error instead of failing silently.\n\n' +
      '**Output:** a 8-hex `shortId`. The worker\'s stdout+stderr is captured ' +
      'to `~/.claude/background/<shortId>.log` (NOT returned inline). ' +
      '**To get the result back into your context, call `BackgroundAgentResult(' +
      'shortId)` in a follow-up turn.** Use the `tail` argument for long outputs.\n\n' +
      '**Input schema:**\n' +
      '- `prompt` (string, required): the task description\n' +
      '- `cwd` (string, optional): working directory; defaults to current\n' +
      '- `agent` (string, optional): named agent type (e.g., "explore", "plan")\n' +
      '- `label` (string, optional): human-readable short label for the dialog'
    )
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return false
  },
  isEnabled() {
    // Runtime gate: when the bg agent feature is disabled
    // (default-off; opt-in via CLAUDE_CODE_ENABLE_AGENT_VIEW=1 or
    // settings.enableAgentView), this tool is auto-filtered out
    // of the available tools list by `getToolsForDefaultPreset`.
    // The LLM never sees it.
    return isBgAgentRuntimeEnabled()
  },
  renderToolUseMessage({prompt, label}: BackgroundAgentInput) {
    return label ? `Spawning background agent: ${label}` : `Spawning background agent: ${prompt.slice(0, 60)}`
  },
  mapToolResultToToolResultBlockParam({shortId, message}, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Background agent ${shortId} — ${message}`,
    }
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async call(
    {prompt, cwd, agent, label}: BackgroundAgentInput,
  ): Promise<{data: BackgroundAgentOutput}> {
    if (platform !== 'darwin') {
      return {
        data: {
          shortId: '00000000' as JobShortId,
          status: 'dispatched',
          message:
            'bg daemon is Darwin-only; falling back to inline execution not yet ' +
            'implemented. Run on macOS to use the daemon-backed path.',
        },
      }
    }

    const shortId = generateShortId()
    const source: JobSource = 'shell'
    const resolvedCwd = cwd ?? process.cwd()

    // Flip the module-level "this REPL has dispatched a bg agent"
    // flag so subsequent LLM calls query the daemon inbox (which
    // would otherwise be skipped as an optimization).
    markBackgroundAgentDispatched()

    try {
      await requestDaemon({
        proto: BG_PROTO,
        op: 'dispatch',
        auth: 'loopback',
        job: {
          proto: BG_PROTO,
          short: shortId,
          nonce: randomUUID(),
          sessionId: getReplClientId(),
          createdAt: Date.now(),
          source,
          cwd: resolvedCwd,
          launch: {mode: 'prompt', args: [prompt]},
          env: {},
          isolation: 'none',
          respawnFlags: [],
          ...(agent !== undefined ? {agent} : {}),
        },
      })
    } catch (err) {
      if (err instanceof DaemonError && err.code === 'ENOCONN') {
        const started = await tryAutoStartDaemon()
        if (started) {
          try {
            await requestDaemon({
              proto: BG_PROTO,
              op: 'dispatch',
              auth: 'loopback',
              job: {
                proto: BG_PROTO,
                short: shortId,
                nonce: randomUUID(),
                sessionId: getReplClientId(),
                createdAt: Date.now(),
                source,
                cwd: resolvedCwd,
                launch: {mode: 'prompt', args: [prompt]},
                env: {},
                isolation: 'none',
                respawnFlags: [],
                ...(agent !== undefined ? {agent} : {}),
              },
            })
            const labelSuffix = label ? ` (${label})` : ''
            return {
              data: {
                shortId,
                status: 'dispatched',
                message:
                  `Background agent ${shortId}${labelSuffix} dispatched ` +
                  '(bg daemon was auto-started for this call). ' +
                  'Use `/background` to view, `claude bg-agents kill ' +
                  shortId +
                  '` to stop. To install persistently, run ' +
                  '`opencc daemon install` once.',
              },
            }
          } catch (retryErr) {
            logError(retryErr)
            return {
              data: {
                shortId,
                status: 'dispatched',
                message:
                  'Background daemon was auto-started but the dispatch retry ' +
                  `failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
              },
            }
          }
        }
        if (process.env.CLAUDE_CODE_DISABLE_DAEMON_AUTOSTART === '1') {
          return {
            data: {
              shortId,
              status: 'dispatched',
              message:
                'Background daemon is not running. Auto-start is disabled ' +
                '(CLAUDE_CODE_DISABLE_DAEMON_AUTOSTART=1). Run ' +
                '`opencc daemon install` (persistent) or `opencc daemon run` ' +
                '(foreground) yourself, then retry. The job was NOT enqueued.',
            },
          }
        }
        return {
          data: {
            shortId,
            status: 'dispatched',
            message:
              'Background daemon is not running and auto-start did not bring ' +
              'it up within ' +
              `${Math.round(AUTOSTART_TIMEOUT_MS / 1000)}s. ` +
              'Run `opencc daemon install` (persistent) or `opencc daemon run` ' +
              '(foreground) yourself, then retry. The job was NOT enqueued.',
          },
        }
      }
      logError(err)
      return {
        data: {
          shortId,
          status: 'dispatched',
          message: `Background dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      }
    }

    const labelSuffix = label ? ` (${label})` : ''
    return {
      data: {
        shortId,
        status: 'dispatched',
        message:
          `Background agent ${shortId}${labelSuffix} dispatched. ` +
          'It will run in the bg daemon. Use `/background` in this REPL or ' +
          '`claude bg-agents` to see it; `claude bg-agents kill ' +
          shortId +
          '` to stop it.',
      },
    }
  },
})
