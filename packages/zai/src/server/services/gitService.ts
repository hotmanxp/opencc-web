/**
 * Git operations service for the zai review panel.
 *
 * Everything goes through the system `git` binary spawned per request (no
 * library, no in-memory state), with porcelain-parseable output formats
 * (`-z` NUL framing, `%x1f` unit separators) so parsing never depends on
 * locale or color config. All commands run with `-C <cwd>` on the session's
 * working directory and `--no-pager` / `-c color.ui=false` so output stays
 * machine-readable. `GIT_OPTIONAL_LOCKS=0` keeps concurrent reads off the
 * index lock so a polling panel never starves real commits.
 *
 * Commits use the user's git global identity untouched (never sets
 * user.name/user.email) — see `commit()`.
 *
 * Design borrows heavily from omdsh-dev/DSH-better-sidebar/src/git.ts (the
 * upstream reference implementation), adapted for zai's `resolveSafePath`
 * guard and instanceContext cwd injection.
 */
import { readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import type {
  GitBranchEntry,
  GitLogEntry,
  GitStatusEntry,
  GitStatusResult,
  GitWorktree,
  GitWorktreeRecord,
} from '../../shared/git.js';

// ────────────────────────────────────────────────────────────────────────────
// Errors & parsing
// ────────────────────────────────────────────────────────────────────────────

/** One git failure (stderr text as the message). */
export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly code: string = 'git-error',
    readonly command: string = '',
  ) {
    super(message);
    this.name = 'GitCommandError';
  }
}

/** Parse porcelain v1 -z output into entries. Rename/copy pairs collapse to the
 *  new path; the ORIGIN path token that follows the XY field is consumed but
 *  discarded. */
export function parsePorcelainZ(output: string): GitStatusEntry[] {
  const tokens = output.split('\0');
  const entries: GitStatusEntry[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined) break;
    index += 1;
    if (token === '') continue;
    if (token.length < 3) continue; // malformed
    const xy = token.slice(0, 2);
    const rest = token.slice(3);
    entries.push({
      path: rest,
      xy,
      staged: xy[0] !== ' ' && xy[0] !== '?',
    });
    // Rename/copy entries carry the ORIGIN path as the next NUL field;
    // the new path (the file as it exists now) is `rest` above.
    if ((xy[0] === 'R' || xy[0] === 'C') && tokens[index] !== undefined && tokens[index] !== '') {
      index += 1;
    }
  }
  return entries;
}

/** Parse `git log --pretty=format:%h%x1f%s%x1f%an%x1f%ai%x1f%H%x1f%D` rows.
 *  Defensive: if a row has fewer than 6 fields (older git on `%D` etc.) we
 *  fill missing ones with empty strings rather than discarding the row. */
export function parseLogLines(output: string): GitLogEntry[] {
  const rows: GitLogEntry[] = [];
  for (const line of output.split('\n')) {
    if (line === '') continue;
    const [hash, subject, author, date, hashFull, refs] = line.split('\x1f');
    if (hash === undefined || subject === undefined) continue;
    rows.push({
      hash,
      hashFull: hashFull ?? hash,
      subject,
      author: author ?? '',
      date: date ?? '',
      refs: refs ?? '',
    });
  }
  return rows;
}

/** Parse `git worktree list --porcelain` records. Production requests use
 *  `-z` so even newlines and non-ASCII bytes in checkout paths stay
 *  lossless; newline framing remains accepted for older Git output.
 *  Prunable/locked flags are kept on the record — callers filter prunable
 *  before exposing the row as a selectable target. */
export function parseWorktreeList(output: string): GitWorktreeRecord[] {
  const rows: GitWorktreeRecord[] = [];
  let path: string | undefined;
  let branch = 'HEAD';
  let locked = false;
  let prunable = false;
  const flush = (): void => {
    if (path !== undefined) rows.push({ path, branch, locked, prunable });
    path = undefined;
    branch = 'HEAD';
    locked = false;
    prunable = false;
  };
  const sep = output.includes('\0') ? '\0' : '\n';
  const framed = output.endsWith(sep) ? output : `${output}${sep}`;
  for (const line of framed.split(sep)) {
    if (line === '') {
      flush();
    } else if (line.startsWith('worktree ')) {
      path = line.slice('worktree '.length);
    } else if (line.startsWith('branch refs/heads/')) {
      branch = line.slice('branch refs/heads/'.length);
    } else if (line === 'locked' || line.startsWith('locked ')) {
      locked = true;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      prunable = true;
    }
  }
  return rows;
}

/** Parse `git for-each-ref --format=...` rows with NUL separators. */
export function parseBranchEntries(
  output: string,
  format: 'simple' | 'tracked',
): GitBranchEntry[] {
  const rows: GitBranchEntry[] = [];
  for (const line of output.split('\n')) {
    if (line === '') continue;
    const fields = line.split('\0');
    if (format === 'tracked') {
      const [name = '', head = '', upstream = '', track = '', subject = ''] = fields;
      const ahead = Number(/ahead (\d+)/.exec(track ?? '')?.[1] ?? 0);
      const behind = Number(/behind (\d+)/.exec(track ?? '')?.[1] ?? 0);
      const isRemote = name.startsWith('origin/') || name.includes('/');
      rows.push({
        name,
        current: head === '*',
        isRemote,
        upstream: upstream || undefined,
        ahead,
        behind,
        subject: subject || undefined,
      });
    } else {
      const [name = '', head = ''] = fields;
      rows.push({ name, current: head === '*', isRemote: false });
    }
  }
  return rows;
}

// ────────────────────────────────────────────────────────────────────────────
// runGit — single spawn-receive helper
// ────────────────────────────────────────────────────────────────────────────

/** Run one git command. Resolves with stdout; rejects with `GitCommandError`.
 *  Spawn (not execFile) is used so we can attach timeout-kill without race
 *  conditions on the wrapped child and we own the stdout/stderr streams.
 *  Exported (with `__test` prefix) so the test suite can hit timeout and
 *  non-zero-exit paths without contorting the public service surface. */
export function runGit(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  const full = ['-C', cwd, '--no-pager', '-c', 'color.ui=false', ...args];
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn('git', full, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new GitCommandError(
          `git ${args[0] ?? ''} timed out after ${timeoutMs}ms`,
          'git-timeout',
          args.join(' '),
        ),
      );
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(
        new GitCommandError(
          `cannot run git: ${error.message}`,
          'spawn-failed',
          args.join(' '),
        ),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise(stdout);
      } else {
        reject(
          new GitCommandError(
            stderr.trim() || `git exited with ${String(code)}`,
            'git-error',
            args.join(' '),
          ),
        );
      }
    });
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Repo discovery — cache + in-flight dedup
// ────────────────────────────────────────────────────────────────────────────

/** Per-probe budget. `rev-parse` is millisecond-scale on a healthy checkout;
 *  a probe that needs longer is a stalled mount and is better abandoned
 *  than waited on. */
const DISCOVERY_TIMEOUT_MS = 5_000;

/** Discovery results are cheap to recompute but expensive to storm: the panel
 *  polls every 5s and each poll fans out into several git.* calls that all
 *  resolve the same roots. A short TTL keeps fan-out at one scan per cwd. */
const DISCOVERY_CACHE_TTL_MS = 60_000;

/** Cap on child directories probed by the workspace-container fallback scan.
 *  A home-directory cwd can hold hundreds of visible folders; probing them
 *  all serially is what froze the panel in upstream #369. */
const DISCOVERY_LIMIT = 200;

const repoRootsCache = new Map<string, { roots: string[]; expires: number }>();
const repoRootsInFlight = new Map<string, Promise<string[]>>();

/** Whether the cwd is inside a git work tree (exit-0 `git rev-parse`). Probe
 *  timeout is short — a cwd on a stalled mount must not hold the panel
 *  hostage for the full command budget. */
export async function isRepo(cwd: string): Promise<boolean> {
  try {
    const out = await runGit(
      cwd,
      ['rev-parse', '--is-inside-work-tree'],
      DISCOVERY_TIMEOUT_MS,
    );
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

/** The repository top level containing `cwd` (`git rev-parse --show-toplevel`). */
async function directRepoRoot(cwd: string): Promise<string> {
  const out = await runGit(cwd, ['rev-parse', '--show-toplevel'], DISCOVERY_TIMEOUT_MS);
  return out.trim();
}

/** Discover the current repository or direct child repositories. Results are
 *  cached per cwd and concurrent callers share one in-flight scan, so opening
 *  the panel (3 parallel git.* requests) costs a single discovery pass. */
export function repoRoots(cwd: string): Promise<string[]> {
  const cached = repoRootsCache.get(cwd);
  if (cached !== undefined && cached.expires > Date.now()) {
    return Promise.resolve(cached.roots);
  }
  const pending = repoRootsInFlight.get(cwd);
  if (pending !== undefined) return pending;
  const promise = discoverRepoRoots(cwd).then(
    (roots) => {
      repoRootsCache.set(cwd, { roots, expires: Date.now() + DISCOVERY_CACHE_TTL_MS });
      repoRootsInFlight.delete(cwd);
      return roots;
    },
    (error: unknown) => {
      repoRootsInFlight.delete(cwd);
      throw error;
    },
  );
  repoRootsInFlight.set(cwd, promise);
  return promise;
}

async function discoverRepoRoots(cwd: string): Promise<string[]> {
  try {
    return [await directRepoRoot(cwd)];
  } catch {
    // cwd isn't itself inside a repo — treat as a workspace container and
    // probe immediate child directories.
    const entries = await readdir(cwd, { withFileTypes: true }).catch(() => []);
    const roots: string[] = [];
    for (const entry of entries
      .filter(
        (e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules',
      )
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, DISCOVERY_LIMIT)) {
      try {
        const root = await directRepoRoot(join(cwd, entry.name));
        if (!roots.some((existing) => pathIdentity(existing) === pathIdentity(root))) {
          roots.push(root);
        }
      } catch {
        // Ordinary child directory; keep discovering sibling repositories.
      }
    }
    return roots;
  }
}

/** Platform-aware identity used only for comparing absolute checkout roots.
 *  macOS aliases (/tmp → /private/tmp, /var → /private/var) are normalised
 *  via realpathSync so a `mkdtempSync(tmpdir())` path matches the path git
 *  prints in `worktree list`. */
function pathIdentity(path: string): string {
  const absolute = resolve(path).replace(/[\\/]+$/, '');
  const real = safeRealpath(absolute);
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/** best-effort realpath; falls back to the input if the path doesn't exist
 *  yet (e.g. when a caller asks about a hypothetical worktree target). */
function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Resolve the selected repository, defaulting to the first discovered root.
 *  Git for Windows may return forward-slash roots while callers pass
 *  backslashes (or vice-versa); we compare via the platform-aware identity. */
export async function repoRoot(cwd: string, selected?: string): Promise<string> {
  const roots = await repoRoots(cwd);
  if (roots.length === 0) {
    throw new GitCommandError('not a git repository', 'not-repo', 'rev-parse');
  }
  if (selected !== undefined) {
    const identity = pathIdentity(selected);
    const match = roots.find((root) => pathIdentity(root) === identity);
    if (match !== undefined) return match;
  }
  return roots[0]!;
}

/** The current branch name (`git rev-parse --abbrev-ref HEAD`; 'HEAD' when detached). */
export async function currentBranch(cwd: string): Promise<string> {
  const out = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return out.trim();
}

// ────────────────────────────────────────────────────────────────────────────
// Status
// ────────────────────────────────────────────────────────────────────────────

/** Upper bound on status rows shipped to the client. Beyond this the result
 *  is truncated (with `truncated: true`) so a pathological untracked set
 *  cannot freeze the browser main thread on JSON parse or list render. */
const GIT_STATUS_LIMIT = 2_000;

/** Working-tree status (untracked included). `--untracked-files=all` lists
 *  the contents of new directories as individual entries. */
export async function status(cwd: string, selected?: string): Promise<GitStatusResult> {
  const repositories = await repoRoots(cwd).catch(() => [] as string[]);
  if (repositories.length === 0) {
    // Throw rather than return `{ isRepo: false }` so the route layer's
    // envelope translates the failure into `{ ok: false, error }` instead
    // of leaking an `isRepo:false` payload alongside `ok:true`. The
    // dedicated `is-repo` action stays the boolean probe.
    throw new GitCommandError('not a git repository', 'not-repo', 'rev-parse');
  }
  const root = await repoRoot(cwd, selected);
  const [branch, raw] = await Promise.all([
    currentBranch(root).catch(() => 'HEAD'),
    runGit(root, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]),
  ]);
  const parsed = parsePorcelainZ(raw);
  const truncated = parsed.length > GIT_STATUS_LIMIT;
  return {
    isRepo: true,
    branch,
    entries: truncated ? parsed.slice(0, GIT_STATUS_LIMIT) : parsed,
    truncated,
    root,
    repositories,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Diff
// ────────────────────────────────────────────────────────────────────────────

/** Diff text of the worktree (unstaged) or the index (staged). `-U3` keeps
 *  context compact; `--no-color` guarantees no ANSI codes reach the UI. */
export async function diff(
  cwd: string,
  path?: string,
  staged = false,
  selected?: string,
): Promise<string> {
  const root = await repoRoot(cwd, selected);
  const args = ['diff', '--no-ext-diff', '--no-color', '-U3'];
  if (staged) args.push('--cached');
  if (path !== undefined) args.push('--', path);
  return runGit(root, args);
}

/** Diff text of a single commit (`git show` with the commit header suppressed).
 *  Merge commits show their diff against the first parent (`-m --first-parent`
 *  is a no-op for regular commits), so a history click always has content. */
export async function commitDiff(cwd: string, hash: string, selected?: string): Promise<string> {
  const root = await repoRoot(cwd, selected);
  return runGit(root, [
    'show',
    '--no-ext-diff',
    '--no-color',
    '--format=',
    '-m',
    '--first-parent',
    hash,
  ]);
}

/** Recent commit history (newest first), lazily pageable via skip/count. */
export async function log(
  cwd: string,
  count = 30,
  skip = 0,
  selected?: string,
): Promise<GitLogEntry[]> {
  const root = await repoRoot(cwd, selected);
  const raw = await runGit(root, [
    'log',
    '-n',
    String(count),
    '--skip',
    String(skip),
    '--decorate=short',
    '--pretty=format:%h%x1f%s%x1f%an%x1f%ai%x1f%H%x1f%D',
  ]);
  return parseLogLines(raw);
}

/** Content of a file at a revision (`git show <rev>:<path>`), or null when the
 *  revision has no such path (a new/untracked file has no HEAD side). */
export async function show(
  cwd: string,
  rev: string,
  path: string,
  selected?: string,
): Promise<string | null> {
  try {
    return await runGit(await repoRoot(cwd, selected), ['show', `${rev}:${path}`]);
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Mutating operations
// ────────────────────────────────────────────────────────────────────────────

/** Stage paths (all when path is undefined). */
export async function stage(cwd: string, path?: string, selected?: string): Promise<void> {
  await runGit(await repoRoot(cwd, selected), [
    'add',
    '-A',
    ...(path !== undefined ? ['--', path] : []),
  ]);
}

/** Unstage paths (all when path is undefined). */
export async function unstage(cwd: string, path?: string, selected?: string): Promise<void> {
  await runGit(await repoRoot(cwd, selected), [
    'reset',
    '-q',
    ...(path !== undefined ? ['--', path] : []),
  ]);
}

/** Commit the staged changes with a message (global identity untouched). */
export async function commit(
  cwd: string,
  message: string,
  selected?: string,
): Promise<void> {
  await runGit(await repoRoot(cwd, selected), ['commit', '-m', message]);
}

/** Discard the worktree changes of one path (`git checkout -- <path>`; the
 *  index is untouched). For untracked files the caller is responsible for
 *  deleting the file — see `revert()` for the combined handler. */
export async function discard(
  cwd: string,
  path: string,
  selected?: string,
): Promise<void> {
  await runGit(await repoRoot(cwd, selected), ['checkout', '--', path]);
}

/** Revert one commit onto the current branch with an auto-generated message. */
export async function cherryPick(cwd: string, hash: string, selected?: string): Promise<void> {
  await runGit(await repoRoot(cwd, selected), ['cherry-pick', hash]);
}

// ────────────────────────────────────────────────────────────────────────────
// Branches & worktrees
// ────────────────────────────────────────────────────────────────────────────

/** Branch listing with ahead/behind vs upstream. The format string is NUL-
 *  framed to defeat any refname with embedded whitespace. */
export async function branches(
  cwd: string,
  selected?: string,
): Promise<GitBranchEntry[]> {
  const root = await repoRoot(cwd, selected);
  const raw = await runGit(root, [
    'for-each-ref',
    '--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(subject)',
    'refs/heads',
  ]);
  return parseBranchEntries(raw, 'tracked');
}

/** Switch to an existing branch. */
export async function checkout(cwd: string, branch: string): Promise<string> {
  const out = await runGit(cwd, ['checkout', branch]);
  // `Switched to branch 'main'` / `Switched to a new branch 'feature/x'` —
  // extract the quoted name as the canonical confirmation.
  const match = /Switched to (?:a new )?branch ['"]([^'"]+)['"]/.exec(out);
  return match?.[1] ?? branch;
}

/** Whether the current Git binary supports NUL-framed `worktree list` output.
 *  Git < 2.36 rejects `-z`; cache the capability after the first attempt so
 *  the panel's polling does not repeatedly spawn a command known to fail. */
let worktreeListSupportsZ: boolean | undefined;

/** Raw usable checkout records, shared by inventory and target validation.
 *  Prunable records point at missing paths and are deliberately excluded
 *  from both the selector and the command-target allowlist. */
async function listedWorktrees(cwd: string): Promise<GitWorktreeRecord[]> {
  let raw: string;
  if (worktreeListSupportsZ === false) {
    raw = await runGit(cwd, ['worktree', 'list', '--porcelain']);
  } else {
    try {
      raw = await runGit(cwd, ['worktree', 'list', '--porcelain', '-z']);
      worktreeListSupportsZ = true;
    } catch {
      worktreeListSupportsZ = false;
      raw = await runGit(cwd, ['worktree', 'list', '--porcelain']);
    }
  }
  return parseWorktreeList(raw).filter((entry) => !entry.prunable);
}

/** All linked checkouts of the repository containing `cwd`, enriched with a
 *  live change count. The current checkout is first so a single-worktree repo
 *  preserves the old UI ordering. */
export async function worktrees(cwd: string): Promise<GitWorktree[]> {
  if (!(await isRepo(cwd))) return [];
  const currentRoot = await repoRoot(cwd);
  const listed = await listedWorktrees(cwd);
  const rows = await Promise.all(
    listed.map(
      async (entry): Promise<GitWorktree> => ({
        path: entry.path,
        branch: entry.branch,
        current: pathIdentity(entry.path) === pathIdentity(currentRoot),
        // One stale/permission-raced linked checkout must not hide the valid
        // current repository from the panel. Targeted operations still fail loud.
        changes: await status(entry.path)
          .then((result) => result.entries.length)
          .catch(() => 0),
      }),
    ),
  );
  return rows.sort((left, right) => Number(right.current) - Number(left.current));
}

/** Resolve an optional client-selected linked checkout. A caller may never use
 *  this seam to point Git operations at an unrelated repository: the target
 *  must occur in the authoritative session repository's worktree list. */
export async function resolveWorktree(
  cwd: string,
  requested?: string,
): Promise<string> {
  if (requested === undefined || requested === '') return cwd;
  const identity = pathIdentity(requested);
  const match = (await listedWorktrees(cwd)).find(
    (entry) => pathIdentity(entry.path) === identity,
  );
  if (match === undefined) {
    throw new GitCommandError(
      `unknown linked worktree: ${requested}`,
      'git-worktree',
      'worktree list',
    );
  }
  return match.path;
}

// ────────────────────────────────────────────────────────────────────────────
// Reset (test hooks only — the in-memory discovery cache otherwise lives the
// life of the process, which matches the zai server's lifetime).
// ────────────────────────────────────────────────────────────────────────────

/** @internal — wipe cached repo roots. Used by tests; not exported via index. */
export function __resetRepoRootsCacheForTests(): void {
  repoRootsCache.clear();
  repoRootsInFlight.clear();
  worktreeListSupportsZ = undefined;
}

// Re-export path helpers for the route layer.
export { sep as pathSep };