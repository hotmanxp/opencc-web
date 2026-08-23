import { describe, expect, it } from 'vitest'
import { ServerEvent } from '../../src/shared/events.js'

/**
 * Phase 5P5 dsh-tool-todo whole-list snapshot 适配回归测试。
 *
 * StateEvent zod schema 必须同时支持:
 * - v2_task.changed (opencc-mode) 携带 `task: unknown` + `action: 'upsert' | 'delete'`
 * - v2_task.snapshot (dsh-mode)   携带 `tasks: TodoItem[]` + `action: 'snapshot'`
 *
 * 这两形在 schema 加载时是被 zod discriminatedUnion 拒绝的(同 type literal
 * 重复)—— 一旦 shared/events.ts 模块 load throw,所有依赖 ServerEvent 的
 * 模块 (eventSource / useEventStream / useAgentStore) 全部无法解析,
 * Vite 端 zod.js:2494 Uncaught Error: Discriminator property type has
 * duplicate value v2_task.changed,React <div id="root"> 永远空。
 */
describe('ServerEvent — v2_task 双形态 (opencc-mode 增量 / dsh-mode 全量)', () => {
  it('opencc-mode: v2_task.changed action=upsert 应解析成功', () => {
    const e = ServerEvent.parse({
      type: 'v2_task.changed',
      eventId: 'e1',
      ts: Date.now(),
      seq: 1,
      sessionId: 's-opencc',
      task: {
        id: 't1',
        subject: 'foo',
        status: 'pending',
        blocks: [],
        blockedBy: [],
        updatedAt: 1,
      },
      action: 'upsert',
    })
    expect(e.type).toBe('v2_task.changed')
    if (e.type === 'v2_task.changed') {
      expect(e.action).toBe('upsert')
    }
  })

  it('opencc-mode: v2_task.changed action=delete 应解析成功', () => {
    const e = ServerEvent.parse({
      type: 'v2_task.changed',
      eventId: 'e2',
      ts: Date.now(),
      seq: 2,
      sessionId: 's-opencc',
      task: { id: 't1' },
      action: 'delete',
    })
    expect(e.type).toBe('v2_task.changed')
    if (e.type === 'v2_task.changed') {
      expect(e.action).toBe('delete')
    }
  })

  it('dsh-mode: v2_task.snapshot action=snapshot 应解析成功', () => {
    const e = ServerEvent.parse({
      type: 'v2_task.snapshot',
      eventId: 'e3',
      ts: Date.now(),
      seq: 3,
      sessionId: 's-dsh',
      tasks: [
        { content: 'fix bug', status: 'in_progress' },
        { content: 'add test', status: 'pending' },
      ],
      action: 'snapshot',
    })
    expect(e.type).toBe('v2_task.snapshot')
    if (e.type === 'v2_task.snapshot') {
      expect(e.tasks).toHaveLength(2)
    }
  })

  it('schema 模块 load 时不应抛 duplicate-discriminator 错误', () => {
    // 测试用例 1-3 已经隐式验证:能 import ServerEvent 并调用 parse 不抛
    // 错即说明模块 load 成功。本用例显式做 sanity check,失败信息更清楚
    // (vitest 在 import 失败时报"failed to load module",在 parse 失败时
    // 报 zod 的错误)。
    expect(typeof ServerEvent.parse).toBe('function')
  })
})
