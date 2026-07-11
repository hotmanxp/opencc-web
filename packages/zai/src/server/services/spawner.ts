import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type { SseEvent } from '../../shared/types.js';

// Strip ANSI escape sequences (colors, cursor moves, OSC). Many CLIs emit
// these even when stdout is piped, and they would otherwise pollute the
// LogPanel with invisible characters and stray [K / [2J codes.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[@-Z\\-_]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

interface SpawnOptions {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

export async function spawn(
  command: string,
  args: string[],
  onLine: (event: SseEvent) => void,
  opts: SpawnOptions = {},
): Promise<{ code: number; signal: string | null }> {
  const timeout = opts.timeout ?? 300_000;

  onLine({ type: 'start', command: `${command} ${args.join(' ')}`.trim() });

  const child: ChildProcess = nodeSpawn(command, args, {
    env: { ...process.env, ...opts.env },
  });

  // Close stdin immediately. With default stdio='pipe' the writable end stays
  // open in the parent; commands that wait for EOF (inquirer, `node -e
  // process.stdin.resume()`, etc.) will hang forever otherwise. Closing it
  // signals EOF to the child right away.
  child.stdin?.end();

  let stdoutBuf = '';
  let stderrBuf = '';

  // Split on both \n and \r. npm and many CLIs use \r to overwrite the
  // current line for in-place progress (e.g. "Reify:lodash  50%"). Treating
  // \r as a line terminator too means each overwrite is delivered as its
  // own event instead of getting glued together until a real \n arrives.
  // ANSI escape sequences (color codes, cursor moves) are stripped so the
  // LogPanel renders clean text.
  const splitLines = (text: string): string[] => {
    const stripped = stripAnsi(text);
    return stripped.split(/\r\n|\r|\n/);
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
    const parts = splitLines(stdoutBuf);
    stdoutBuf = parts.pop() ?? '';
    for (const line of parts) onLine({ type: 'stdout', line });
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    const parts = splitLines(stderrBuf);
    stderrBuf = parts.pop() ?? '';
    for (const line of parts) onLine({ type: 'stderr', line });
  });

  // Two-stage timeout: SIGTERM, then SIGKILL if it doesn't exit within 10s.
  // Keep both handles so we can clear them if the child exits in between.
  let killEscalateHandle: NodeJS.Timeout | undefined;
  const timeoutHandle = setTimeout(() => {
    child.kill('SIGTERM');
    killEscalateHandle = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }, 10_000);
    onLine({ type: 'error', message: `Process timed out after ${timeout}ms` });
  }, timeout);

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      if (killEscalateHandle) clearTimeout(killEscalateHandle);
      fn();
    };

    // Spawn-level errors (ENOENT, EACCES, etc.) only emit 'error' — not
    // 'close' — so without this listener the promise hangs forever and the
    // SSE connection never closes.
    child.on('error', (err) => {
      onLine({ type: 'error', message: `Failed to spawn '${command}': ${err.message}` });
      settle(() => reject(err));
    });

    child.on('close', (code, signal) => {
      if (stdoutBuf) onLine({ type: 'stdout', line: stdoutBuf });
      if (stderrBuf) onLine({ type: 'stderr', line: stderrBuf });
      onLine({ type: 'exit', code: code ?? 1, signal: signal ?? undefined });
      settle(() => resolve({ code: code ?? 1, signal: signal ?? null }));
    });
  });
}
