// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gitApi } from './gitApi.js';
import type { SseEvent } from '../../../shared/types.js';

vi.mock('./api.js', () => ({
  api: {
    post: vi.fn(),
  },
}));

import { api } from './api.js';

const mockPost = api.post as unknown as ReturnType<typeof vi.fn>;

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function sseResponse(events: SseEvent[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('gitApi', () => {
  beforeEach(() => {
    mockPost.mockReset();
    fetchMock.mockReset();
  });

  it('calls POST /git/revert with path', async () => {
    mockPost.mockResolvedValue({ ok: true });
    const result = await gitApi.revertFile('src/foo.ts');
    expect(mockPost).toHaveBeenCalledWith('/git/revert', { path: 'src/foo.ts' });
    expect(result).toEqual({ ok: true });
  });

  it('returns error result when revert fails', async () => {
    mockPost.mockResolvedValue({ ok: false, error: 'git checkout failed' });
    const result = await gitApi.revertFile('src/bar.ts');
    expect(result).toEqual({ ok: false, error: 'git checkout failed' });
  });

  it('propagates network errors', async () => {
    mockPost.mockRejectedValue(new Error('network error'));
    await expect(gitApi.revertFile('src/baz.ts')).rejects.toThrow('network error');
  });

  it('returns isUntracked flag for new files', async () => {
    mockPost.mockResolvedValue({ ok: true, isUntracked: true });
    const result = await gitApi.revertFile('src/new.ts');
    expect(result.isUntracked).toBe(true);
  });
});

describe('gitApi.listBranches (复用 /exec 通用接口)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('parses local + remote refs from git for-each-ref output', async () => {
    // 真实 git for-each-ref --format='%(HEAD)%00%(refname)%00%(objecttype)'
    // 输出形如下面 (行内 \0 分隔三列).
    const stdout =
      '*\0refs/heads/main\0commit\n' +
      ' \0refs/heads/feature/x\0commit\n' +
      ' \0refs/remotes/origin/main\0commit\n' +
      ' \0refs/remotes/origin/feature/y\0commit\n';
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        { type: 'stdout', line: stdout.trim() },
        { type: 'exit', code: 0 },
      ]),
    );

    const result = await gitApi.listBranches('/tmp/repo');
    expect(result.ok).toBe(true);
    expect(result.branches).toEqual([
      { name: 'main', isCurrent: true, isRemote: false },
      { name: 'feature/x', isCurrent: false, isRemote: false },
      { name: 'origin/main', isCurrent: false, isRemote: true },
      { name: 'origin/feature/y', isCurrent: false, isRemote: true },
    ]);

    // 验证走 /exec 通用接口: cmd 是 git, cwd 透传.
    const init = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(init?.body ?? '{}');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/exec');
    expect(body.cmd).toBe('git');
    expect(body.cwd).toBe('/tmp/repo');
    expect(body.args[0]).toBe('for-each-ref');
    expect(body.args).toContain('refs/heads');
    expect(body.args).toContain('refs/remotes');
  });

  it('parses stdout split across multiple SSE events', async () => {
    // spawner 把 stdout 按 \n 切行, 多个 stdout 事件拼起来才是一行完整记录.
    const events: SseEvent[] = [
      { type: 'stdout', line: '*\0refs/heads/main\0commit' },
      { type: 'stdout', line: ' \0refs/heads/dev\0commit' },
      { type: 'exit', code: 0 },
    ];
    fetchMock.mockResolvedValueOnce(sseResponse(events));

    const result = await gitApi.listBranches('/tmp/repo');
    expect(result.ok).toBe(true);
    expect(result.branches?.map((b) => b.name)).toEqual(['main', 'dev']);
    expect(result.branches?.find((b) => b.name === 'main')?.isCurrent).toBe(true);
  });

  it('filters out detached HEAD ref', async () => {
    // detached HEAD 时会出现 "HEAD" 条目 (refs/heads/HEAD), UI 不该显示.
    const stdout = ' \0refs/heads/HEAD\0commit\n' + '*\0refs/heads/main\0commit\n';
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        { type: 'stdout', line: stdout.trim() },
        { type: 'exit', code: 0 },
      ]),
    );

    const result = await gitApi.listBranches('/tmp/repo');
    expect(result.ok).toBe(true);
    expect(result.branches?.map((b) => b.name)).toEqual(['main']);
  });

  it('returns ok:false with stderr first line when git exits non-zero', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        { type: 'stderr', line: 'fatal: not a git repository' },
        { type: 'exit', code: 128 },
      ]),
    );
    const result = await gitApi.listBranches('/tmp/not-repo');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('fatal: not a git repository');
  });

  it('returns ok:false on HTTP failure', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{"error":"command not allowed"}', {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const result = await gitApi.listBranches('/tmp/x');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/command not allowed/);
  });
});

describe('gitApi.switchBranch (复用 /exec 通用接口)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('parses "Switched to branch X" stdout and returns ok', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        { type: 'stdout', line: "Switched to branch 'feature/x'" },
        { type: 'stdout', line: 'Your branch is up to date.' },
        { type: 'exit', code: 0 },
      ]),
    );

    const result = await gitApi.switchBranch('/tmp/repo', 'feature/x');
    expect(result.ok).toBe(true);
    expect(result.branch).toBe('feature/x');

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body ?? '{}');
    expect(body.cmd).toBe('git');
    expect(body.cwd).toBe('/tmp/repo');
    expect(body.args).toEqual(['checkout', 'feature/x']);
  });

  it('handles "Switched to a new branch" message', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        { type: 'stdout', line: "Switched to a new branch 'feature/new'" },
        { type: 'exit', code: 0 },
      ]),
    );
    const result = await gitApi.switchBranch('/tmp/repo', 'feature/new');
    expect(result.ok).toBe(true);
    expect(result.branch).toBe('feature/new');
  });

  it('returns ok:false when checkout refuses (uncommitted changes)', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        {
          type: 'stderr',
          line: 'error: Your local changes to the following files would be overwritten by checkout:',
        },
        { type: 'stderr', line: '        a.txt' },
        { type: 'stderr', line: 'Please commit your changes or stash them before you switch branches.' },
        { type: 'stderr', line: 'Aborting' },
        { type: 'exit', code: 1 },
      ]),
    );
    const result = await gitApi.switchBranch('/tmp/repo', 'main');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/overwritten by checkout/);
  });

  it('returns ok:false when branch does not exist', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        { type: 'stderr', line: "error: pathspec 'no-such-branch' did not match any file(s) known to git" },
        { type: 'exit', code: 1 },
      ]),
    );
    const result = await gitApi.switchBranch('/tmp/repo', 'no-such-branch');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/pathspec/);
  });
});