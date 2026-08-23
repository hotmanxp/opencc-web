/**
 * dsh-017 新工具单测 — Agent / DisplayFiles / Task* / Cron* 关键路径覆盖。
 *
 * 注意:不依赖真实 dsh ctx(用 mock),只测 tool.execute 内部逻辑:
 *   - DisplayFiles: readdir 输出 / 隐藏文件 / 排序
 *   - Task*: 自有 store CRUD / 校验长度
 *   - Cron*: parseCron / nextFireMs / 表达式校验
 *   - Agent: 不跑真实 spawn(集成测试),只测 schema 暴露
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'

import {
  DshTaskListStore,
} from '../../src/tools/tasks.js'
import {
  parseCron,
  nextFireMs,
} from '../../src/tools/cron.js'
import {
  createDisplayFilesTool,
} from '../../src/tools/displayFiles.js'
import {
  createAgentTool,
} from '../../src/tools/subagent.js'
import {
  createTaskCreateTool,
  createTaskGetTool,
  createTaskListTool,
  createTaskUpdateTool,
} from '../../src/tools/taskList.js'
import {
  createCronCreateTool,
  createCronDeleteTool,
  createCronListTool,
} from '../../src/tools/cron.js'

describe('dsh-017: DisplayFiles tool', () => {
  let tmpDir: string
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dsh-017-df-'))
  })
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('lists directory contents with type/size', async () => {
    await writeFile(join(tmpDir, 'a.txt'), 'hello')
    await writeFile(join(tmpDir, 'b.txt'), 'world!!')
    await mkdir(join(tmpDir, 'subdir'))
    const tool = createDisplayFilesTool({ cwd: tmpDir })
    const result = await tool.execute(
      { file_path: tmpDir },
      {} as never,
    ) as { output: string; entryCount: number; truncated: boolean }
    expect(result.entryCount).toBe(3) // a.txt, b.txt, subdir
    expect(result.output).toContain('dir  subdir/')
    expect(result.output).toContain('file a.txt  (5 bytes)')
    expect(result.output).toContain('file b.txt  (7 bytes)')
  })

  it('hides dotfiles by default', async () => {
    await writeFile(join(tmpDir, '.hidden'), 'x')
    await writeFile(join(tmpDir, 'visible.txt'), 'y')
    const tool = createDisplayFilesTool({ cwd: tmpDir })
    const r1 = await tool.execute({ file_path: tmpDir }, {} as never) as { output: string }
    expect(r1.output).not.toContain('.hidden')
    expect(r1.output).toContain('visible.txt')
    const r2 = await tool.execute({ file_path: tmpDir, include_hidden: true }, {} as never) as { output: string }
    expect(r2.output).toContain('.hidden')
  })

  it('errors when path is a file', async () => {
    await writeFile(join(tmpDir, 'afile'), 'x')
    const tool = createDisplayFilesTool({ cwd: tmpDir })
    const r = await tool.execute({ file_path: join(tmpDir, 'afile') }, {} as never) as { output: string }
    expect(r.output).toContain('not a directory')
  })
})

describe('dsh-017: TaskListStore — Phase 5P5 stub', () => {
  // Phase 5P5: DshTaskListStore 改由上游 `@deepseek-ai/dsh-tool-todo` 接管,
  // 本 stub 仅保留方法签名兼容 + 调用即抛"已迁移"错误。
  const sessionId = `test-sess-${Date.now()}`
  let store: DshTaskListStore

  beforeEach(() => {
    store = new DshTaskListStore()
  })

  it('create() 抛 deprecated 错提示走上游 todo_write', async () => {
    await expect(
      store.create(sessionId, { subject: 'Test task', description: 'A test' }),
    ).rejects.toThrow(/已迁移到上游|dsh-tool-todo/)
  })

  it('update() 抛 deprecated 错', async () => {
    await expect(
      store.update(sessionId, 'fake-id', { status: 'in_progress' }),
    ).rejects.toThrow(/已迁移到上游|dsh-tool-todo/)
  })

  it('get() 抛 deprecated 错', async () => {
    await expect(store.get(sessionId, 'nonexistent')).rejects.toThrow(
      /已迁移到上游|dsh-tool-todo/,
    )
  })

  it('list() 抛 deprecated 错', async () => {
    await expect(store.list(sessionId)).rejects.toThrow(/已迁移到上游|dsh-tool-todo/)
  })
})

describe('dsh-017: Task tools schema — Phase 5P5 stub', () => {
  // Phase 5P5: 4 个 TaskCreate/Get/List/Update 工具已全部迁移到上游
  // todo_write(stub 现在抛"HarnessError: 已迁移"提示)。
  it('TaskCreate stub 暴露 + 调用抛 deprecated', async () => {
    const t = createTaskCreateTool({ getSessionId: () => 'sid' })
    expect(t.name).toBe('TaskCreate')
    await expect(t.execute({}, {} as never)).rejects.toThrow(/已迁移|已废弃/)
  })

  it('TaskGet stub 暴露 + 调用抛 deprecated', async () => {
    const t = createTaskGetTool({ getSessionId: () => 'sid' })
    expect(t.name).toBe('TaskGet')
    await expect(t.execute({}, {} as never)).rejects.toThrow(/已迁移|已废弃/)
  })

  it('TaskList stub 暴露 + 调用抛 deprecated', async () => {
    const t = createTaskListTool({ getSessionId: () => 'sid' })
    expect(t.name).toBe('TaskList')
    await expect(t.execute({}, {} as never)).rejects.toThrow(/已迁移|已废弃/)
  })

  it('TaskUpdate stub 暴露 + 调用抛 deprecated', async () => {
    const t = createTaskUpdateTool({ getSessionId: () => 'sid' })
    expect(t.name).toBe('TaskUpdate')
    await expect(t.execute({}, {} as never)).rejects.toThrow(/已迁移|已废弃/)
  })
})

describe('dsh-017: Cron parser', () => {
  it('parses 5-field expressions', () => {
    const c = parseCron('*/5 * * * *')
    expect(c.minute.has(0)).toBe(true)
    expect(c.minute.has(5)).toBe(true)
    expect(c.minute.has(7)).toBe(false)
    expect(c.hour.size).toBe(24)
  })

  it('supports lists and ranges', () => {
    const c = parseCron('1,3,5 9-17 * * *')
    expect(c.minute.has(1) && c.minute.has(3) && c.minute.has(5)).toBe(true)
    expect(c.minute.has(2)).toBe(false)
    expect(c.hour.has(9) && c.hour.has(17) && c.hour.has(8)).toBe(false)
  })

  it('rejects wrong field count', () => {
    expect(() => parseCron('* * *')).toThrow(/5 fields/)
  })

  it('nextFireMs returns future minute for star', () => {
    const now = Date.now()
    const next = nextFireMs('* * * * *', now)
    expect(next).toBeGreaterThan(now)
    expect(next - now).toBeLessThan(70_000) // within 1 minute + buffer
  })

  it('nextFireMs skips when minute does not match', () => {
    // 仅在 0 分钟触发,下一次应该是下个 0 分钟
    const next = nextFireMs('0 * * * *')
    const d = new Date(next)
    expect(d.getMinutes()).toBe(0)
  })
})

describe('dsh-017: Cron tools schema', () => {
  it('CronCreate / Delete / List exposed', () => {
    expect(createCronCreateTool({
      getSessionId: () => 'sid',
      getParentAgent: () => undefined,
    }).name).toBe('CronCreate')
    expect(createCronDeleteTool({
      getSessionId: () => 'sid',
      getParentAgent: () => undefined,
    }).name).toBe('CronDelete')
    expect(createCronListTool({
      getSessionId: () => 'sid',
      getParentAgent: () => undefined,
    }).name).toBe('CronList')
  })

  it('CronCreate rejects invalid expression', async () => {
    const t = createCronCreateTool({
      getSessionId: () => 'sid',
      getParentAgent: () => undefined,
    })
    const r = await t.execute({ cron: 'invalid', prompt: 'x' }, {} as never) as { output: string }
    expect(r.output).toContain('invalid cron')
  })

  it('CronList requires sessionId', async () => {
    const t = createCronListTool({
      getSessionId: () => undefined,
      getParentAgent: () => undefined,
    })
    const r = await t.execute({}, {} as never) as { output: string }
    expect(r.output).toContain('requires an active session')
  })
})

describe('dsh-017: Agent tool schema', () => {
  it('exposes Agent tool with dsh-style name', () => {
    const t = createAgentTool({ cwd: '/tmp', getParentSessionId: () => 'sid' })
    expect(t.name).toBe('Agent')
  })

  it('rejects non-general-purpose subagent_type in Phase 1', async () => {
    const t = createAgentTool({ cwd: '/tmp', getParentSessionId: () => 'sid' })
    const r = await t.execute(
      { description: 'test', prompt: 'do', subagent_type: 'custom-agent' },
      { agent: undefined } as never,
    ) as { output: string; status: string }
    expect(r.status).toBe('failed')
    expect(r.output).toContain('not supported in dsh Phase 1')
  })
})
