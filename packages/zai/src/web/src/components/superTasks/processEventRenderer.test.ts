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

describe('toRendered · system 分支', () => {
  it('init subtype → system{sub:init}', () => {
    expect(
      toRendered({
        id: 1,
        event: 'system',
        data: {
          seq: 1,
          ts: 1000,
          type: 'system',
          data: { subtype: 'init' },
        },
      }),
    ).toEqual({
      kind: 'system',
      seq: 1,
      ts: 1000,
      sub: 'init',
    })
  })

  it('compact_boundary subtype → system{sub:compact_boundary}', () => {
    expect(
      toRendered({
        id: 2,
        event: 'system',
        data: {
          seq: 2,
          ts: 2000,
          type: 'system',
          data: { subtype: 'compact_boundary' },
        },
      }),
    ).toEqual({
      kind: 'system',
      seq: 2,
      ts: 2000,
      sub: 'compact_boundary',
    })
  })
})

describe('toRendered · user 分支 (text only)', () => {
  it('content[0].type=text → user{text,cwd?,agent?}', () => {
    expect(
      toRendered({
        id: 1,
        event: 'user',
        data: {
          seq: 1,
          ts: 1000,
          type: 'user',
          data: {
            message: {
              content: [{ type: 'text', text: 'hello agent' }],
            },
            cwd: '/Users/ethan',
            agent: 'zai-default',
          },
        },
      }),
    ).toEqual({
      kind: 'user',
      seq: 1,
      ts: 1000,
      text: 'hello agent',
      cwd: '/Users/ethan',
      agent: 'zai-default',
    })
  })

  it('content[0].type=text 无 cwd/agent → user{text} 缺 cwd/agent 字段', () => {
    expect(
      toRendered({
        id: 2,
        event: 'user',
        data: {
          seq: 2,
          ts: 2000,
          type: 'user',
          data: {
            message: { content: [{ type: 'text', text: 'no meta' }] },
          },
        },
      }),
    ).toEqual({
      kind: 'user',
      seq: 2,
      ts: 2000,
      text: 'no meta',
    })
  })

  it('content[0].type=tool_result → 不归 user (走 tool-result 分支；本 cycle 返回 null 占位)', () => {
    // 此 case 在 tool-result cycle 实现后改期望；先 null 表达"分支延迟"
    expect(
      toRendered({
        id: 3,
        event: 'user',
        data: {
          seq: 3,
          ts: 3000,
          type: 'user',
          data: {
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tool-1',
                  content: 'OK',
                  is_error: false,
                },
              ],
            },
          },
        },
      }),
    ).toBeNull()
  })

  it('block type 未知 → null (该 block skip,无其他 block 顶替)', () => {
    expect(
      toRendered({
        id: 4,
        event: 'user',
        data: {
          seq: 4,
          ts: 4000,
          type: 'user',
          data: {
            message: { content: [{ type: 'unknown_kind', foo: 1 }] },
          },
        },
      }),
    ).toBeNull()
  })
})

describe('toRendered · assistant 分支 (text/thinking 占位,tool_use 在 cycle 5)', () => {
  it('content[0].type=text → assistant-text', () => {
    expect(
      toRendered({
        id: 1,
        event: 'assistant',
        data: {
          seq: 1,
          ts: 1000,
          type: 'assistant',
          data: {
            message: { content: [{ type: 'text', text: 'hi from model' }] },
          },
        },
      }),
    ).toEqual({
      kind: 'assistant-text',
      seq: 1,
      ts: 1000,
      text: 'hi from model',
    })
  })

  it('content[0].type=thinking → thinking', () => {
    expect(
      toRendered({
        id: 2,
        event: 'assistant',
        data: {
          seq: 2,
          ts: 2000,
          type: 'assistant',
          data: {
            message: {
              content: [{ type: 'thinking', text: 'reasoning...' }],
            },
          },
        },
      }),
    ).toEqual({
      kind: 'thinking',
      seq: 2,
      ts: 2000,
      text: 'reasoning...',
    })
  })

  it('content[0].type=tool_use → tool-use 分支占位 (cycle 5 补;本 cycle null)', () => {
    expect(
      toRendered({
        id: 3,
        event: 'assistant',
        data: {
          seq: 3,
          ts: 3000,
          type: 'assistant',
          data: {
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'tu-1',
                  name: 'Bash',
                  input: { command: 'ls' },
                },
              ],
            },
          },
        },
      }),
    ).toBeNull()
  })

  it('assistant 但 text 字段缺 → assistant-text 空串兜底', () => {
    expect(
      toRendered({
        id: 4,
        event: 'assistant',
        data: {
          seq: 4,
          ts: 4000,
          type: 'assistant',
          data: {
            message: { content: [{ type: 'text' }] },
          },
        },
      }),
    ).toEqual({
      kind: 'assistant-text',
      seq: 4,
      ts: 4000,
      text: '',
    })
  })
})
