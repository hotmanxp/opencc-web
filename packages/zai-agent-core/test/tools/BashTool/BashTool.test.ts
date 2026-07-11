import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { BashTool } from '../../../src/tools/BashTool/BashTool.js'
import type { ToolContext } from '../../../src/tools/Tool.js'

let workdir: string
let ctx: ToolContext

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'zai-bash-test-'))
  ctx = {
    cwd: workdir,
    env: {},
    abortSignal: new AbortController().signal,
    dataDir: workdir,
    canUseTool: async () => ({ behavior: 'allow' }),
    emitEvent: () => {},
    state: {},
    __runtimeConfig: { dataDir: workdir, sandbox: { executor: 'child_process', workdir } },
  }
})

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true })
})

describe('BashTool', () => {
  test('无 sandbox → isError', async () => {
    const r = await BashTool.call({ command: 'ls' }, { ...ctx, __runtimeConfig: { dataDir: workdir } })
    expect(r.isError).toBe(true)
    expect(r.output as string).toMatch(/no sandbox configured/)
  })

  test('foreground: echo 输出到 stdout, exit 0 → isError false', async () => {
    const r = await BashTool.call({ command: 'echo hello' }, ctx)
    expect(r.isError).toBeFalsy()
    expect(r.output as string).toContain('<stdout>hello')
  })

  test('foreground: ls 列出 workdir 下的文件', async () => {
    await writeFile(join(workdir, 'foo.txt'), 'hi')
    const r = await BashTool.call({ command: 'ls' }, ctx)
    expect(r.output as string).toContain('foo.txt')
  })

  test('foreground: exit code != 0 → isError true', async () => {
    const r = await BashTool.call({ command: 'exit 7' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.output as string).toContain('exit code: 7')
  })

  test('foreground: unsupported executor → isError', async () => {
    const r = await BashTool.call({ command: 'ls' }, {
      ...ctx,
      __runtimeConfig: { dataDir: workdir, sandbox: { executor: 'docker' as any, workdir } },
    })
    expect(r.isError).toBe(true)
  })

  test('background: run_in_background=true 返回 taskId, 注册到 ctx.state.background_tasks', async () => {
    const r = await BashTool.call(
      { command: 'sleep 0.1; echo done', run_in_background: true },
      ctx,
    )
    expect(r.isError).toBeFalsy()
    expect(r.output as string).toMatch(/<task_id>bash-[0-9a-f]{8}<\/task_id>/)
    const tasks = ctx.state.background_tasks as Map<string, unknown>
    expect(tasks.size).toBe(1)
  })

  test('isReadOnly / isDestructive 反映命令性质', () => {
    expect(BashTool.isReadOnly!({ command: 'ls' })).toBe(true)
    expect(BashTool.isReadOnly!({ command: 'rm -rf /' })).toBe(false)
    expect(BashTool.isDestructive!({ command: 'rm -rf /' })).toBe(true)
    expect(BashTool.isDestructive!({ command: 'echo hi' })).toBe(false)
  })

  test('isConcurrencySafe = false', () => {
    expect(BashTool.isConcurrencySafe!({ command: 'ls' })).toBe(false)
  })
})
