import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { superTasksCreateTool, superTasksResetTool } from '../../src/opencc-src/server/taskFactoryTools.js'
import { getTaskSummary, markTaskStatus, moveTask, taskDir } from '../../src/opencc-src/server/taskFactoryFiles.js'

let dir: string
let events: Array<{ action: string; payload: Record<string, unknown> }>

function extractId(out: string): string {
  return (out.match(/tf-[a-z0-9]{8}/) as RegExpMatchArray)[0] as string
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tf-reset-'))
  process.env.ZAI_TASK_FACTORY_DIR = dir
  events = []
  ;(globalThis as any).__zaiTaskFactoryEmitter = (e: any) => events.push(e)
})
afterEach(async () => {
  delete process.env.ZAI_TASK_FACTORY_DIR
  delete (globalThis as any).__zaiTaskFactoryEmitter
  await rm(dir, { recursive: true, force: true })
})

describe('superTasksResetTool — 5 个分支', () => {
  it('verifying-tasks: 移到 processing-tasks + status=processing + executorTaskId cleared + emit reset', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 'rv', cwd: dir })).data.output as string)
    await moveTask(id, 'queue-tasks', 'processing-tasks')
    await markTaskStatus(id, 'processing-tasks', { executorTaskId: 'old-sub' })
    await moveTask(id, 'processing-tasks', 'verifying-tasks')

    const r = await superTasksResetTool.call({ id })
    expect(r.data.output).toContain(`Task reset: ${id}`)
    expect(r.data.output).toContain('processing-tasks/status=processing')
    expect(r.data.output).toContain('executorTaskId cleared')

    // 桶已切到 processing,status=processing
    const sum = await getTaskSummary(id, 'processing-tasks')
    expect(sum?.bucket).toBe('processing-tasks')
    expect(sum?.status).toBe('processing')
    expect(sum?.executorTaskId).toBeNull()
    const idx = await readFile(join(taskDir('processing-tasks', id), 'index.md'), 'utf-8')
    expect(idx).toContain('status: processing')
    expect(idx).toContain('executorTaskId: null')
    // verifying 已无
    expect(await getTaskSummary(id, 'verifying-tasks')).toBeNull()
    // emit
    expect(events.some((e) => e.action === 'reset' && e.payload.id === id)).toBe(true)
  })

  it('processing-tasks + status=paused: 原地不动,status=processing + executorTaskId cleared', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 'rp', cwd: dir })).data.output as string)
    await moveTask(id, 'queue-tasks', 'processing-tasks')
    await markTaskStatus(id, 'processing-tasks', { status: 'paused', executorTaskId: 'still-running' })

    const r = await superTasksResetTool.call({ id })
    expect(r.data.output).toContain('Task reset:')
    expect(r.data.output).toContain('processing-tasks/status=processing')

    const sum = await getTaskSummary(id, 'processing-tasks')
    expect(sum?.bucket).toBe('processing-tasks')
    expect(sum?.status).toBe('processing')
    expect(sum?.executorTaskId).toBeNull()
    const idx = await readFile(join(taskDir('processing-tasks', id), 'index.md'), 'utf-8')
    expect(idx).toContain('status: processing')
    expect(idx).toContain('executorTaskId: null')
    expect(events.some((e) => e.action === 'reset' && e.payload.id === id)).toBe(true)
  })

  it('processing-tasks + status=processing(非 paused): throws cannot be reset', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 'rn-bad', cwd: dir })).data.output as string)
    await moveTask(id, 'queue-tasks', 'processing-tasks')
    await expect(superTasksResetTool.call({ id })).rejects.toThrow(/cannot be reset/)
    // 没有 emit
    expect(events.some((e) => e.action === 'reset')).toBe(false)
  })

  it('queue-tasks: throws cannot be reset (bucket=queue-tasks, status=queued)', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 'rq', cwd: dir })).data.output as string)
    await expect(superTasksResetTool.call({ id })).rejects.toThrow(/cannot be reset/)
    await expect(superTasksResetTool.call({ id })).rejects.toThrow(/bucket=queue-tasks/)
  })

  it('finished-tasks: throws cannot be reset (bucket=finished-tasks, status=done)', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 'rf', cwd: dir })).data.output as string)
    await moveTask(id, 'queue-tasks', 'finished-tasks')
    await expect(superTasksResetTool.call({ id })).rejects.toThrow(/cannot be reset/)
    await expect(superTasksResetTool.call({ id })).rejects.toThrow(/bucket=finished-tasks/)
  })

  it('不存在: throws cannot be reset (bucket=(not found), status=unknown)', async () => {
    await expect(superTasksResetTool.call({ id: 'tf-noexist0' })).rejects.toThrow(/cannot be reset/)
    await expect(superTasksResetTool.call({ id: 'tf-noexist0' })).rejects.toThrow(/bucket=\(not found\)/)
  })
})

describe('superTasksResetTool — emit 验证', () => {
  it('verifying 分支与 processing paused 分支均发 reset 事件(仅一次)', async () => {
    const a = extractId((await superTasksCreateTool.call({ title: 'ev-a', cwd: dir })).data.output as string)
    await moveTask(a, 'queue-tasks', 'processing-tasks')
    await moveTask(a, 'processing-tasks', 'verifying-tasks')
    await superTasksResetTool.call({ id: a })
    expect(events.filter((e) => e.action === 'reset' && e.payload.id === a)).toHaveLength(1)

    events.length = 0
    const b = extractId((await superTasksCreateTool.call({ title: 'ev-b', cwd: dir })).data.output as string)
    await moveTask(b, 'queue-tasks', 'processing-tasks')
    await markTaskStatus(b, 'processing-tasks', { status: 'paused' })
    await superTasksResetTool.call({ id: b })
    expect(events.filter((e) => e.action === 'reset' && e.payload.id === b)).toHaveLength(1)
  })

  it('失败分支不发 reset 事件', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 'no-evt', cwd: dir })).data.output as string)
    await expect(superTasksResetTool.call({ id })).rejects.toThrow()
    expect(events.some((e) => e.action === 'reset')).toBe(false)
  })
})