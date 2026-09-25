/**
 * Git review panel routes — single endpoint with action dispatch.
 *
 * Mount: `app.use('/api', gitRouter)` (see index.ts). Final path:
 * `POST /api/git` with body `{ action, cwd, ...actionParams }`.
 *
 * Response shape is intentionally loose: every action returns
 * `{ ok: boolean, error?: string, ...actionSpecificFields }` so legacy
 * callers (BranchSelector, MobileQuickDrawer → gitApi.{revertFile,
 * listBranches, switchBranch}) keep working without reshaping.
 *
 * All git work goes through `gitService` — see `services/gitService.ts`.
 * The service owns spawn/cache/parsing; the route layer is a thin
 * dispatcher that converts HTTP into service calls and translates
 * `GitCommandError` into `{ ok: false, error }` envelopes.
 */
import { Router, type IRouter, type Request } from 'express';
import { unlink } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import {
  GitCommandError,
  branches as svcBranches,
  checkout as svcCheckout,
  cherryPick as svcCherryPick,
  commit as svcCommit,
  commitDiff as svcCommitDiff,
  currentBranch as svcCurrentBranch,
  diff as svcDiff,
  discard as svcDiscard,
  isRepo as svcIsRepo,
  log as svcLog,
  repoRoot as svcRepoRoot,
  repoRoots as svcRepoRoots,
  resolveWorktree as svcResolveWorktree,
  stage as svcStage,
  status as svcStatus,
  unstage as svcUnstage,
  worktrees as svcWorktrees,
} from '../services/gitService.js';
import { resolveSafePath } from '../utils/safePath.js';

// ────────────────────────────────────────────────────────────────────────────
// Instance context (cwd injected per-instance, identical to other routes).
// ────────────────────────────────────────────────────────────────────────────

interface InstanceContextShape {
  cwd: string;
  cwdName: string;
}

function ctx(req: Request): InstanceContextShape {
  return req.app.locals.instanceContext as InstanceContextShape;
}

interface RawBody {
  action?: unknown;
  cwd?: unknown;
  // common action params (loose typing — action handlers narrow them)
  path?: unknown;
  selected?: unknown;
  staged?: unknown;
  message?: unknown;
  hash?: unknown;
  branch?: unknown;
  requested?: unknown;
  count?: unknown;
  skip?: unknown;
  // Allow arbitrary additional keys so helpers like `body[field]` compile
  // without forcing every handler to widen the type manually.
  [key: string]: unknown;
}

/** Body field expected as string. Returns the string or sets `error` and
 *  yields control via a tuple-style return. */
function requireString(body: RawBody, field: string): string | { error: string } {
  const value = body[field];
  if (typeof value !== 'string' || value === '') {
    return { error: `缺少 ${field} 参数` };
  }
  return value;
}

function optionalString(body: RawBody, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function optionalNumber(body: RawBody, field: string): number | undefined {
  const value = body[field];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value !== '' && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function optionalBool(body: RawBody, field: string): boolean | undefined {
  const value = body[field];
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/** Translate a service error into a JSON envelope. Known GitCommandError
 *  codes bubble up; anything else is wrapped as `internal-error`. */
function envelope<T extends Record<string, unknown>>(
  ok: true,
  payload: T,
): { ok: true } & T;
function envelope(ok: false, error: string): { ok: false; error: string };
function envelope(ok: boolean, arg: string | Record<string, unknown>) {
  if (ok) return { ok: true, ...(arg as Record<string, unknown>) };
  return { ok: false, error: arg as string };
}

/** Wrap a service call so any `GitCommandError` (or generic throw) becomes
 *  `{ ok: false, error }` rather than a 500. */
async function safe<T>(run: () => Promise<T>, onOk: (value: T) => Record<string, unknown>) {
  try {
    const result = await run();
    return envelope(true, onOk(result));
  } catch (error) {
    const message =
      error instanceof GitCommandError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    return envelope(false, message);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Per-path security helper
// ────────────────────────────────────────────────────────────────────────────

/** Resolve `rel` inside the session's git root, rejecting any path that
 *  escapes. Caller passes the `gitRoot` from `repoRoot()`; this helper
 *  wraps `resolveSafePath` with the git-root prefix. */
function resolveGitPath(
  gitRoot: string,
  rel: string,
): { ok: true; rel: string } | { ok: false; error: string } {
  const safe = resolveSafePath(gitRoot, rel);
  if (!safe.ok) return safe;
  const gitPath = relative(gitRoot, safe.abs);
  // Belt-and-braces: resolveSafePath returns ok for paths INSIDE root,
  // but `relative` on the root itself returns '' — treat that as a
  // valid "the repo itself" selector.
  if (gitPath.startsWith('..')) {
    return { ok: false, error: 'path 不在 Git 仓库内' };
  }
  return { ok: true, rel: gitPath };
}

// ────────────────────────────────────────────────────────────────────────────
// Route
// ────────────────────────────────────────────────────────────────────────────

export const gitRouter: IRouter = Router();

gitRouter.post('/git', async (req, res) => {
  const body = (req.body ?? {}) as RawBody;
  const action = typeof body.action === 'string' ? body.action : '';

  // `cwd` override (e.g. resolveWorktree can return a different checkout).
  // For actions like `resolve-worktree` itself, `cwd` is still required so
  // we know which repo's worktree list to consult.
  const cwdRaw = optionalString(body, 'cwd');
  const cwd = cwdRaw ?? ctx(req).cwd;

  switch (action) {
    case 'is-repo': {
      const ok = await svcIsRepo(cwd).catch(() => false);
      res.json(envelope(true, { isRepo: ok }));
      return;
    }

    case 'status': {
      const selected = optionalString(body, 'selected');
      const value = await safe(
        () => svcStatus(cwd, selected),
        (result) => ({
          branch: result.branch ?? null,
          entries: result.entries,
          truncated: result.truncated ?? false,
          root: result.root ?? null,
          repositories: result.repositories ?? [],
        }),
      );
      res.json(value);
      return;
    }

    case 'diff': {
      const pathField = requireString(body, 'path');
      if (typeof pathField !== 'string') {
        res.status(400).json(envelope(false, pathField.error));
        return;
      }
      const selected = optionalString(body, 'selected');
      const staged = optionalBool(body, 'staged') ?? false;
      const value = await safe(async () => {
        const root = await svcRepoRoot(cwd, selected);
        const resolved = resolveGitPath(root, pathField);
        if (!resolved.ok) throw new GitCommandError(resolved.error, 'bad-path', 'diff');
        const text = await svcDiff(cwd, resolved.rel, staged, selected);
        return { diff: text, isUntracked: false };
      }, ({ diff, isUntracked }) => ({ diff, isUntracked }));
      res.json(value);
      return;
    }

    case 'stage': {
      const pathField = requireString(body, 'path');
      if (typeof pathField !== 'string') {
        res.status(400).json(envelope(false, pathField.error));
        return;
      }
      const selected = optionalString(body, 'selected');
      const value = await safe(async () => {
        const root = await svcRepoRoot(cwd, selected);
        const resolved = resolveGitPath(root, pathField);
        if (!resolved.ok) throw new GitCommandError(resolved.error, 'bad-path', 'add');
        await svcStage(cwd, resolved.rel, selected);
        return {};
      }, () => ({}));
      res.json(value);
      return;
    }

    case 'unstage': {
      const pathField = requireString(body, 'path');
      if (typeof pathField !== 'string') {
        res.status(400).json(envelope(false, pathField.error));
        return;
      }
      const selected = optionalString(body, 'selected');
      const value = await safe(async () => {
        const root = await svcRepoRoot(cwd, selected);
        const resolved = resolveGitPath(root, pathField);
        if (!resolved.ok) throw new GitCommandError(resolved.error, 'bad-path', 'reset');
        await svcUnstage(cwd, resolved.rel, selected);
        return {};
      }, () => ({}));
      res.json(value);
      return;
    }

    case 'revert': {
      // Matches the legacy semantics: untracked → unlink; tracked → checkout --.
      const pathField = requireString(body, 'path');
      if (typeof pathField !== 'string') {
        res.status(400).json(envelope(false, pathField.error));
        return;
      }
      const selected = optionalString(body, 'selected');
      const value = await safe(async () => {
        const root = await svcRepoRoot(cwd, selected);
        const resolved = resolveGitPath(root, pathField);
        if (!resolved.ok) throw new GitCommandError(resolved.error, 'bad-path', 'revert');
        const status = await svcStatus(cwd, selected);
        const entry = status.entries.find((e) => e.path === resolved.rel);
        const isUntracked = entry?.xy === '??';
        if (isUntracked) {
          const safe = resolveSafePath(root, resolved.rel);
          if (!safe.ok) throw new GitCommandError(safe.error, 'bad-path', 'unlink');
          await unlink(safe.abs);
        } else {
          await svcDiscard(cwd, resolved.rel, selected);
        }
        return { isUntracked };
      }, ({ isUntracked }) => ({ isUntracked }));
      res.json(value);
      return;
    }

    case 'commit': {
      const message = requireString(body, 'message');
      if (typeof message !== 'string') {
        res.status(400).json(envelope(false, message.error));
        return;
      }
      const selected = optionalString(body, 'selected');
      const value = await safe(async () => {
        await svcCommit(cwd, message, selected);
        const branch = await svcCurrentBranch(cwd).catch(() => null);
        return { branch };
      }, ({ branch }) => ({ branch: branch ?? null }));
      res.json(value);
      return;
    }

    case 'log': {
      const count = optionalNumber(body, 'count') ?? 30;
      const skip = optionalNumber(body, 'skip') ?? 0;
      const selected = optionalString(body, 'selected');
      const value = await safe(
        () => svcLog(cwd, count, skip, selected),
        (entries) => ({ entries }),
      );
      res.json(value);
      return;
    }

    case 'commit-diff': {
      const hash = requireString(body, 'hash');
      if (typeof hash !== 'string') {
        res.status(400).json(envelope(false, hash.error));
        return;
      }
      const selected = optionalString(body, 'selected');
      const value = await safe(
        () => svcCommitDiff(cwd, hash, selected),
        (diff) => ({ diff }),
      );
      res.json(value);
      return;
    }

    case 'branches': {
      const selected = optionalString(body, 'selected');
      const value = await safe(
        () => svcBranches(cwd, selected),
        (branches) => ({ branches }),
      );
      res.json(value);
      return;
    }

    case 'checkout': {
      const branch = requireString(body, 'branch');
      if (typeof branch !== 'string') {
        res.status(400).json(envelope(false, branch.error));
        return;
      }
      const value = await safe(async () => {
        const result = await svcCheckout(cwd, branch);
        return { branch: result };
      }, ({ branch: name }) => ({ branch: name ?? null }));
      res.json(value);
      return;
    }

    case 'worktrees': {
      const value = await safe(
        () => svcWorktrees(cwd),
        (worktrees) => ({ worktrees }),
      );
      res.json(value);
      return;
    }

    case 'resolve-worktree': {
      const requested = requireString(body, 'requested');
      if (typeof requested !== 'string') {
        res.status(400).json(envelope(false, requested.error));
        return;
      }
      const value = await safe(async () => {
        // First check that cwd is a repo at all — otherwise resolveWorktree
        // would falsely return cwd itself for "not in a worktree".
        const repos = await svcRepoRoots(cwd).catch(() => [] as string[]);
        if (repos.length === 0) {
          throw new GitCommandError('not a git repository', 'not-repo', 'rev-parse');
        }
        const path = await svcResolveWorktree(cwd, requested);
        return { path };
      }, ({ path }) => ({ path }));
      res.json(value);
      return;
    }

    default: {
      res.status(400).json(envelope(false, `未知 action: ${action || '(empty)'}`));
    }
  }
});

export default gitRouter;

// Re-export resolve helpers so tests can probe the same surface.
export { resolveGitPath };
// Keep the path helper around for callers that need a fully-resolved cwd
// (e.g. tests asserting that `relative` produces a clean relative path).
export function resolveCwd(req: Request): string {
  return resolve(ctx(req).cwd);
}