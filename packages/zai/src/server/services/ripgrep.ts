/**
 * Thin wrapper around the vendored / system ripgrep binary.
 *
 * Extracted from packages/zai-agent-core/src/tools/GrepTool/GrepTool.ts
 * (vendor path resolver + spawn) so the HTTP route layer can call rg
 * directly without depending on ToolContext. The Agent-side GrepTool
 * keeps its existing copy for now — duplicating ~80 lines is cheaper
 * than retrofitting a LegacyTool dependency into the route layer.
 *
 * Vendor: packages/zai-agent-core/vendor/ripgrep/{rg-<platform>-<arch>[.exe]}
 * System: `which rg` / `where rg` fallback.
 *
 * Platform coverage (from fetch-vendor-ripgrep.mjs):
 *   - darwin + arm64 / x64
 *   - win32  + x64
 * Linux users must install ripgrep on PATH; the route layer treats
 * `resolveRgPath() === null` as "ripgrep unavailable" and returns
 * { ok:false, error:'ripgrep 未安装…' } with HTTP 200.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

export type SpawnResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: NodeJS.ErrnoException;
};

export type RunRipgrepOptions = {
  /** ripgrep 进程的 cwd(同时也是默认 search root 的拼装基准)。 */
  cwd: string;
  /** 用于提前中止的 AbortSignal。 */
  signal?: AbortSignal;
  /** 单次 spawn 超时(毫秒)。默认 10000。 */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const SIGKILL_AFTER_MS = 5_000;

/** Resolve vendor ripgrep binary for the current platform/arch. */
export function resolveRgVendor(): { rgPath: string; mode: 'vendor' } | null {
  const platform = process.platform;
  const arch = process.arch;
  if (!['darwin', 'win32'].includes(platform)) return null;
  if (!['arm64', 'x64'].includes(arch)) return null;
  const ext = platform === 'win32' ? '.exe' : '';
  const binName = `rg-${platform}-${arch}${ext}`;
  const here = dirname(fileURLToPath(import.meta.url));
  // services/ → ../../vendor/ripgrep/  (packages/zai-agent-core/vendor/ripgrep/)
  const vendorPath = join(
    here, '..', '..', '..', '..', 'zai-agent-core', 'vendor', 'ripgrep', binName,
  );
  return existsSync(vendorPath) ? { rgPath: vendorPath, mode: 'vendor' } : null;
}

/** Resolve ripgrep via PATH (`which rg` / `where rg`). */
export function resolveRgSystem(): { rgPath: string; mode: 'system' } | null {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const stdout = execFileSync(cmd, ['rg'], { timeout: 3000, encoding: 'utf-8' });
    const rgPath = stdout.trim().split(/\r?\n/)[0];
    return rgPath ? { rgPath, mode: 'system' } : null;
  } catch {
    return null;
  }
}

/** First non-null of vendor → system. Single-binary callers use this. */
export function resolveRgPath(): { rgPath: string; mode: 'vendor' | 'system' } | null {
  return resolveRgVendor() ?? resolveRgSystem();
}

/**
 * Spawn ripgrep with the given args, capture stdout/stderr, settle once on
 * 'close' or 'error'. Mirrors GrepTool.spawnOnce semantics but accepts an
 * AbortSignal + an explicit timeout instead of ToolContext.
 */
export async function runRipgrep(
  args: string[],
  opts: RunRipgrepOptions,
): Promise<SpawnResult> {
  const rg = resolveRgPath();
  if (!rg) {
    return {
      stdout: '',
      stderr: 'ripgrep binary not found (vendor missing + system PATH empty)',
      code: null,
      signal: null,
      error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException,
    };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<SpawnResult>((resolveP) => {
    const child = spawn(rg.rgPath, args, {
      cwd: opts.cwd,
      signal: opts.signal,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on('data', (d: Buffer) => {
      stdoutChunks.push(d);
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderrChunks.push(d);
      stderr += d.toString();
    });

    let settled = false;
    const settle = (r: SpawnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killer);
      resolveP(r);
    };

    const killer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs + SIGKILL_AFTER_MS);

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child.on('close', (code, signal) => {
      settle({ stdout, stderr, code, signal });
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      settle({ stdout, stderr, code: null, signal: null, error: err });
    });
  });
}
