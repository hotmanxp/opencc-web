/**
 * 2026-08-24 Blocker D: server `/api/subagent-tasks` 返回 shape 用 `taskId`,
 * 而 `DshSubagentTaskItem` 期望 `id` + `taskId` 双字段 — `normalizeTask`
 * 把 server payload 归一化成 client 期望的 shape。
 *
 * 同时归一化 `description` ↔ `prompt`(server 返回 `description`,DSH 落盘
 * 原始字段是 `prompt`)。
 *
 * 单测覆盖 4 种 server payload shape:
 *  1. 全字段 server shape(`taskId` + `description`)
 *  2. fallback shape(`id` + `prompt`)
 *  3. 缺 taskId 的废条目(应过滤掉)
 *  4. 缺 description / prompt 时 description 为 undefined
 */
import { describe, expect, it } from 'vitest'
import { normalizeTask } from '../../../src/web/src/hooks/useSubagentTasks.js'

describe('useSubagentTasks normalizeTask (Blocker D)', () => {
  it('server taskId shape — taskId 字段映射到 id + taskId', () => {
    const raw = {
      taskId: 'dsh-task-1',
      sessionId: 'sess-1',
      parentSessionId: 'sess-0',
      status: 'done',
      description: 'do something',
      startedAt: 100,
      finishedAt: 200,
      stopReason: 'completed',
    }
    const out = normalizeTask(raw)
    expect(out).not.toBeNull()
    expect(out?.id).toBe('dsh-task-1')
    expect(out?.taskId).toBe('dsh-task-1')
    expect(out?.status).toBe('done')
    expect(out?.description).toBe('do something')
    expect(out?.sessionId).toBe('sess-1')
    expect(out?.parentSessionId).toBe('sess-0')
    expect(out?.state).toBe('settled') // done -> settled
  })

  it('fallback id/prompt shape — id 兜底 + prompt 映射到 description', () => {
    const raw = {
      id: 'dsh-task-2',
      prompt: 'long prompt text that should be truncated in description',
      status: 'running',
    }
    const out = normalizeTask(raw)
    expect(out).not.toBeNull()
    expect(out?.id).toBe('dsh-task-2')
    expect(out?.taskId).toBe('dsh-task-2')
    expect(out?.description).toBe('long prompt text that should be truncated in description')
    expect(out?.status).toBe('running')
    expect(out?.state).toBe('running')
  })

  it('缺 taskId + id 的废条目 → null(应被调用方过滤掉)', () => {
    const out = normalizeTask({ sessionId: 'sess-x' })
    expect(out).toBeNull()
  })

  it('null / 非对象 → null', () => {
    expect(normalizeTask(null)).toBeNull()
    expect(normalizeTask(undefined)).toBeNull()
    expect(normalizeTask('not object')).toBeNull()
  })

  it('description 缺 / prompt 缺 时 description 为 undefined', () => {
    const out = normalizeTask({ taskId: 'a', status: 'done' })
    expect(out?.description).toBeUndefined()
  })

  it('state 字段缺省时按 status 派生', () => {
    const running = normalizeTask({ taskId: 'r', status: 'running' })
    expect(running?.state).toBe('running')
    const done = normalizeTask({ taskId: 'd', status: 'done' })
    expect(done?.state).toBe('settled')
    const failed = normalizeTask({ taskId: 'f', status: 'failed' })
    expect(failed?.state).toBe('settled')
  })

  it('显式 state 字段优先于 status 派生', () => {
    const out = normalizeTask({ taskId: 'x', status: 'done', state: 'waiting' })
    expect(out?.state).toBe('waiting')
  })

  it('可选字段只在有值时输出(undefined 不会 spread 到对象)', () => {
    const out = normalizeTask({ taskId: 'a', status: 'running' })
    expect(out).not.toHaveProperty('parentSessionId')
    expect(out).not.toHaveProperty('provider')
    expect(out).not.toHaveProperty('startedAt')
    expect(out).not.toHaveProperty('finishedAt')
    expect(out).not.toHaveProperty('stopReason')
    expect(out).not.toHaveProperty('error')
  })
})