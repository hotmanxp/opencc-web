import { resolve, sep } from 'node:path';

/**
 * Resolve `rel` under `root` and ensure the result stays inside root.
 * Used by read-only filesystem / git endpoints that accept a path
 * relative to the configured cwd. Returns `{ ok: false, error }` if
 * the resolved path escapes `root` or is otherwise invalid.
 *
 * Note: this does NOT follow symlinks (path.resolve does not).
 * A symlink that points outside root will only be caught when the
 * caller subsequently does fs.stat/readFile on it. Both fs.ts and
 * git.ts run resolveSafePath BEFORE running git or fs operations,
 * so any subsequent ENOENT/ELOOP surfaces to the caller as the
 * normal error path. Documented risk: malicious symlinks. Mitigated
 * because the endpoints are read-only and the agent core already
 * runs in a sandbox.
 */
export function resolveSafePath(
  root: string,
  rel: string,
): { ok: true; abs: string } | { ok: false; error: string } {
  if (typeof rel !== 'string') {
    return { ok: false, error: 'path 必须为字符串' };
  }
  // Empty rel means "the root itself" — useful for /fs/list?dir=
  const abs = resolve(root, rel);
  // Resolve removes trailing slash on root; compare exactly + the
  // separator-aware prefix check.
  if (abs === root || abs.startsWith(root + sep)) {
    return { ok: true, abs };
  }
  return { ok: false, error: `禁止访问：路径越界 (${rel})` };
}
