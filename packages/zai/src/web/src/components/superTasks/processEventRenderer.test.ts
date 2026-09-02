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

  it('content[0].type=tool_result → tool-result (优先 tool-result 分支)', () => {
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
    ).toMatchObject({ kind: 'tool-result' })
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

  it('content[0].type=tool_use → tool-use (Bash → command 80)', () => {
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
    ).toEqual({
      kind: 'tool-use',
      seq: 3,
      ts: 3000,
      name: 'Bash',
      toolUseId: 'tu-1',
      summary: 'ls',
      fullInput: { command: 'ls' },
    })
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

describe('toRendered · tool-use 8 个工具名 summary', () => {
  const mk = (
    name: string,
    id: string,
    input: Record<string, unknown>,
    seq = 1,
    ts = 1000,
  ) => ({
    id: seq,
    event: 'assistant',
    data: {
      seq,
      ts,
      type: 'assistant',
      data: {
        message: {
          content: [{ type: 'tool_use', id, name, input }],
        },
      },
    },
  })

  it('Read → file_path', () => {
    const r = toRendered(mk('Read', 'tu-r', { file_path: '/tmp/x.ts' }))
    expect(r).toMatchObject({
      kind: 'tool-use',
      name: 'Read',
      toolUseId: 'tu-r',
      summary: '/tmp/x.ts',
      fullInput: { file_path: '/tmp/x.ts' },
    })
  })

  it('Write → file_path', () => {
    const r = toRendered(mk('Write', 'tu-w', { file_path: '/tmp/y.ts', content: '...' }))
    expect(r).toMatchObject({ summary: '/tmp/y.ts' })
  })

  it('Edit → file_path', () => {
    const r = toRendered(mk('Edit', 'tu-e', { file_path: '/tmp/z.ts' }))
    expect(r).toMatchObject({ summary: '/tmp/z.ts' })
  })

  it('MultiEdit → file_path', () => {
    const r = toRendered(mk('MultiEdit', 'tu-me', { file_path: '/tmp/m.ts' }))
    expect(r).toMatchObject({ summary: '/tmp/m.ts' })
  })

  it('Bash → command 前 80 字', () => {
    const longCmd = 'echo ' + 'a'.repeat(200)
    const r = toRendered(mk('Bash', 'tu-b', { command: longCmd }))
    expect(r).toMatchObject({ summary: longCmd.slice(0, 80) })
  })

  it('Bash command 短 → 全量(不超过 80)', () => {
    const r = toRendered(mk('Bash', 'tu-b2', { command: 'ls' }))
    expect(r).toMatchObject({ summary: 'ls' })
  })

  it('Grep → pattern', () => {
    const r = toRendered(mk('Grep', 'tu-g', { pattern: 'TODO', path: '/src' }))
    expect(r).toMatchObject({ summary: 'TODO' })
  })

  it('Glob → pattern · path', () => {
    const r = toRendered(mk('Glob', 'tu-gl', { pattern: '*.ts', path: '/src' }))
    expect(r).toMatchObject({ summary: '*.ts · /src' })
  })

  it('Agent → description 优先', () => {
    const r = toRendered(
      mk('Agent', 'tu-a', {
        description: 'fix bug',
        prompt: 'long prompt...',
      }),
    )
    expect(r).toMatchObject({ summary: 'fix bug' })
  })

  it('Agent 缺 description → prompt 前 60 字', () => {
    const long = 'p'.repeat(100)
    const r = toRendered(mk('Agent', 'tu-a2', { prompt: long }))
    expect(r).toMatchObject({ summary: long.slice(0, 60) })
  })

  it('Task → description 优先 (跟 Agent 同 path)', () => {
    const r = toRendered(
      mk('Task', 'tu-t', {
        description: 'kick off plan',
        prompt: 'long prompt',
      }),
    )
    expect(r).toMatchObject({ summary: 'kick off plan' })
  })

  it('其他工具名 → JSON.stringify(input).slice(0,80)', () => {
    const input = { foo: 'bar', n: 42, big: 'x'.repeat(200) }
    const r = toRendered(mk('CustomTool', 'tu-c', input))
    expect(r).toMatchObject({
      name: 'CustomTool',
      toolUseId: 'tu-c',
      summary: JSON.stringify(input).slice(0, 80),
      fullInput: input,
    })
  })

  it('tool_use 缺 input → JSON.stringify({}).slice(0,80) (空对象 fallback)', () => {
    const r = toRendered(mk('Read', 'tu-ni', {} as unknown as Record<string, unknown>))
    expect(r).toMatchObject({
      kind: 'tool-use',
      name: 'Read',
      summary: JSON.stringify({}).slice(0, 80),
    })
  })

  it('tool_use 缺 id/name → null (缺关键字段不渲染)', () => {
    expect(
      toRendered({
        id: 1,
        event: 'assistant',
        data: {
          seq: 1,
          ts: 1,
          type: 'assistant',
          data: { message: { content: [{ type: 'tool_use', input: {} }] } },
        },
      }),
    ).toBeNull()
  })
})

describe('toRendered · tool-result string / array / is_error', () => {
  it('string content → summary = 首行 + 长度', () => {
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
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tu-1',
                  content: 'first line\nsecond line',
                  is_error: false,
                },
              ],
            },
          },
        },
      }),
    ).toEqual({
      kind: 'tool-result',
      seq: 1,
      ts: 1000,
      toolUseId: 'tu-1',
      isError: false,
      summary: 'first line (22 chars)',
      fullContent: 'first line\nsecond line',
    })
  })

  it('string content 但 is_error=true 缺省 → 视作 false', () => {
    expect(
      toRendered({
        id: 2,
        event: 'user',
        data: {
          seq: 2,
          ts: 2000,
          type: 'user',
          data: {
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tu-2',
                  content: 'OK',
                },
              ],
            },
          },
        },
      }),
    ).toMatchObject({ isError: false })
  })

  it('is_error=true → flag', () => {
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
                  tool_use_id: 'tu-3',
                  content: 'permission denied',
                  is_error: true,
                },
              ],
            },
          },
        },
      }),
    ).toMatchObject({ isError: true })
  })

  it('array content(text only) → 拼 text', () => {
    expect(
      toRendered({
        id: 4,
        event: 'user',
        data: {
          seq: 4,
          ts: 4000,
          type: 'user',
          data: {
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tu-4',
                  content: [
                    { type: 'text', text: 'alpha ' },
                    { type: 'text', text: 'beta' },
                  ],
                  is_error: false,
                },
              ],
            },
          },
        },
      }),
    ).toEqual({
      kind: 'tool-result',
      seq: 4,
      ts: 4000,
      toolUseId: 'tu-4',
      isError: false,
      summary: 'alpha beta (10 chars)',
      fullContent: 'alpha beta',
    })
  })

  it('array content 混 image/document → 跳过 image/document,只留 text', () => {
    expect(
      toRendered({
        id: 5,
        event: 'user',
        data: {
          seq: 5,
          ts: 5000,
          type: 'user',
          data: {
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tu-5',
                  content: [
                    { type: 'text', text: 'kept' },
                    { type: 'image', source: { type: 'base64', data: '...' } },
                    { type: 'document', source: { type: 'base64', data: '...' } },
                  ],
                  is_error: false,
                },
              ],
            },
          },
        },
      }),
    ).toMatchObject({
      kind: 'tool-result',
      toolUseId: 'tu-5',
      fullContent: 'kept',
      summary: 'kept (4 chars)',
    })
  })

  it('array 全 image/document → summary = 空 0 chars', () => {
    expect(
      toRendered({
        id: 6,
        event: 'user',
        data: {
          seq: 6,
          ts: 6000,
          type: 'user',
          data: {
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tu-6',
                  content: [{ type: 'image', source: { type: 'base64', data: 'x' } }],
                  is_error: false,
                },
              ],
            },
          },
        },
      }),
    ).toMatchObject({
      kind: 'tool-result',
      fullContent: '',
      summary: '(0 chars)',
    })
  })

  it('tool_result 缺 tool_use_id → null', () => {
    expect(
      toRendered({
        id: 7,
        event: 'user',
        data: {
          seq: 7,
          ts: 7000,
          type: 'user',
          data: {
            message: {
              content: [{ type: 'tool_result', content: 'x', is_error: false }],
            },
          },
        },
      }),
    ).toBeNull()
  })

  it('tool_result 但 content 缺 → null (无显示内容)', () => {
    expect(
      toRendered({
        id: 8,
        event: 'user',
        data: {
          seq: 8,
          ts: 8000,
          type: 'user',
          data: {
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tu-8',
                  is_error: false,
                },
              ],
            },
          },
        },
      }),
    ).toBeNull()
  })

  it('user frame 但首 block 是 tool_result → tool-result (优先 tool-result 分支)', () => {
    expect(
      toRendered({
        id: 9,
        event: 'user',
        data: {
          seq: 9,
          ts: 9000,
          type: 'user',
          data: {
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tu-9',
                  content: 'OK',
                  is_error: false,
                },
              ],
            },
          },
        },
      }),
    ).toMatchObject({ kind: 'tool-result' })
  })
})

/* ── 真实 wire 形态 (`data.data.raw.<fields>`,zai DefaultBackgroundRuntime
   走 appendTaskEvent + evToWire 后 payload 嵌套) ─────────────────── */

describe('toRendered · 真实 wire 形态 (data.data.raw.*)', () => {
  it('system frame with .raw wrapper → system{sub}', () => {
    expect(
      toRendered({
        id: 1,
        event: 'system',
        data: {
          seq: 1,
          ts: 1000,
          type: 'system',
          data: {
            text: '',
            raw: { type: 'system', subtype: 'init', cwd: '/x', session_id: 's1' },
          },
        },
      }),
    ).toEqual({ kind: 'system', seq: 1, ts: 1000, sub: 'init' })
  })

  it('assistant with .raw wrapper, content[0].type=thinking → thinking', () => {
    expect(
      toRendered({
        id: 2,
        event: 'assistant',
        data: {
          seq: 2,
          ts: 2000,
          type: 'assistant',
          data: {
            text: '',
            raw: {
              type: 'assistant',
              message: {
                id: 'msg-1',
                role: 'assistant',
                content: [
                  {
                    type: 'thinking',
                    thinking: 'reasoning across the wrapper',
                    signature: 'sig-x',
                  },
                ],
              },
            },
          },
        },
      }),
    ).toEqual({
      kind: 'thinking',
      seq: 2,
      ts: 2000,
      text: 'reasoning across the wrapper',
    })
  })

  it('assistant with .raw wrapper, content[0].type=tool_use → tool-use', () => {
    expect(
      toRendered({
        id: 3,
        event: 'assistant',
        data: {
          seq: 3,
          ts: 3000,
          type: 'assistant',
          data: {
            text: '',
            raw: {
              type: 'assistant',
              message: {
                content: [
                  {
                    type: 'tool_use',
                    id: 'call_x',
                    name: 'Read',
                    input: { file_path: '/repo/file.ts' },
                  },
                ],
              },
            },
          },
        },
      }),
    ).toEqual({
      kind: 'tool-use',
      seq: 3,
      ts: 3000,
      name: 'Read',
      toolUseId: 'call_x',
      summary: '/repo/file.ts',
      fullInput: { file_path: '/repo/file.ts' },
    })
  })

  it('user with .raw wrapper, content[0].type=tool_result → tool-result', () => {
    expect(
      toRendered({
        id: 4,
        event: 'user',
        data: {
          seq: 4,
          ts: 4000,
          type: 'user',
          data: {
            text: '',
            raw: {
              type: 'user',
              message: {
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'call_x',
                    content: 'OK\nok',
                    is_error: false,
                  },
                ],
              },
            },
          },
        },
      }),
    ).toMatchObject({
      kind: 'tool-result',
      toolUseId: 'call_x',
      isError: false,
      fullContent: 'OK\nok',
      summary: 'OK (5 chars)',
    })
  })

  it('user with .raw wrapper, content[0].type=text → user', () => {
    expect(
      toRendered({
        id: 5,
        event: 'user',
        data: {
          seq: 5,
          ts: 5000,
          type: 'user',
          data: {
            text: '',
            raw: {
              type: 'user',
              message: { content: [{ type: 'text', text: 'hello' }] },
              cwd: '/repo',
              agent: 'claude-code',
            },
          },
        },
      }),
    ).toEqual({
      kind: 'user',
      seq: 5,
      ts: 5000,
      text: 'hello',
      cwd: '/repo',
      agent: 'claude-code',
    })
  })
})
