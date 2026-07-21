import { Router, type IRouter } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveSafePath } from '../utils/safePath.js';
import type { GitDiff, GitStatus, GitStatusChar, GitStatusFile } from '../../shared/git.js';

const execFileAsync = promisify(execFile);

const MAX_DIFF_BYTES = 2 * 1024 * 1024; // 2 MB

interface InstanceContextShape {
  cwd: string;
  cwdName: string;
}

function ctx(req: express.Request): InstanceContextShape {
  return req.app.locals.instanceContext as InstanceContextShape;
}

function mapStatus(staged: string, unstaged: string): { status: GitStatusChar; staged: boolean } {
  // Prefer the unstaged column when non-space (modified-in-workdir is what
  // users want to see). Fall back to the staged column.
  if (unstaged === '?') return { status: '??', staged: false };
  if (unstaged !== ' ') return { status: unstaged as GitStatusChar, staged: staged !== ' ' };
  if (staged !== ' ') return { status: staged as GitStatusChar, staged: true };
  // Shouldn't happen for porcelain output, but fall back to M.
  return { status: 'M', staged: false };
}

export const gitRouter: IRouter = Router();

gitRouter.get('/git/status', async (req, res) => {
  const { cwd } = ctx(req);
  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, timeout: 3000 });
  } catch {
    const body: GitStatus = { ok: false, error: 'not a git repository' };
    res.json(body);
    return;
  }
  try {
    const [statusOut, branchOut] = await Promise.all([
      // `-u normal` is the documented default untracked-file mode, but
      // the brief's two-arg form (`-u`, `normal`) makes git consume
      // `normal` as a pathspec on git 2.37 (macOS CLT) and return empty
      // output. Use the single-arg `-unormal` form recommended in
      // `git status --help` so behavior matches the spec's intent.
      execFileAsync('git', ['status', '--porcelain=v1', '-unormal'], { cwd, timeout: 5000 }),
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 3000 }).catch(() => ({ stdout: '' })),
    ]);
    const files: GitStatusFile[] = statusOut.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        // porcelain v1: "<XY> <path>" where XY is two chars and path starts at col 3
        const staged = line[0] ?? ' ';
        const unstaged = line[1] ?? ' ';
        const path = line.slice(3);
        const mapped = mapStatus(staged, unstaged);
        return { path, status: mapped.status, staged: mapped.staged };
      });
    const body: GitStatus = {
      ok: true,
      branch: branchOut.stdout.trim() || null,
      files,
    };
    res.json(body);
  } catch (err) {
    const body: GitStatus = { ok: false, error: `git status 失败: ${err instanceof Error ? err.message : String(err)}` };
    res.json(body);
  }
});

gitRouter.get('/git/diff', async (req, res) => {
  const { cwd } = ctx(req);
  const rel = typeof req.query.path === 'string' ? req.query.path : '';
  if (!rel) {
    const body: GitDiff = { ok: false, error: '缺少 path 参数' };
    res.status(400).json(body);
    return;
  }
  const safe = resolveSafePath(cwd, rel);
  if (!safe.ok) {
    const body: GitDiff = { ok: false, error: safe.error };
    res.json(body);
    return;
  }
  // Decide whether the file is untracked. We use `git status --porcelain`
  // for this so the diff endpoint is the single source of truth — the UI
  // doesn't have to pre-classify.
  let isUntracked = false;
  try {
    const { stdout } = await execFileAsync(
      'git',
      // `-unormal` (single-arg) keeps parity with the status endpoint;
      // the brief's two-arg form (`-u`, `normal`) is parsed as a pathspec
      // on git 2.37 (macOS CLT). `-- <rel>` narrows the search to that path.
      ['status', '--porcelain=v1', '-unormal', '--', rel],
      { cwd, timeout: 3000 },
    );
    isUntracked = stdout.trimStart().startsWith('??');
  } catch {
    isUntracked = false;
  }

  let diff = '';
  try {
    if (isUntracked) {
      // `git diff --no-index` exits 1 when the files differ, which we treat
      // as success (the diff is the desired output).
      const result = await execFileAsync(
        'git',
        ['diff', '--no-color', '--no-index', '--', '/dev/null', safe.abs],
        { cwd, timeout: 5000, maxBuffer: MAX_DIFF_BYTES * 2 },
      ).catch((err: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => ({
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
      }));
      // `git diff --no-index` emits two header lines ("diff --git ..." and
      // "new file mode ...") before the unified-diff hunk header. Strip
      // them so the unified format is consistent with the tracked branch.
      diff = result.stdout.replace(/^diff --git.*\nnew file mode.*\n/m, '');
    } else {
      const { stdout } = await execFileAsync(
        'git',
        ['diff', '--no-color', 'HEAD', '--', rel],
        { cwd, timeout: 5000, maxBuffer: MAX_DIFF_BYTES * 2 },
      );
      diff = stdout;
    }
  } catch (err) {
    const body: GitDiff = { ok: false, error: `git diff 失败: ${err instanceof Error ? err.message : String(err)}` };
    res.json(body);
    return;
  }

  if (diff.length > MAX_DIFF_BYTES) {
    const mb = (diff.length / 1024 / 1024).toFixed(2);
    const body: GitDiff = { ok: false, error: `diff 过大 (${mb} MB > 2 MB)，暂不支持预览` };
    res.json(body);
    return;
  }

  const body: GitDiff = { ok: true, diff, isUntracked };
  res.json(body);
});

export default gitRouter;
