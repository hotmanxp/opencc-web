/**
 * AA (Agents Anywhere) 配置加载与持久化。
 *
 * 持久化位置:`~/.zai/aa/config.json`(mode 0600),含 serverUrl + 已配对 connector 凭据。
 * Token(cxt_xxx)走 `mode: 0600` 文件,因为没有 keychain 可用;只能靠文件系统权限隔离。
 * 详见 docs/2026-09-27-zai-aa-integration.md T1。
 */
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { aaConfigPath, ensureAaDir } from '../paths.js';

/**
 * zod schema for the persisted config file. Designed to be tolerant to
 * forward-compatible additions — unknown fields are stripped on load rather
 * than rejected, so adding a new field server-side doesn't lock old zai builds
 * out of their own config.
 */
export const AaConfigSchema = z.object({
  /** AA server origin, e.g. "https://web.agents-anywhere.com". No trailing slash. */
  serverUrl: z.string().url(),
  /** AA-issued connector id, e.g. "conn_xxxxxxxxxxxx" or "conn_xxxxxxxx-xxxx".
   *  AA uses uuid-style suffixes — allow alphanumeric + dash + underscore. */
  connectorId: z.string().regex(/^conn_[A-Za-z0-9_-]+$/),
  /**
   * AA-issued connector token, e.g. "cxt_xxxxxxxxxxxx". Treated as a secret.
   * Stored with mode 0600.
   */
  connectorToken: z.string().regex(/^cxt_[A-Za-z0-9_-]+$/),
  /**
   * Human-friendly display name for this connector, e.g. "zai Mac".
   * User-set during pairing in AA Web.
   */
  connectorName: z.string().min(1).max(64),
  /** ISO-8601 timestamp of when pairing completed. */
  pairedAt: z.string().datetime(),
  /**
   * Optional device metadata reported to AA server on connect.
   * Kept in config so reconnection preserves identity without re-querying.
   */
  deviceOs: z.enum(['macos', 'windows', 'linux']).optional(),
  /** zai client version (semver). Useful for AA server-side compatibility checks. */
  clientVersion: z.string().optional(),
});

export type AaConfig = z.infer<typeof AaConfigSchema>;

/**
 * Read and validate the persisted AA config. Returns null when the file is
 * missing (not yet paired) — this is the normal "first launch" state, not an
 * error.
 *
 * Throws when the file exists but is unreadable / malformed, because that
 * indicates a real problem the user should know about (corrupted file,
 * permissions, partial write).
 */
export async function readAaConfig(): Promise<AaConfig | null> {
  const path = aaConfigPath();
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`failed to read AA config at ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`AA config at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  // Strip unknown fields to stay forward-compatible.
  const result = AaConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `AA config at ${path} failed validation: ${result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return result.data;
}

/**
 * Persist AA config atomically (tmp + rename) and lock the file to mode 0600.
 *
 * Why tmp + rename: zaiSettingsStore uses the same pattern to avoid corrupting
 * the file on crash mid-write. See zaiSettingsStore.ts comment for the full
 * race-condition analysis.
 *
 * Why mode 0600: connectorToken is a secret. Without a keychain (zai is a
 * Node.js process, not a Mac app), filesystem permissions are the only
 * isolation we have.
 */
export async function writeAaConfig(config: AaConfig): Promise<void> {
  const path = aaConfigPath();
  await ensureAaDir();
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
  await rename(tmpPath, path);
  try {
    await chmod(path, 0o600);
  } catch {
    // chmod can fail on non-POSIX filesystems (e.g. Windows dev); not fatal,
    // log via warning in caller if needed. Don't throw here — the file IS
    // written, just less locked than ideal.
  }
}

/**
 * In-process serialisation chain for config writes. Same pattern as
 * zaiSettingsStore: concurrent writeConfig calls (e.g. during re-pairing)
 * must not interleave their tmp-rename on the same tmp path.
 */
let mutationChain: Promise<unknown> = Promise.resolve();
function enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
  const run = mutationChain.then(task, task);
  mutationChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function writeAaConfigQueued(config: AaConfig): Promise<void> {
  return enqueueMutation(() => writeAaConfig(config));
}

/**
 * Build a fully-populated config from pairing completion data. The caller
 * (pairing flow) supplies the values returned by AA's /pairing/claim+poll.
 */
export function buildAaConfigFromPairing(input: {
  serverUrl: string;
  connectorId: string;
  connectorToken: string;
  connectorName: string;
}): AaConfig {
  return {
    serverUrl: input.serverUrl.replace(/\/+$/, ''),
    connectorId: input.connectorId,
    connectorToken: input.connectorToken,
    connectorName: input.connectorName,
    pairedAt: new Date().toISOString(),
  };
}

// Re-export Node's `rename` from the same module so callers don't need a
// second import for atomic writes elsewhere in aaClient.
import { rename } from 'node:fs/promises';
