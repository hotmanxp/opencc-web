import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  superTasksCreateTool, superTasksMoveTool, superTasksResetTool, superTasksPauseTool,
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
  it('SuperTasksCreate / SuperTasksMove / SuperTasksReset / SuperTasksPause 均实现结果序列化', () => {
    for (const tool of [superTasksCreateTool, superTasksMoveTool, superTasksResetTool, superTasksPauseTool] as const) {
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