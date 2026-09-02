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
