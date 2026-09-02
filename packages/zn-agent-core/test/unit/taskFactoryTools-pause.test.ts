import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { superTasksCreateTool, superTasksPauseTool } from '../../src/opencc-src/server/taskFactoryTools.js'
import { getTaskSummary, markTaskStatus, moveTask, taskDir, TASK_YAML_FILENAME } from '../../src/opencc-src/server/taskFactoryFiles.js'

let dir: string
let events: Array<{ action: string; payload: Record<string, unknown> }>

function extractId(out: string): string {
  return (out.match(/tf-[a-z0-9]{8}/) as RegExpMatchArray)[0] as string
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tf-pause-'))
  process.env.ZAI_TASK_FACTORY_DIR = dir
  events = []
  ;(globalThis as any).__zaiTaskFactoryEmitter = (e: any) => events.push(e)
})
afterEach(async () => {
  delete process.env.ZAI_TASK_FACTORY_DIR
  delete (globalThis as any).__zaiTaskFactoryEmitter
  await rm(dir, { recursive: true, force: true })
})

describe('superTasksPauseTool — 5 个分支', () => {
  it('processing-tasks: 留桶,status=paused + executorTaskId cleared + emit paused', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 'pp', cwd: dir })).data.output as string)
    await moveTask(id, 'queue-tasks', 'processing-tasks')
    await markTaskStatus(id, 'processing-tasks', { executorTaskId: 'live-sub' })

    const r = await superTasksPauseTool.call({ id })
    expect(r.data.output).toContain(`Task paused: ${id}`)
    expect(r.data.output).toContain('in processing-tasks')
    expect(r.data.output).toContain('executorTaskId cleared')

    const sum = await getTaskSummary(id, 'processing-tasks')
    expect(sum?.bucket).toBe('processing-tasks')
    expect(sum?.status).toBe('paused')
    expect(sum?.executorTaskId).toBeNull()
    const idx = await readFile(join(taskDir('processing-tasks', id), TASK_YAML_FILENAME), 'utf-8')
    expect(idx).toContain('status: paused')
    expect(idx).toContain('executorTaskId: null')
    expect(events.some((e) => e.action === 'paused' && e.payload.id === id)).toBe(true)
  })

  it('verifying-tasks: 留桶,status=paused + executorTaskId cleared + emit paused', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 'pv', cwd: dir })).data.output as string)
    await moveTask(id, 'queue-tasks', 'processing-tasks')
    await moveTask(id, 'processing-tasks', 'verifying-tasks')

    const r = await superTasksPauseTool.call({ id })
    expect(r.data.output).toContain(`Task paused: ${id}`)
    expect(r.data.output).toContain('in verifying-tasks')
    expect(r.data.output).toContain('executorTaskId cleared')

    const sum = await getTaskSummary(id, 'verifying-tasks')
    expect(sum?.bucket).toBe('verifying-tasks')
    expect(sum?.status).toBe('paused')
    expect(sum?.executorTaskId).toBeNull()
    const idx = await readFile(join(taskDir('verifying-tasks', id), TASK_YAML_FILENAME), 'utf-8')
    expect(idx).toContain('status: paused')
    expect(events.some((e) => e.action === 'paused' && e.payload.id === id)).toBe(true)
  })

  it('queue-tasks: throws cannot be paused (bucket=queue-tasks, status=queued)', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 'pq', cwd: dir })).data.output as string)
    await expect(superTasksPauseTool.call({ id })).rejects.toThrow(/cannot be paused/)
    await expect(superTasksPauseTool.call({ id })).rejects.toThrow(/bucket=queue-tasks/)
    expect(events.some((e) => e.action === 'paused')).toBe(false)
  })

  it('finished-tasks: throws cannot be paused (bucket=finished-tasks, status=done)', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 'pf', cwd: dir })).data.output as string)
    await moveTask(id, 'queue-tasks', 'finished-tasks')
    await expect(superTasksPauseTool.call({ id })).rejects.toThrow(/cannot be paused/)
    await expect(superTasksPauseTool.call({ id })).rejects.toThrow(/bucket=finished-tasks/)
    expect(events.some((e) => e.action === 'paused')).toBe(false)
  })

  it('不存在: throws cannot be paused (bucket=(not found), status=unknown)', async () => {
    await expect(superTasksPauseTool.call({ id: 'tf-noexist0' })).rejects.toThrow(/cannot be paused/)
    await expect(superTasksPauseTool.call({ id: 'tf-noexist0' })).rejects.toThrow(/bucket=\(not found\)/)
  })
})

describe('superTasksPauseTool — executorTaskId 清空(关键回归)', () => {
  it('processing 中 subTaskId 不为空 → Pause 后清空', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 'clear-sub', cwd: dir })).data.output as string)
    await moveTask(id, 'queue-tasks', 'processing-tasks')
    await markTaskStatus(id, 'processing-tasks', { executorTaskId: 'still-running-xyz' })
    const before = await getTaskSummary(id, 'processing-tasks')
    expect(before?.executorTaskId).toBe('still-running-xyz')
    await superTasksPauseTool.call({ id })
    const after = await getTaskSummary(id, 'processing-tasks')
    expect(after?.executorTaskId).toBeNull()
  })

  it('verifying 中 subTaskId 不为空 → Pause 后清空', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 'clear-sub-v', cwd: dir })).data.output as string)
    await moveTask(id, 'queue-tasks', 'processing-tasks')
    await markTaskStatus(id, 'processing-tasks', { executorTaskId: 'verify-sub' })
    await moveTask(id, 'processing-tasks', 'verifying-tasks')
    const before = await getTaskSummary(id, 'verifying-tasks')
    expect(before?.executorTaskId).toBe('verify-sub')
    await superTasksPauseTool.call({ id })
    const after = await getTaskSummary(id, 'verifying-tasks')
    expect(after?.executorTaskId).toBeNull()
  })

  it('subTaskId 本来就为 null → Pause 仍 OK 不抛错', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 'already-null', cwd: dir })).data.output as string)
    await moveTask(id, 'queue-tasks', 'processing-tasks')
    await superTasksPauseTool.call({ id })
    const after = await getTaskSummary(id, 'processing-tasks')
    expect(after?.status).toBe('paused')
    expect(after?.executorTaskId).toBeNull()
  })
})