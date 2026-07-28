import { describe, expect, it } from 'bun:test'
import { withWorktreeIsolation, cleanupUnchangedWorktree } from './isolation.js'

describe('withWorktreeIsolation', () => {
  it('creates a worktree, runs fn, and returns the result', async () => {
    // NOTE: Plan's test 1 only mocked worktreeAdd. Adapted: implementation
    // always calls gitDiff and may call worktreeRemove, so we add both
    // mocks (with no-op behavior) for parity with the noop-changed case.
    const fakeFs = {
      worktreeAdd: async (_path: string) => ({}),
      worktreeRemove: async (_path: string) => {},
      gitDiff: async () => '',
    }
    const result = await withWorktreeIsolation({
      repoRoot: '/repo',
      worktreeId: 'wt-test-1',
      fs: fakeFs as never,
      run: async (_wtPath) => 'hello',
    })
    expect(result.report).toBe('hello')
  })

  it('removes the worktree after run if no files changed (deterministic by git diff)', async () => {
    const removedPaths: string[] = []
    const fakeFs = {
      worktreeAdd: async (_path: string) => ({}),
      worktreeRemove: async (path: string) => {
        removedPaths.push(path)
      },
      gitDiff: async () => '',  // empty = no changes
    }
    await withWorktreeIsolation({
      repoRoot: '/repo',
      worktreeId: 'wt-noop',
      fs: fakeFs as never,
      run: async () => 'x',
    })
    expect(removedPaths).toContain('/tmp/opencc-worktree-wt-noop')
  })

  it('keeps the worktree if files were modified (returns changed:true)', async () => {
    const removedPaths: string[] = []
    const fakeFs = {
      worktreeAdd: async () => ({}),
      worktreeRemove: async (p: string) => { removedPaths.push(p) },
      gitDiff: async () => 'M file.txt',
    }
    const result = await withWorktreeIsolation({
      repoRoot: '/repo',
      worktreeId: 'wt-changed',
      fs: fakeFs as never,
      run: async () => 'x',
    })
    expect(result.changed).toBe(true)
    expect(result.worktreePath).toBe('/tmp/opencc-worktree-wt-changed')
    expect(removedPaths).toHaveLength(0)
  })

  it('still cleans up worktree if run throws', async () => {
    const removed: string[] = []
    const fakeFs = {
      worktreeAdd: async () => ({}),
      worktreeRemove: async (p: string) => { removed.push(p) },
      gitDiff: async () => '',
    }
    await expect(
      withWorktreeIsolation({
        repoRoot: '/r',
        worktreeId: 'wt-throw',
        fs: fakeFs as never,
        run: async () => { throw new Error('boom') },
      }),
    ).rejects.toThrow('boom')
    expect(removed).toContain('/tmp/opencc-worktree-wt-throw')
  })
})
