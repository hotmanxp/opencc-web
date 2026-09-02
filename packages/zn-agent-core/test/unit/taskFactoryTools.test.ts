import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  superTasksCreateTool, superTasksMarkDoneTool, superTasksVerifyTool,
} from '../../src/opencc-src/server/taskFactoryTools.js'
import { taskDir, moveTask } from '../../src/opencc-src/server/taskFactoryFiles.js'

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
    expect(out).toContain(`Project cwd: ${dir}`)
    expect(events[0]?.action).toBe('created')
    const id = extractId(out)
    const spec = await readFile(join(taskDir('queue-tasks', id), 'docs', 'spec.md'), 'utf-8')
    expect(spec).toContain('# SPEC')
  })
})

describe('tool_result serialization (2026-09-02 回归)', () => {
  // runtime 在把 call() 结果落成 tool_result 块时强制调
  // mapToolResultToToolResultBlockParam —— 缺实现会抛
  // "is not a function"(intake 弹窗实跑暴露)。
  it('SuperTasksCreate / SuperTasksMarkDone / SuperTasksVerify 均实现结果序列化', () => {
    for (const tool of [superTasksCreateTool, superTasksMarkDoneTool, superTasksVerifyTool] as const) {
      expect(typeof tool.mapToolResultToToolResultBlockParam).toBe('function')
      const block = tool.mapToolResultToToolResultBlockParam(
        { output: 'hello-out' },
        'tu-1',
      )
      expect(block).toEqual({
        type: 'tool_result',
        tool_use_id: 'tu-1',
        content: [{ type: 'text', text: 'hello-out' }],
      })
    }
  })
})

describe('superTasksMarkDoneTool', () => {
  it('把 processing 任务移到 finished 并 emit finished', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 't2', cwd: dir })).data.output as string)
    // 模拟执行开始：任务先移到 processing（同列队→执行中的状态流转）
    await moveTask(id, 'queue-tasks', 'processing-tasks')
    const r = await superTasksMarkDoneTool.call({ id })
    expect(r.data.output).toContain('done')
    expect(events.some((e) => e.action === 'finished' && e.payload.id === id)).toBe(true)
  })

  it('对不在 processing/verifying 的任务抛错', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 't3', cwd: dir })).data.output as string) // 仍在 queue-tasks
    await expect(superTasksMarkDoneTool.call({ id })).rejects.toThrow(/acceptance rejected|not found/)
  })

  it('verifying 桶任务允许强制通过(2026-09-02 新增)', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 'force', cwd: dir })).data.output as string)
    await moveTask(id, 'queue-tasks', 'processing-tasks')
    await moveTask(id, 'processing-tasks', 'verifying-tasks')
    const r = await superTasksMarkDoneTool.call({ id })
    expect(r.data.output).toContain('forced from verifying-tasks')
    expect(events.some((e) => e.action === 'finished' && e.payload.id === id)).toBe(true)
  })
})

describe('superTasksVerifyTool', () => {
  it('call 把 processing 任务移到 verifying, 写 verification.md 头段, emit verifying', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 'v4', cwd: dir, verifierAgent: 'code-reviewer' })).data.output as string)
    await moveTask(id, 'queue-tasks', 'processing-tasks')

    const r = await superTasksVerifyTool.call({ id })
    const out = r.data.output as string
    expect(out).toContain('Round: 1')
    expect(out).toContain('Verifier agent: code-reviewer')
    expect(events.some((e) => e.action === 'verifying' && e.payload.id === id && e.payload.round === 1)).toBe(true)

    const vFile = join(taskDir('verifying-tasks', id), 'docs', 'verification.md')
    expect(existsSync(vFile)).toBe(true)
    const text = await readFile(vFile, 'utf-8')
    expect(text).toContain('## 轮次 1')
    expect(text).toContain('验证 agent: code-reviewer')
  })

  it('verifierAgent 入参覆盖 index.md 字段', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 'v5', cwd: dir, verifierAgent: 'old' })).data.output as string)
    await moveTask(id, 'queue-tasks', 'processing-tasks')
    const r = await superTasksVerifyTool.call({ id, verifierAgent: 'override' })
    expect(r.data.output).toContain('Verifier agent: override')
  })

  it('无 verifierAgent 时回落到任务 agent 字段', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 'v6', cwd: dir, agent: 'claude-code' })).data.output as string)
    await moveTask(id, 'queue-tasks', 'processing-tasks')
    const r = await superTasksVerifyTool.call({ id })
    expect(r.data.output).toContain('Verifier agent: claude-code')
  })

  it('从非 processing 桶抛错(queue → verifying 非法)', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 'v7', cwd: dir })).data.output as string)
    // 仍在 queue-tasks
    await expect(superTasksVerifyTool.call({ id })).rejects.toThrow(/verification rejected|not found/)
  })

  it('从 paused 起验证是非法状态(status≠processing)', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 'v8', cwd: dir })).data.output as string)
    await moveTask(id, 'queue-tasks', 'processing-tasks')
    const { markTaskStatus } = await import('../../src/opencc-src/server/taskFactoryFiles.js')
    await markTaskStatus(id, 'processing-tasks', { status: 'paused' })
    await expect(superTasksVerifyTool.call({ id })).rejects.toThrow(/must be "processing"/)
  })

  it('轮次自增: 同一任务第二次 verify 头段写 ## 轮次 2', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 'v9', cwd: dir })).data.output as string)
    await moveTask(id, 'queue-tasks', 'processing-tasks')
    // 第一轮
    await superTasksVerifyTool.call({ id })
    // 把任务移回 processing 模拟「FAIL → executor 修 → 再次 verify」
    await moveTask(id, 'verifying-tasks', 'processing-tasks')
    const r = await superTasksVerifyTool.call({ id })
    expect(r.data.output).toContain('Round: 2')
    const vFile = join(taskDir('verifying-tasks', id), 'docs', 'verification.md')
    const text = await readFile(vFile, 'utf-8')
    expect(text).toContain('## 轮次 1')
    expect(text).toContain('## 轮次 2')
  })
})