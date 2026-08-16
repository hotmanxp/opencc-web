import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  handoffCommand,
  parseArgs,
  resolveCwd,
  countAssistantMessages,
  readTaskListText,
  HandoffArgsError,
  HandoffCwdError,
} from './handoffCommand.js'
import { listHandoffs, buildHandoffPath } from '@zn-ai/zn-agent-core'

describe('parseArgs', () => {
  it('空 args 返回空对象', () => {
    expect(parseArgs('')).toEqual({})
    expect(parseArgs('   ')).toEqual({})
  })

  it('--pick <filename> 提取 pickFile', () => {
    expect(parseArgs('--pick foo.md')).toEqual({ pickFile: 'foo.md' })
  })

  it('--pick 重复时后者覆盖', () => {
    expect(parseArgs('--pick a.md --pick b.md')).toEqual({ pickFile: 'b.md' })
  })

  it('--pick 无值抛 HandoffArgsError', () => {
    expect(() => parseArgs('--pick')).toThrow(HandoffArgsError)
  })

  it('--pick 后面是另一个 flag 抛错', () => {
    expect(() => parseArgs('--pick --other')).toThrow(HandoffArgsError)
  })

  it('未知 flag 抛 HandoffArgsError', () => {
    expect(() => parseArgs('--unknown foo')).toThrow(HandoffArgsError)
    expect(() => parseArgs('positional')).toThrow(HandoffArgsError)
  })
})

describe('resolveCwd', () => {
  it('优先 context.cwd', () => {
    expect(resolveCwd({ cwd: '/from/ctx' })).toBe('/from/ctx')
  })

  it('context.cwd 缺失时 fallback process.cwd()', () => {
    const fallback = process.cwd()
    expect(resolveCwd({})).toBe(fallback)
  })

  it('context 是 null 时仍能 fallback', () => {
    expect(resolveCwd(null as any)).toBe(process.cwd())
  })
})

describe('countAssistantMessages', () => {
  it('context.assistantMessageCount 是 number 时返回它', async () => {
    expect(await countAssistantMessages({ assistantMessageCount: 3 })).toBe(3)
    expect(await countAssistantMessages({ assistantMessageCount: 100 })).toBe(100)
  })

  it('context 没字段时返回 +Infinity(强制 GENERATE)', async () => {
    expect(await countAssistantMessages({})).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('readTaskListText', () => {
  it('context.taskListText 是 string 时返回它', async () => {
    expect(await readTaskListText({ taskListText: '- [ ] task' })).toBe('- [ ] task')
  })

  it('context.taskListText 是 null 时返回 null', async () => {
    expect(await readTaskListText({ taskListText: null })).toBeNull()
  })

  it('context 没字段时返回 null(fallback 触发 generate prompt 占位)', async () => {
    expect(await readTaskListText({})).toBeNull()
  })
})

describe('handoffCommand.getPromptForCommand (end-to-end)', () => {
  let tmpDir: string
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-e2e-'))
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('PICKUP: assistantCount=2 时走 pickup 分支', async () => {
    const file = path.join(tmpDir, '.agent_working_dir/handoff', 'old.md')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '# old')

    const blocks = await handoffCommand.getPromptForCommand(
      '',
      {
        cwd: tmpDir,
        assistantMessageCount: 2,
        taskListText: null,
      } as any,
    )
    const text = (blocks[0] as any).text
    expect(text).toContain('Read')
    expect(text).toContain('old.md')
  })

  it('GENERATE: assistantCount=10 时走 generate 分支', async () => {
    const blocks = await handoffCommand.getPromptForCommand(
      '',
      {
        cwd: tmpDir,
        assistantMessageCount: 10,
        taskListText: '- [ ] next',
      } as any,
    )
    const text = (blocks[0] as any).text
    expect(text).toContain('Task title')
    expect(text).toContain('- [ ] next')
    expect(text).toContain(tmpDir)
  })

  it('GENERATE: taskListText=null 时内嵌占位', async () => {
    const blocks = await handoffCommand.getPromptForCommand(
      '',
      {
        cwd: tmpDir,
        assistantMessageCount: 10,
        taskListText: null,
      } as any,
    )
    const text = (blocks[0] as any).text
    expect(text).toContain('(未提供 — 请从对话上文推断当前任务列表)')
  })

  it('--pick 强制 PICKUP 即便 assistantCount 高', async () => {
    const file = path.join(tmpDir, '.agent_working_dir/handoff', 'picked.md')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '# picked')

    const blocks = await handoffCommand.getPromptForCommand(
      '--pick picked.md',
      {
        cwd: tmpDir,
        assistantMessageCount: 50,
        taskListText: null,
      } as any,
    )
    const text = (blocks[0] as any).text
    expect(text).toContain('Read')
    expect(text).toContain(file)
    expect(text).not.toContain('Task title')
  })

  it('--pick 文件不存在抛 HandoffArgsError', async () => {
    await expect(
      handoffCommand.getPromptForCommand(
        '--pick nope.md',
        { cwd: tmpDir, assistantMessageCount: 2, taskListText: null } as any,
      ),
    ).rejects.toThrow(HandoffArgsError)
  })

  it('PICKUP 0 文件时返回友好提示', async () => {
    const blocks = await handoffCommand.getPromptForCommand(
      '',
      {
        cwd: tmpDir,
        assistantMessageCount: 2,
        taskListText: null,
      } as any,
    )
    const text = (blocks[0] as any).text
    expect(text).toContain('未找到')
  })

  it('context 完全无字段时走 GENERATE(+Infinity fallback)', async () => {
    const blocks = await handoffCommand.getPromptForCommand(
      '',
      {} as any,
    )
    const text = (blocks[0] as any).text
    expect(text).toContain('Task title') // GENERATE 标识
  })
})