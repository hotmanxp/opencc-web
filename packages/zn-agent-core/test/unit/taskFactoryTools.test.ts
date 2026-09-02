import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  superTasksCreateTool, superTasksListTool, superTasksGetTool, superTasksMoveTool, superTasksResetTool, superTasksPauseTool,
} from '../../src/opencc-src/server/taskFactoryTools.js'
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
  it('SuperTasksCreate / SuperTasksList / SuperTasksGet / SuperTasksMove / SuperTasksReset / SuperTasksPause 均实现结果序列化', () => {
    for (const tool of [superTasksCreateTool, superTasksListTool, superTasksGetTool, superTasksMoveTool, superTasksResetTool, superTasksPauseTool] as const) {
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

describe('superTasksGetTool (2026-09-02)', () => {
  it('call 读回 summary + spec + plan + process(json + structured 两种形态)', async () => {
    const res = await superTasksCreateTool.call({
      title: 'Get 测试', cwd: dir, agent: 'default', spec: '# SPEC\n详情', plan: '# PLAN\n步骤',
    })
    const id = extractId(res.data.output as string)
    const got = await superTasksGetTool.call({ id })
    // output 是 JSON 字符串,可读
    const out = got.data.output as string
    expect(out).toContain('"id"')
    expect(out).toContain(id)
    expect(out).toContain('Get 测试')
    expect(out).toContain('# SPEC')
    expect(out).toContain('# PLAN')
    // structured 形态供 model 直接按字段取值
    const structured = (got.data as { structured?: { summary: { id: string; agent: string }; specMd: string; planMd: string; processMd: string } }).structured
    expect(structured?.summary.id).toBe(id)
    expect(structured?.summary.agent).toBe('default')
    expect(structured?.specMd).toContain('# SPEC')
    expect(structured?.planMd).toContain('# PLAN')
  })

  it('不存在 id → throws "not found"', async () => {
    await expect(superTasksGetTool.call({ id: 'tf-noexist0' })).rejects.toThrow(/not found/)
  })

  it('isReadOnly = true（主管反复读取元数据不触发副作用）', () => {
    expect(superTasksGetTool.isReadOnly({ id: 'tf-x' } as never)).toBe(true)
  })
})

describe('superTasksListTool (2026-09-02)', () => {
  it('call 一次返回四桶全部 summary + counts(json + structured 两种形态)', async () => {
    await superTasksCreateTool.call({ title: 'list-a', cwd: dir })
    await superTasksCreateTool.call({ title: 'list-b', cwd: dir, description: '任务简介 B' })
    const got = await superTasksListTool.call({})
    const out = got.data.output as string
    // JSON 字符串含四桶
    expect(out).toContain('"queue"')
    expect(out).toContain('"processing"')
    expect(out).toContain('"verifying"')
    expect(out).toContain('"finished"')
    expect(out).toContain('list-a')
    expect(out).toContain('list-b')
    expect(out).toContain('任务简介 B')
    // counts 摘要
    const parsed = JSON.parse(out)
    expect(parsed.counts.queue).toBeGreaterThanOrEqual(2)
    // structured 形态供 model 取数
    const structured = (got.data as { structured: { buckets: { queue: unknown[]; processing: unknown[]; verifying: unknown[]; finished: unknown[] }; counts: { queue: number } } }).structured
    expect(Array.isArray(structured.buckets.queue)).toBe(true)
    expect(structured.counts.queue).toBeGreaterThanOrEqual(2)
  })

  it('空仓库时返回 counts 全 0 + 四桶空数组', async () => {
    const got = await superTasksListTool.call({})
    const parsed = JSON.parse(got.data.output as string)
    expect(parsed.counts).toEqual({ queue: 0, processing: 0, verifying: 0, finished: 0 })
    expect(parsed.buckets.queue).toEqual([])
    expect(parsed.buckets.processing).toEqual([])
    expect(parsed.buckets.verifying).toEqual([])
    expect(parsed.buckets.finished).toEqual([])
  })

  it('isReadOnly + isConcurrencySafe = true（pipeline 总览可并发调）', () => {
    expect(superTasksListTool.isReadOnly({} as never)).toBe(true)
    expect(superTasksListTool.isConcurrencySafe({} as never)).toBe(true)
  })
})