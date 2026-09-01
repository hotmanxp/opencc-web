import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { superTasksCreateTool, superTasksMarkDoneTool } from '../../src/opencc-src/server/taskFactoryTools.js'
import { taskDir } from '../../src/opencc-src/server/taskFactoryFiles.js'

let dir: string
let events: Array<{ action: string; payload: Record<string, unknown> }>

/** 工具 call 的 output 是纯文本（非 JSON），用正则取任务 id。 */
function extractId(out: string): string {
  return (out.match(/tf-[a-z0-9]{8}/) as RegExpMatchArray)[0] as string
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tf-tool-'))
  process.env.ZAI_TASK_FACTORY_DIR = dir
  events = []
  ;(globalThis as any).__zaiTaskFactoryEmitter = (e: any) => events.push(e)
})
afterEach(async () => {
  delete process.env.ZAI_TASK_FACTORY_DIR
  delete (globalThis as any).__zaiTaskFactoryEmitter
  await rm(dir, { recursive: true, force: true })
})

describe('superTasksCreateTool', () => {
  it('call 创建骨架并 emit created', async () => {
    const res = await superTasksCreateTool.call({ title: '写周报脚本', cwd: dir, agent: 'default', spec: '# SPEC' })
    const out = res.data.output as string
    expect(out).toContain('Task created: tf-')
    expect(out).toContain(`工程目录: ${dir}`)
    expect(events[0]?.action).toBe('created')
    const id = extractId(out)
    const spec = await readFile(join(taskDir('queue-tasks', id), 'docs', 'spec.md'), 'utf-8')
    expect(spec).toContain('# SPEC')
  })
})

describe('superTasksMarkDoneTool', () => {
  it('把 processing 任务移到 finished 并 emit finished', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 't2', cwd: dir })).data.output as string)
    // 模拟执行开始：任务先移到 processing（同列队→执行中的状态流转）
    const { moveTask } = await import('../../src/opencc-src/server/taskFactoryFiles.js')
    await moveTask(id, 'queue-tasks', 'processing-tasks')
    const r = await superTasksMarkDoneTool.call({ id })
    expect(r.data.output).toContain('done')
    expect(events.some((e) => e.action === 'finished' && e.payload.id === id)).toBe(true)
  })

  it('对不在 processing 的任务抛错', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 't3', cwd: dir })).data.output as string) // 仍在 queue-tasks
    await expect(superTasksMarkDoneTool.call({ id })).rejects.toThrow(/拒绝验收|not found/)
  })
})