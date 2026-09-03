import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWorktreeTool } from '../../src/opencc-src/server/taskFactoryTools.js'

describe('CreateWorktree tool (2026-09-03 parallel-conflict isolation)', () => {
  let repoPath: string
  let factoryDir: string
  const savedRoot = process.env.ZAI_TASK_FACTORY_DIR

  beforeAll(async () => {
    factoryDir = await mkdtemp(join(tmpdir(), 'tf-root-'))
    process.env.ZAI_TASK_FACTORY_DIR = factoryDir
    repoPath = await mkdtemp(join(tmpdir(), 'tf-repo-'))
    const git = (...args: string[]) => execFileSync('git', ['-C', repoPath, ...args], { stdio: 'pipe' })
    git('init', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'test')
    await writeFile(join(repoPath, 'a.txt'), 'hello')
    git('add', 'a.txt')
    git('commit', '-m', 'init')
  })

  afterAll(() => {
    if (savedRoot === undefined) delete process.env.ZAI_TASK_FACTORY_DIR
    else process.env.ZAI_TASK_FACTORY_DIR = savedRoot
  })

  it('creates a worktree with branch task-<id> under <root>/worktrees/<id>/', async () => {
    const r = (await createWorktreeTool.call({ taskId: 'tf-test01', repoPath }, {} as never)) as {
      data: { structured: { worktreePath: string; branch: string; reused: boolean } }
    }
    const { worktreePath, branch, reused } = r.data.structured
    expect(branch).toBe('task-tf-test01')
    expect(worktreePath).toBe(join(factoryDir, 'worktrees', 'tf-test01'))
    expect(reused).toBe(false)
    expect(existsSync(join(worktreePath, '.git'))).toBe(true)
    // 分支存在且 executor 可提交,不影响主仓库工作树
    expect(execFileSync('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' }).trim()).toBe('task-tf-test01')
    expect(execFileSync('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' }).trim()).toBe('main')
  })

  it('re-invocation reuses the existing worktree (FAIL-retry path)', async () => {
    const r = (await createWorktreeTool.call({ taskId: 'tf-test01', repoPath }, {} as never)) as {
      data: { structured: { reused: boolean } }
    }
    expect(r.data.structured.reused).toBe(true)
  })

  it('errors surface git failure', async () => {
    await expect(
      createWorktreeTool.call({ taskId: 'tf-bad01', repoPath: '/nonexistent-repo-xyz' }, {} as never),
    ).rejects.toThrow(/worktree add failed|CreateWorktree failed/)
  })

  it('integration mode: custom branch/slot/baseRef', async () => {
    const r = (await createWorktreeTool.call(
      { taskId: 'tf-test01', repoPath, branch: 'integration-main', slot: 'integration-repo', baseRef: 'main' },
      {} as never,
    )) as {
      data: { structured: { worktreePath: string; branch: string; reused: boolean } }
    }
    expect(r.data.structured.branch).toBe('integration-main')
    expect(r.data.structured.worktreePath).toBe(join(factoryDir, 'worktrees', 'integration-repo'))
    expect(r.data.structured.reused).toBe(false)
    expect(execFileSync('git', ['-C', r.data.structured.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' }).trim()).toBe('integration-main')
  })

  it('re-add after worktree remove falls back to checking out the existing branch', async () => {
    const first = (await createWorktreeTool.call(
      { taskId: 'tf-test01', repoPath, branch: 'integration-main', slot: 'integration-repo', baseRef: 'main' },
      {} as never,
    )) as { data: { structured: { worktreePath: string; reused: boolean } } }
    // 已存在 → reuse
    expect(first.data.structured.reused).toBe(true)
    // 移除 worktree 但分支仍在仓库 → 再建走 already-exists 回退 checkout
    execFileSync('git', ['-C', repoPath, 'worktree', 'remove', first.data.structured.worktreePath])
    const again = (await createWorktreeTool.call(
      { taskId: 'tf-test01', repoPath, branch: 'integration-main', slot: 'integration-repo' },
      {} as never,
    )) as { data: { structured: { reused: boolean; worktreePath: string } } }
    expect(again.data.structured.reused).toBe(false)
    expect(existsSync(join(again.data.structured.worktreePath, '.git'))).toBe(true)
  })
})
