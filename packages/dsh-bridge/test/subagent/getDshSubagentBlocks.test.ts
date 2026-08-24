/**
 * 2026-08-24 Blocker E: getDshSubagentBlocks 单测。
 *
 * 读 `~/.zai/tasks-dsh/<taskId>.json` 里的 `blocks` 字段,经
 * `parseContentBlocks` 校验后返回 ContentBlock[]。文件不存在 / 缺
 * blocks 字段 / blocks 解析失败均降级到空数组(不抛错)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

// mock ~/.zai/tasks-dsh/ 到临时目录
const mockState = vi.hoisted(() => ({ tmpHome: '' }))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    get homedir() {
      return () => mockState.tmpHome
    },
  }
})

import {
  getDshSubagentBlocks,
  dshTaskPath,
  type DshTaskState,
} from '../../src/subagent/taskStore.js'

describe('getDshSubagentBlocks (Blocker E)', () => {
  let tmpHome: string

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'dsh-bridge-blocks-'))
    mockState.tmpHome = tmpHome
    await mkdir(join(tmpHome, '.zai', 'tasks-dsh'), { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true })
  })

  it('缺文件 → 返回空数组 (不抛)', async () => {
    const blocks = await getDshSubagentBlocks({} as never, 'nonexistent-task-id')
    expect(blocks).toEqual([])
  })

  it('有 blocks 字段时,正确解析为 ContentBlock[]', async () => {
    const taskId = 'dsh-task-blocks-1'
    const state: DshTaskState = {
      taskId,
      sessionId: 'sess-1',
      status: 'done',
      prompt: 'noop',
      startedAt: 100,
      blocks: [
        { type: 'thinking', thinking: 'reasoning...' },
        { type: 'text', text: '**hello**' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { path: '/x' } },
        { type: 'tool_result', tool_use_id: 't1', content: 'output', is_error: false },
      ],
    }
    await writeFile(dshTaskPath(taskId), JSON.stringify(state), 'utf-8')

    const blocks = await getDshSubagentBlocks({} as never, taskId)
    expect(blocks).toHaveLength(4)
    expect(blocks[0]).toEqual({ type: 'thinking', thinking: 'reasoning...' })
    expect(blocks[2]).toEqual({ type: 'tool_use', id: 't1', name: 'Read', input: { path: '/x' } })
  })

  it('缺 blocks 字段 → 返回空数组', async () => {
    const taskId = 'dsh-task-no-blocks'
    const state: DshTaskState = {
      taskId,
      sessionId: 'sess-2',
      status: 'running',
      prompt: 'noop',
      startedAt: 200,
      // 无 blocks 字段
    }
    await writeFile(dshTaskPath(taskId), JSON.stringify(state), 'utf-8')

    const blocks = await getDshSubagentBlocks({} as never, taskId)
    expect(blocks).toEqual([])
  })

  it('blocks 不是数组 → 返回空数组 (防御 shape)', async () => {
    const taskId = 'dsh-task-bad-blocks'
    const state = {
      taskId,
      sessionId: 'sess-3',
      status: 'running',
      prompt: 'noop',
      startedAt: 300,
      blocks: 'not-an-array',
    }
    await writeFile(dshTaskPath(taskId), JSON.stringify(state), 'utf-8')

    const blocks = await getDshSubagentBlocks({} as never, taskId)
    expect(blocks).toEqual([])
  })

  it('未知 type 单元素被跳过,其它正常保留', async () => {
    const taskId = 'dsh-task-mixed-blocks'
    const state = {
      taskId,
      sessionId: 'sess-4',
      status: 'done',
      prompt: 'noop',
      startedAt: 400,
      blocks: [
        { type: 'text', text: 'visible' },
        { type: 'unknown-future-type', x: 1 }, // 单元素解析失败,parseContentBlocks 内部 try/catch 跳过
      ],
    }
    await writeFile(dshTaskPath(taskId), JSON.stringify(state), 'utf-8')

    const blocks = await getDshSubagentBlocks({} as never, taskId)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toEqual({ type: 'text', text: 'visible' })
  })
})