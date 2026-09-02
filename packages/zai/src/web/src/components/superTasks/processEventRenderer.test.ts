import { describe, expect, it } from 'vitest'
import { toRendered } from './processEventRenderer'

describe('toRendered · task.ended 三态', () => {
  it('completed → task-ended', () => {
    expect(
      toRendered({
        id: 1,
        event: 'task.ended',
        data: {
          seq: 1,
          ts: 1700000000000,
          type: 'task.ended',
          taskId: 'tf-x',
          status: 'completed',
          resultText: 'all done',
        },
      }),
    ).toEqual({
      kind: 'task-ended',
      status: 'completed',
      resultText: 'all done',
    })
  })

  it('failed → task-ended (status=failed, error 透传)', () => {
    expect(
      toRendered({
        id: 2,
        event: 'task.ended',
        data: {
          seq: 2,
          ts: 1700000001000,
          type: 'task.ended',
          taskId: 'tf-x',
          status: 'failed',
          error: 'boom',
        },
      }),
    ).toEqual({
      kind: 'task-ended',
      status: 'failed',
      error: 'boom',
    })
  })

  it('cancelled → task-ended (status=cancelled, 不带 error/resultText)', () => {
    expect(
      toRendered({
        id: 3,
        event: 'task.ended',
        data: {
          seq: 3,
          ts: 1700000002000,
          type: 'task.ended',
          taskId: 'tf-x',
          status: 'cancelled',
        },
      }),
    ).toEqual({
      kind: 'task-ended',
      status: 'cancelled',
    })
  })

  it('task.ended 但 status 非 terminal → null', () => {
    expect(
      toRendered({
        id: 4,
        event: 'task.ended',
        data: {
          seq: 4,
          ts: 1,
          type: 'task.ended',
          taskId: 'tf-x',
          status: 'running',
        },
      }),
    ).toBeNull()
  })

  it('task.ended 但缺 status → null', () => {
    expect(
      toRendered({
        id: 5,
        event: 'task.ended',
        data: { seq: 5, ts: 1, type: 'task.ended', taskId: 'tf-x' },
      }),
    ).toBeNull()
  })
})

describe('toRendered · 帧级守卫', () => {
  it('frame.data 非对象 → null', () => {
    expect(toRendered({ id: 1, event: 'system', data: 'oops' })).toBeNull()
    expect(toRendered({ id: 2, event: 'system', data: 42 })).toBeNull()
    expect(toRendered({ id: 3, event: 'system', data: null })).toBeNull()
    expect(toRendered({ id: 4, event: 'system', data: undefined })).toBeNull()
  })

  it('attach 帧但 frame.data.data(raw) 缺 → null', () => {
    // raw 缺 (没 data.data 字段)
    expect(
      toRendered({
        id: 1,
        event: 'system',
        data: { seq: 1, ts: 1, type: 'system' },
      }),
    ).toBeNull()
    // raw 是非对象
    expect(
      toRendered({
        id: 2,
        event: 'system',
        data: { seq: 2, ts: 1, type: 'system', data: 42 },
      }),
    ).toBeNull()
    expect(
      toRendered({
        id: 3,
        event: 'system',
        data: { seq: 3, ts: 1, type: 'system', data: null },
      }),
    ).toBeNull()
    expect(
      toRendered({
        id: 4,
        event: 'system',
        data: { seq: 4, ts: 1, type: 'system', data: 'x' },
      }),
    ).toBeNull()
  })

  it('unknown RuntimeEvent type → null (不静默丢,显式 null)', () => {
    expect(
      toRendered({
        id: 1,
        event: 'message_start',
        data: { seq: 1, ts: 1, type: 'message_start', data: { foo: 1 } },
      }),
    ).toBeNull()
  })

  it('content 缺/非数组 → null', () => {
    // assistant 类型但 content 缺
    expect(
      toRendered({
        id: 1,
        event: 'assistant',
        data: { seq: 1, ts: 1, type: 'assistant', data: { message: {} } },
      }),
    ).toBeNull()
    // assistant 类型但 content 非数组
    expect(
      toRendered({
        id: 2,
        event: 'assistant',
        data: {
          seq: 2,
          ts: 1,
          type: 'assistant',
          data: { message: { content: 'oops' } },
        },
      }),
    ).toBeNull()
  })

  it('user 类型但 content 缺 → null', () => {
    expect(
      toRendered({
        id: 1,
        event: 'user',
        data: { seq: 1, ts: 1, type: 'user', data: { message: {} } },
      }),
    ).toBeNull()
  })
})
