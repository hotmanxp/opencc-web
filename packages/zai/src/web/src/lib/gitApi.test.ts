// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gitApi } from './gitApi.js';

vi.mock('./api.js', () => ({
  api: {
    post: vi.fn(),
  },
}));

import { api } from './api.js';

const mockPost = api.post as unknown as ReturnType<typeof vi.fn>;

describe('gitApi', () => {
  beforeEach(() => {
    mockPost.mockReset();
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
