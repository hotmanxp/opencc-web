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
    expect(resolveCwd({ cwd: '/from/ctx', dataDir: '/tmp/test' } as any)).toBe('/from/ctx')
  })

  it('context.cwd 缺失时 fallback process.cwd()', () => {
    const fallback = process.cwd()
    expect(resolveCwd({ dataDir: '/tmp/test' } as any)).toBe(fallback)
  })
})

describe('countAssistantMessages', () => {
  it('context.messages 过滤 type === assistant', async () => {
    const messages = [
      { type: 'user' },
      { type: 'assistant' },
      { type: 'user' },
      { type: 'assistant' },
      { type: 'assistant' },
    ]
    expect(
      await countAssistantMessages({ cwd: '/x', dataDir: '/d', messages } as any),
    ).toBe(3)
  })

  it('context.messages 为空时返回 0(等同"新会话")', async () => {
    expect(
      await countAssistantMessages({ cwd: '/x', dataDir: '/d', messages: [] } as any),
    ).toBe(0)
  })

  it('context 没 messages 字段时不返回 +Infinity,退化为 0', async () => {
    // 之前此 fallback 返回 +Infinity,把 isPickup 永远推成 false,导致
    // 路由层没注入 messages 时新会话里 /handoff 永远走 generate — 这就是
    // 当前 bug 的根因。修复后 fallback 改为 0,跟 vendor 对 undefined messages
    // 的兜底一致。
    expect(await countAssistantMessages({ cwd: '/x', dataDir: '/d' } as any)).toBe(0)
  })

  it('非 assistant 类型(user / tool / system / ...)不计入', async () => {
    const messages = [
      { type: 'user' },
      { type: 'tool_use' },
      { type: 'tool_result' },
      { type: 'system' },
      { type: 'compact_boundary' },
    ]
    expect(
      await countAssistantMessages({ cwd: '/x', dataDir: '/d', messages } as any),
    ).toBe(0)
  })
})

describe('readTaskListText', () => {
  it('context.taskListText 是 string 时返回它', async () => {
    expect(
      await readTaskListText({ cwd: '/x', dataDir: '/d', taskListText: '- [ ] task' } as any),
    ).toBe('- [ ] task')
  })

  it('context.taskListText 是 null 时返回 null', async () => {
    expect(await readTaskListText({ cwd: '/x', dataDir: '/d', taskListText: null } as any)).toBeNull()
  })

  it('context 没字段时返回 null(fallback 触发 generate prompt 占位)', async () => {
    expect(await readTaskListText({ cwd: '/x', dataDir: '/d' } as any)).toBeNull()
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

  // 构造 N 个 assistant 消息的 helper,user 消息穿插模拟真实 transcript。
  const assistantMessages = (n: number) =>
    Array.from({ length: n }, (_, i) => [
      { type: 'user' },
      { type: 'assistant', message: { id: String(i) } },
    ]).flat()

  it('PICKUP: assistant 消息数 <= PICKUP_THRESHOLD(4)时走 pickup 分支', async () => {
    const file = path.join(tmpDir, '.agent_working_dir/handoff', 'old.md')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '# old')

    const blocks = await handoffCommand.getPromptForCommand(
      '',
      {
        cwd: tmpDir,
        dataDir: '/tmp/test-data',
        messages: assistantMessages(2),
        taskListText: null,
      } as any,
    )
    const text = (blocks[0] as any).text
    expect(text).toContain('Read')
    expect(text).toContain('old.md')
  })

  it('GENERATE: assistant 消息数 > PICKUP_THRESHOLD(4)时走 generate 分支', async () => {
    const blocks = await handoffCommand.getPromptForCommand(
      '',
      {
        cwd: tmpDir,
        dataDir: '/tmp/test-data',
        messages: assistantMessages(10),
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
        dataDir: '/tmp/test-data',
        messages: assistantMessages(10),
        taskListText: null,
      } as any,
    )
    const text = (blocks[0] as any).text
    expect(text).toContain('(未提供 — 请从对话上文推断当前任务列表)')
  })

  it('--pick 强制 PICKUP 即便 assistant 消息数 > 4', async () => {
    const file = path.join(tmpDir, '.agent_working_dir/handoff', 'picked.md')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '# picked')

    const blocks = await handoffCommand.getPromptForCommand(
      '--pick picked.md',
      {
        cwd: tmpDir,
        dataDir: '/tmp/test-data',
        messages: assistantMessages(50),
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
        {
          cwd: tmpDir,
          dataDir: '/tmp/test-data',
          messages: assistantMessages(2),
          taskListText: null,
        } as any,
      ),
    ).rejects.toThrow(HandoffArgsError)
  })

  it('PICKUP 0 文件时返回友好提示', async () => {
    const blocks = await handoffCommand.getPromptForCommand(
      '',
      {
        cwd: tmpDir,
        dataDir: '/tmp/test-data',
        messages: assistantMessages(2),
        taskListText: null,
      } as any,
    )
    const text = (blocks[0] as any).text
    expect(text).toContain('未找到')
  })

  it('context 仅含必需字段(无 messages)时走 PICKUP(0 fallback)而非 +Infinity', async () => {
    // 修复回归: 之前 +Infinity fallback 会让"sessionId 未注入 / 没 messages"
    // 路径永远走 generate,这是当前 bug 根因。改为 0 后这条路径走 pickup,
    // 0 文件时跟上面"PICKUP 0 文件时返回友好提示"一样的行为(交给用户
    // 主动 /handoff --generate 或先 /handoff --pick 指定的文件)。
    const blocks = await handoffCommand.getPromptForCommand(
      '',
      { cwd: tmpDir, dataDir: '/tmp/test-data' } as any,
    )
    const text = (blocks[0] as any).text
    expect(text).toContain('未找到') // PICKUP 0 文件分支
    expect(text).not.toContain('Task title') // 不该是 GENERATE
  })
})
