import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { superTasksCreateTool, superTasksMoveTool } from '../../src/opencc-src/server/taskFactoryTools.js'
import { createPoolTask, getTaskSummary, taskDir, TASK_YAML_FILENAME } from '../../src/opencc-src/server/taskFactoryFiles.js'

let dir: string
let events: Array<{ action: string; payload: Record<string, unknown> }>

function extractId(out: string): string {
  return (out.match(/tf-[a-z0-9]{8}/) as RegExpMatchArray)[0] as string
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tf-move-'))
  process.env.ZAI_TASK_FACTORY_DIR = dir
  events = []
  ;(globalThis as any).__zaiTaskFactoryEmitter = (e: any) => events.push(e)
})
afterEach(async () => {
  delete process.env.ZAI_TASK_FACTORY_DIR
  delete (globalThis as any).__zaiTaskFactoryEmitter
  await rm(dir, { recursive: true, force: true })
})

/** 把新创建的任务走 core 函数搬到指定 bucket,确保目录真实存在后再做 Move。 */
async function seed(id: string, bucket: 'queue-tasks' | 'processing-tasks' | 'verifying-tasks' | 'finished-tasks') {
  if (bucket === 'queue-tasks') return
  // 先建在 queue,然后沿合法路径推进到目标桶
  if (bucket === 'processing-tasks') {
    const { moveTask } = await import('../../src/opencc-src/server/taskFactoryFiles.js')
    await moveTask(id, 'queue-tasks', 'processing-tasks')
  } else if (bucket === 'verifying-tasks') {
    const { moveTask } = await import('../../src/opencc-src/server/taskFactoryFiles.js')
    await moveTask(id, 'queue-tasks', 'processing-tasks')
    await moveTask(id, 'processing-tasks', 'verifying-tasks')
  } else if (bucket === 'finished-tasks') {
    const { moveTask } = await import('../../src/opencc-src/server/taskFactoryFiles.js')
    await moveTask(id, 'queue-tasks', 'finished-tasks')
  }
}

describe('superTasksMoveTool — 4×4 桶矩阵合法 12 对', () => {
  const buckets = ['queue-tasks', 'processing-tasks', 'verifying-tasks', 'finished-tasks'] as const
  const legalPairs: Array<{ from: typeof buckets[number]; to: typeof buckets[number]; expectedStatus: 'queued' | 'processing' | 'verifying' | 'done' }> = [
    { from: 'queue-tasks', to: 'processing-tasks', expectedStatus: 'processing' },
    { from: 'queue-tasks', to: 'verifying-tasks', expectedStatus: 'verifying' },
    { from: 'queue-tasks', to: 'finished-tasks', expectedStatus: 'done' },
    { from: 'processing-tasks', to: 'queue-tasks', expectedStatus: 'queued' },
    { from: 'processing-tasks', to: 'verifying-tasks', expectedStatus: 'verifying' },
    { from: 'processing-tasks', to: 'finished-tasks', expectedStatus: 'done' },
    { from: 'verifying-tasks', to: 'queue-tasks', expectedStatus: 'queued' },
    { from: 'verifying-tasks', to: 'processing-tasks', expectedStatus: 'processing' },
    { from: 'verifying-tasks', to: 'finished-tasks', expectedStatus: 'done' },
    { from: 'finished-tasks', to: 'queue-tasks', expectedStatus: 'queued' },
    { from: 'finished-tasks', to: 'processing-tasks', expectedStatus: 'processing' },
    { from: 'finished-tasks', to: 'verifying-tasks', expectedStatus: 'verifying' },
  ]

  for (const { from, to, expectedStatus } of legalPairs) {
    it(`Move ${from} → ${to} 设置 status=${expectedStatus} 并 emit moved`, async () => {
      const id = extractId((await superTasksCreateTool.call({ title: `t-${from}-${to}`, cwd: dir })).data.output as string)
      await seed(id, from)
      const r = await superTasksMoveTool.call({ id, from, to })
      expect(r.data.output).toContain(`${from} → ${to}`)
      // 文件位置已切到 to
      const sum = await getTaskSummary(id, to)
      expect(sum?.bucket).toBe(to)
      expect(sum?.status).toBe(expectedStatus)
      const idx = await readFile(join(taskDir(to, id), TASK_YAML_FILENAME), 'utf-8')
      expect(idx).toContain(`status: ${expectedStatus}`)
      // emit moved(id, from, to)
      const ev = events.find((e) => e.action === 'moved' && e.payload.id === id)
      expect(ev).toBeDefined()
      expect(ev!.payload.from).toBe(from)
      expect(ev!.payload.to).toBe(to)
    })
  }

  it('4×4 中 from === to 的 4 对（self-loop）非法 → throws already exists', async () => {
    // 自循环在 16 对中属于非法 4 对:目录仍在 from,目标判定为已存在 → 抛错。
    for (const b of buckets) {
      const id = extractId((await superTasksCreateTool.call({ title: `self-${b}`, cwd: dir })).data.output as string)
      await seed(id, b)
      await expect(superTasksMoveTool.call({ id, from: b, to: b })).rejects.toThrow(new RegExp(`already exists in ${b}`))
    }
  })
})

describe('superTasksMoveTool — executorTaskId backfill', () => {
  it('带 executorTaskId 时 Move 内部写 frontmatter(in-place)+ 切桶', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 'dispatch', cwd: dir })).data.output as string)
    const r = await superTasksMoveTool.call({
      id, from: 'queue-tasks', to: 'processing-tasks', executorTaskId: 'sub-abc-123',
    })
    expect(r.data.output).toContain('executorTaskId=sub-abc-123')
    const sum = await getTaskSummary(id, 'processing-tasks')
    expect(sum?.executorTaskId).toBe('sub-abc-123')
    const idx = await readFile(join(taskDir('processing-tasks', id), TASK_YAML_FILENAME), 'utf-8')
    expect(idx).toContain('executorTaskId: sub-abc-123')
  })

  it('executorTaskId 为空字符串时跳过 backfill(等价于不传)', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 'no-sub', cwd: dir })).data.output as string)
    const r = await superTasksMoveTool.call({ id, from: 'queue-tasks', to: 'processing-tasks', executorTaskId: '' })
    expect(r.data.output).not.toContain('executorTaskId=')
    const sum = await getTaskSummary(id, 'processing-tasks')
    expect(sum?.executorTaskId).toBeNull()
  })

  it('不带 executorTaskId 时 Move 不写 frontmatter executorTaskId', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 'plain-move', cwd: dir })).data.output as string)
    await superTasksMoveTool.call({ id, from: 'queue-tasks', to: 'processing-tasks' })
    const idx = await readFile(join(taskDir('processing-tasks', id), TASK_YAML_FILENAME), 'utf-8')
    // 创建时 executorTaskId 是 null,Move 不带该参数 → 保持 null
    expect(idx).toContain('executorTaskId: null')
  })
})

describe('superTasksMoveTool — 错误矩阵', () => {
  it('from 桶无任务 → throws "not found in <from>"', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 'nf', cwd: dir })).data.output as string)
    // 任务在 queue-tasks,但 Move 称 from=processing-tasks
    await expect(superTasksMoveTool.call({ id, from: 'processing-tasks', to: 'verifying-tasks' })).rejects.toThrow(/not found in processing-tasks/)
  })

  it('任务根本不存在 → throws "not found in <from>"', async () => {
    await expect(superTasksMoveTool.call({ id: 'tf-noexist0', from: 'queue-tasks', to: 'processing-tasks' })).rejects.toThrow(/not found in queue-tasks/)
  })

  it('目标桶已有同名 → throws "already exists in <to>"', async () => {
    // 创建两个任务,先 move 第一个到目标,再尝试 Move 第二个到同一目标
    const a = extractId((await superTasksCreateTool.call({ title: 'a', cwd: dir })).data.output as string)
    const b = extractId((await superTasksCreateTool.call({ title: 'b', cwd: dir })).data.output as string)
    // 先把 a 推到 processing
    await superTasksMoveTool.call({ id: a, from: 'queue-tasks', to: 'processing-tasks' })
    // 现在尝试把 b 也直接 queue→processing,但目标 processing/a 已存在 — 不,这是不同 id,不会冲突
    // 制造冲突:把 a 先 processing→finished,然后把 a 复制到 processing 当成"目标已存在"
    await superTasksMoveTool.call({ id: a, from: 'processing-tasks', to: 'finished-tasks' })
    // 在 processing-tasks 手工建同名 a 目录模拟并发残留
    await mkdir(join(dir, 'processing-tasks', a), { recursive: true })
    // 现在 b 想从 queue 移到 processing,目标空,不该抛。改测 a 的 finished→processing 应该因为"目标已有 a"
    await expect(superTasksMoveTool.call({ id: a, from: 'finished-tasks', to: 'processing-tasks' })).rejects.toThrow(/already exists in processing-tasks/)
    // b 仍然能正常 Move(避免被 a 残留污染)
    await superTasksMoveTool.call({ id: b, from: 'queue-tasks', to: 'processing-tasks' })
  })
})

describe('superTasksMoveTool — 移动后状态字段正确性', () => {
  it('Move 到 processing 后 status=processing 且 cwd 保留', async () => {
    const c = await createPoolTask({ title: 'keep-cwd', cwd: '/abs/path/proj' })
    await superTasksMoveTool.call({ id: c.id, from: 'queue-tasks', to: 'processing-tasks' })
    const sum = await getTaskSummary(c.id, 'processing-tasks')
    expect(sum?.status).toBe('processing')
    expect(sum?.cwd).toBe('/abs/path/proj')
  })

  it('Move 到 verifying 后 status=verifying', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 'to-ver', cwd: dir })).data.output as string)
    await superTasksMoveTool.call({ id, from: 'queue-tasks', to: 'processing-tasks' })
    await superTasksMoveTool.call({ id, from: 'processing-tasks', to: 'verifying-tasks' })
    const idx = await readFile(join(taskDir('verifying-tasks', id), TASK_YAML_FILENAME), 'utf-8')
    expect(idx).toContain('status: verifying')
  })

  it('Move 到 finished 后 status=done', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 'to-fin', cwd: dir })).data.output as string)
    await superTasksMoveTool.call({ id, from: 'queue-tasks', to: 'finished-tasks' })
    const idx = await readFile(join(taskDir('finished-tasks', id), TASK_YAML_FILENAME), 'utf-8')
    expect(idx).toContain('status: done')
  })
})