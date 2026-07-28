import { spawn } from 'node:child_process'

/**
 * Run an async function inside a fresh git worktree. After the
 * function returns, the helper inspects the worktree for uncommitted
 * changes via `git diff`. If the diff is empty, the worktree is
 * removed (no observable side effects); if files were modified, the
 * worktree is kept and `changed:true` is returned so the caller can
 * surface the worktree path (e.g. in a UI for inspection).
 *
 * Use case: parallel `agent({isolation:'worktree'})` calls that
 * each make their own edits without conflicting on the main
 * working tree. The caller can `git merge` the surviving worktrees
 * (or `git diff` them for review) once the agents finish.
 *
 * Implementation notes:
 * - Worktree paths live under `/tmp/opencc-worktree-<id>` where
 *   `<id>` is the caller's `worktreeId`. Stale paths are tolerated
 *   (worktree add fails if path exists with a non-empty dir; we
 *   surface that error to the caller rather than auto-cleaning
 *   unknown paths — too dangerous if the dir is from a different
 *   process).
 * - `fs` is injectable for tests. The default implementation
 *   shells out to `git worktree add` / `git worktree remove
 *   --force` / `git diff`.
 * - The run function receives the worktree path as its argument
 *   so it can `process.chdir(worktreePath)` (or pass it to tools
 *   that take an explicit cwd).
 */
export type IsolationFs = {
  worktreeAdd: (path: string) => Promise<void>
  worktreeRemove: (path: string) => Promise<void>
  gitDiff: (worktreePath: string) => Promise<string>
}

export type IsolationOpts<T> = {
  repoRoot: string
  worktreeId: string
  fs?: IsolationFs
  /**
   * If true, never auto-remove the worktree even if it's unchanged.
   * Use case: caller wants the path back for inspection regardless.
   */
  alwaysKeep?: boolean
  run: (worktreePath: string) => Promise<T>
}

export type IsolationResult<T> = {
  report: T
  worktreePath: string
  changed: boolean
}

/** Resolve the worktree path for a given id. Pure helper so tests
 *  can assert paths without mocking. */
export function worktreePathFor(worktreeId: string): string {
  return `/tmp/opencc-worktree-${worktreeId}`
}

export async function withWorktreeIsolation<T>(
  opts: IsolationOpts<T>,
): Promise<IsolationResult<T>> {
  const wtPath = worktreePathFor(opts.worktreeId)
  const fs = opts.fs ?? realFs(opts.repoRoot)

  await fs.worktreeAdd(wtPath)

  try {
    const report = await opts.run(wtPath)
    const diff = await fs.gitDiff(wtPath)
    const changed = diff.trim().length > 0

    if (!changed && !opts.alwaysKeep) {
      await fs.worktreeRemove(wtPath)
    }

    return { report, worktreePath: wtPath, changed }
  } catch (e) {
    // Best-effort cleanup on run failure
    try { await fs.worktreeRemove(wtPath) } catch {}
    throw e
  }
}

/**
 * Default FS implementation: shells out to `git`. The `repoRoot` is
 * captured in the closure so callers don't have to pass it on every
 * call.
 */
function realFs(repoRoot: string): IsolationFs {
  return {
    worktreeAdd: async (path) => {
      await execGit(['worktree', 'add', path, 'HEAD'], repoRoot)
    },
    worktreeRemove: async (path) => {
      await execGit(['worktree', 'remove', '--force', path], repoRoot)
    },
    gitDiff: async (worktreePath) => {
      // `git diff` inside the worktree shows working-tree-vs-HEAD changes
      return execGit(['diff'], worktreePath)
    },
  }
}

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', d => { stdout += d.toString() })
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.on('close', code => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`git ${args.join(' ')} failed (${code}): ${stderr}`))
    })
  })
}

/**
 * Standalone cleanup helper for the (rare) case where the caller
 * wants to keep the worktree at first and clean it up later — e.g.
 * if it surfaces the worktree path in a UI for inspection before
 * deciding.
 */
export async function cleanupUnchangedWorktree(
  worktreePath: string,
  repoRoot: string,
): Promise<void> {
  const fs = realFs(repoRoot)
  const diff = await fs.gitDiff(worktreePath)
  if (diff.trim().length === 0) {
    await fs.worktreeRemove(worktreePath)
  }
}
