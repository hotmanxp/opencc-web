import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { HookExecutor } from './types.js'

/**
 * Tokenize a shell-style command string into argv. Handles double-quoted
 * segments (so `node -e "long script with spaces"` survives intact) and
 * escapes inside quotes. We deliberately do NOT support environment
 * expansion, globbing, or backticks — plugin authors who need richer
 * syntax should ship a wrapper script. This keeps the executor's
 * behavior predictable across OSes and hermetic for tests.
 *
 * If a plugin author's command contains spaces inside an argument,
 * they must wrap that argument in double quotes.
 */
function tokenizeCommand(command: string): [string, ...string[]] {
  const tokens: string[] = []
  let current = ''
  let inQuotes = false
  let escapeNext = false
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]
    if (escapeNext) {
      current += char
      escapeNext = false
      continue
    }
    if (char === '\\' && inQuotes) {
      escapeNext = true
      continue
    }
    if (char === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (!inQuotes && /\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current.length > 0) tokens.push(current)
  if (inQuotes) {
    throw new Error('Hook command has an unterminated quoted segment.')
  }
  if (tokens.length === 0) {
    throw new Error('Hook command is empty.')
  }
  return tokens as [string, ...string[]]
}

/**
 * Default child-process hook executor.
 *
 * Phase-1 behavior:
 *
 * - Spawns `command` with `cwd = request.pluginRoot` and a minimal
 *   environment allowlist (`PATH`, `HOME`, `TMPDIR`, anything starting
 *   with `ZAI_` or `OPENCC_`, plus `LANG`). All other vars are dropped
 *   so plugins can't accidentally inherit secrets.
 * - JSON-stringifies `request.input` to the child's stdin and closes it.
 * - Resolves to `{ blocked: false, error: '<reason>' }` on non-zero exit
 *   OR signal kill. This executor never returns `blocked: true` — it is
 *   a *report-only* executor. The runtime treats an explicit
 *   `{ blocked: true }` from a custom `hookExecutor` as authoritative.
 * - Honors `request.signal`: an external abort kills the child
 *   cleanly. The default per-hook timeout is applied upstream by
 *   `HookRunner` via its combined AbortSignal, so this executor does
 *   not set its own timer.
 *
 * Returns: `{ blocked?: boolean; output?: unknown; error?: string }`.
 * The `output` field carries the JSON-parsed stdout when the child
 * printed valid JSON; otherwise it carries the raw stdout string. We
 * intentionally swallow parse errors so plugin authors can return
 * arbitrary text without crashing the runner.
 */

const ENV_ALLOWLIST_PREFIXES = ['ZAI_', 'OPENCC_']
const ENV_ALLOWLIST_EXACT = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG'])

function buildFilteredEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (ENV_ALLOWLIST_EXACT.has(key)) {
      out[key] = value
      continue
    }
    for (const prefix of ENV_ALLOWLIST_PREFIXES) {
      if (key.startsWith(prefix)) {
        out[key] = value
        break
      }
    }
  }
  return out
}

export function createDefaultHookExecutor(): HookExecutor {
  return async function defaultHookExecutor(request) {
    let argv: [string, ...string[]]
    try {
      argv = tokenizeCommand(request.command)
    } catch (cause) {
      return {
        blocked: false,
        error: cause instanceof Error ? cause.message : String(cause),
      }
    }

    return new Promise(resolve => {
      let child: ChildProcess
      try {
        child = spawn(argv[0], argv.slice(1), {
          cwd: request.pluginRoot,
          env: buildFilteredEnv(),
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
        })
      } catch (cause) {
        resolve({
          blocked: false,
          error: `Failed to spawn hook: ${cause instanceof Error ? cause.message : String(cause)}`,
        })
        return
      }

      let stdout = ''
      let stderr = ''
      let settled = false

      const settle = (value: {
        blocked?: boolean
        output?: unknown
        error?: string
      }): void => {
        if (settled) return
        settled = true
        resolve(value)
      }

      const onAbort = (): void => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGTERM')
          } catch {
            // ignore — process may already be dead
          }
        }
        settle({
          blocked: false,
          error: `Hook aborted: ${request.signal.reason instanceof Error ? request.signal.reason.message : 'caller aborted'}`,
        })
      }

      if (request.signal.aborted) {
        onAbort()
        return
      }
      request.signal.addEventListener('abort', onAbort, { once: true })

      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk
      })

      child.on('error', cause => {
        request.signal.removeEventListener('abort', onAbort)
        settle({
          blocked: false,
          error: `Hook spawn error: ${cause instanceof Error ? cause.message : String(cause)}`,
        })
      })

      child.on('close', (code, signal) => {
        request.signal.removeEventListener('abort', onAbort)
        if (request.signal.aborted) {
          settle({
            blocked: false,
            error: `Hook aborted: ${request.signal.reason instanceof Error ? request.signal.reason.message : 'caller aborted'}`,
          })
          return
        }
        if (code === 0) {
          // Try JSON parse first; fall back to raw string.
          let output: unknown = stdout
          const trimmed = stdout.trim()
          if (trimmed.length > 0) {
            try {
              output = JSON.parse(trimmed)
            } catch {
              output = stdout
            }
          }
          settle({ blocked: false, output })
          return
        }

        const reason = signal
          ? `Hook killed by signal ${signal}`
          : `Hook exited with code ${code}; stderr: ${stderr.trim().slice(0, 200)}`
        settle({ blocked: false, error: reason })
      })

      // Write input as JSON to stdin and close.
      try {
        child.stdin?.end(JSON.stringify(request.input))
      } catch (cause) {
        settle({
          blocked: false,
          error: `Failed to write hook stdin: ${cause instanceof Error ? cause.message : String(cause)}`,
        })
      }
    })
  }
}