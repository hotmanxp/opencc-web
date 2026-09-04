import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
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

  // zai patch (2026-09-02, priority + dependsOn 调度):
  it('call 接受 priority=P0 + dependsOn 数组，回写 task.yaml', async () => {
    const res = await superTasksCreateTool.call({
      title: '紧急任务', cwd: dir, priority: 'P0', dependsOn: ['tf-aaaaaaaa', 'tf-bbbbbbbb'],
    })
    const out = res.data.output as string
    expect(out).toContain('priority=P0')
    expect(out).toContain('dependsOn=[tf-aaaaaaaa, tf-bbbbbbbb]')
    const id = extractId(out)
    const yaml = await readFile(join(taskDir('queue-tasks', id), 'task.yaml'), 'utf-8')
    expect(yaml).toContain('priority: P0')
    expect(yaml).toContain('- tf-aaaaaaaa')
    expect(yaml).toContain('- tf-bbbbbbbb')
  })

  it('call 缺省 priority=P2 + dependsOn=[]', async () => {
    const res = await superTasksCreateTool.call({ title: '普通任务', cwd: dir })
    const out = res.data.output as string
    expect(out).toContain('priority=P2')
    // dependsOn=[] 时 result 文本不展示数组
    expect(out).not.toContain('dependsOn=[')
    const id = extractId(out)
    const yaml = await readFile(join(taskDir('queue-tasks', id), 'task.yaml'), 'utf-8')
    expect(yaml).toContain('priority: P2')
    expect(yaml).toMatch(/dependsOn:\s*\[\]/)
  })

  it('call 拒绝非法 priority/P3 之外的值', async () => {
    await expect(superTasksCreateTool.call({
      title: '坏', cwd: dir, priority: 'P9' as never,
    })).rejects.toThrow(/invalid priority/)
  })

  // zai patch (2026-09-04, quick-intake):mode 字段入参 + 落盘分流。
  it('call mode=quick 仅落盘 task.yaml + process.md + docs/spec.md(无 plan.md/brainstorm.md)', async () => {
    const res = await superTasksCreateTool.call({
      title: '改文案', cwd: dir, mode: 'quick', description: '把按钮文案从「提交」改为「完成」',
    })
    const out = res.data.output as string
    expect(out).toContain('mode=quick')
    expect(out).toContain('Task created: tf-')
    const id = extractId(out)
    const dirQ = join(taskDir('queue-tasks', id))
    // quick 模式应存在三个文件
    const spec = await readFile(join(dirQ, 'docs', 'spec.md'), 'utf-8')
    expect(spec).toContain('# 需求规格(快速创建)')
    expect(spec).toContain('- title: 改文案')
    expect(spec).toContain('- description: 把按钮文案从')
    expect(spec).toContain('- priority: P2')
    // quick 模式不应创建 plan.md / brainstorm.md(不存在)
    expect(existsSync(join(dirQ, 'docs', 'plan.md'))).toBe(false)
    expect(existsSync(join(dirQ, 'docs', 'brainstorm.md'))).toBe(false)
    // task.yaml 应包含 mode: quick
    const yaml = await readFile(join(dirQ, 'task.yaml'), 'utf-8')
    expect(yaml).toContain('mode: quick')
  })

  it('call mode=full 落盘完整三份文档骨架(spec/plan),无 mode 字段', async () => {
    const res = await superTasksCreateTool.call({
      title: '完整任务', cwd: dir, mode: 'full', spec: '# SPEC', plan: '# PLAN',
    })
    const out = res.data.output as string
    expect(out).toContain('mode=full')
    const id = extractId(out)
    const dirQ = join(taskDir('queue-tasks', id))
    const spec = await readFile(join(dirQ, 'docs', 'spec.md'), 'utf-8')
    expect(spec).toContain('# SPEC')
    const plan = await readFile(join(dirQ, 'docs', 'plan.md'), 'utf-8')
    expect(plan).toContain('# PLAN')
    // full 模式不写入 mode 字段(避免污染所有历史 full 任务)
    const yaml = await readFile(join(dirQ, 'task.yaml'), 'utf-8')
    expect(yaml).not.toContain('mode:')
  })

  it('call mode 缺省 = full(向后兼容),行为与 mode=full 一致', async () => {
    const res = await superTasksCreateTool.call({
      title: '兼容任务', cwd: dir, spec: '# SPEC',
    })
    const out = res.data.output as string
    expect(out).toContain('mode=full')
    const id = extractId(out)
    const dirQ = join(taskDir('queue-tasks', id))
    const spec = await readFile(join(dirQ, 'docs', 'spec.md'), 'utf-8')
    expect(spec).toContain('# SPEC')
    const yaml = await readFile(join(dirQ, 'task.yaml'), 'utf-8')
    expect(yaml).not.toContain('mode:')
  })

  it('call 拒绝非法 mode 值(非 quick/full)', async () => {
    await expect(superTasksCreateTool.call({
      title: '坏', cwd: dir, mode: 'fast' as never,
    })).rejects.toThrow(/invalid mode/)
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

  it('isReadOnly = true（任务调度官反复读取元数据不触发副作用）', () => {
    expect(superTasksGetTool.isReadOnly({ id: 'tf-x' } as never)).toBe(true)
  })

  // zai patch (2026-09-02, priority + dependsOn 字段):
  it('call 读回的 summary 包含 priority + dependsOn', async () => {
    const res = await superTasksCreateTool.call({
      title: '紧急', cwd: dir, priority: 'P1', dependsOn: ['tf-aaaaaaaa'],
    })
    const id = extractId(res.data.output as string)
    const got = await superTasksGetTool.call({ id })
    const structured = (got.data as { structured: { summary: { priority?: string; dependsOn?: string[] } } }).structured
    expect(structured.summary.priority).toBe('P1')
    expect(structured.summary.dependsOn).toEqual(['tf-aaaaaaaa'])
  })

  // zai patch (2026-09-04, quick-intake):SuperTasksGet 读回 mode 字段。
  it('call 读回的 summary 包含 mode(quick→「quick」,full/缺省→「full」)', async () => {
    const resQuick = await superTasksCreateTool.call({ title: 'q', cwd: dir, mode: 'quick' })
    const idQuick = extractId(resQuick.data.output as string)
    const gotQuick = await superTasksGetTool.call({ id: idQuick })
    const sumQuick = (gotQuick.data as { structured: { summary: { mode?: string } } }).structured.summary
    expect(sumQuick.mode).toBe('quick')

    const resFull = await superTasksCreateTool.call({ title: 'f', cwd: dir })
    const idFull = extractId(resFull.data.output as string)
    const gotFull = await superTasksGetTool.call({ id: idFull })
    const sumFull = (gotFull.data as { structured: { summary: { mode?: string } } }).structured.summary
    expect(sumFull.mode).toBe('full')
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

  // zai patch (2026-09-02, priority 调度):
  it('listTasks 输出 queue 按 priority ASC + createdAt ASC 排序(P0 先)', async () => {
    await superTasksCreateTool.call({ title: 'normal', cwd: dir, priority: 'P2' })
    await superTasksCreateTool.call({ title: 'urgent', cwd: dir, priority: 'P0' })
    await superTasksCreateTool.call({ title: 'low', cwd: dir, priority: 'P3' })
    const got = await superTasksListTool.call({})
    const parsed = JSON.parse(got.data.output as string)
    // 取出我们这 3 个任务的 priority 序列,断言顺序 P0 → P2 → P3
    const priorities = (parsed.buckets.queue as Array<{ title: string; priority?: string }>)
      .filter((t) => ['normal', 'urgent', 'low'].includes(t.title))
      .map((t) => t.priority)
    expect(priorities).toEqual(['P0', 'P2', 'P3'])
  })
})