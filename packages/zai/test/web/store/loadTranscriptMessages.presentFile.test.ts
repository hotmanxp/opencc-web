// PresentFile 历史回放:output 必须从 toolUseResult.output 取,而不是占位 'done'。
//
// 背景:展示型工具把回灌给 LLM 的 tool_result content 压成 'done' 省上下文,
// 真实展示数据只在 toolUseResult.output。实时 SSE 走 takePresentFileOutput
// 旁路;刷新后的历史回放没有旁路,必须回退读 toolUseResult。
// 回归后果:presentFileRenderer.parsePresented 解析 'done' 失败,文件卡片不渲染。
import { describe, it, expect } from 'vitest'
import { loadTranscriptMessages } from '../../../src/web/src/store/useAgentStore.js'

const SID = 'sess-test-presentfile'
const TOOL_USE_ID = 'call_presentfile_001'
const PATH = '/tmp/zai-verify/before.png'

/** 磁盘 transcript 里 PresentFile 一轮的真实形态 (与真实会话逐字段对齐)。 */
function presentFileMessages() {
  return [
    {
      uuid: 'u1',
      type: 'assistant',
      timestamp: '2026-10-11T01:13:30.000Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: TOOL_USE_ID,
            name: 'PresentFile',
            input: { path: PATH, caption: '修复前' },
          },
        ],
      },
    },
    {
      uuid: 'u2',
      type: 'user',
      timestamp: '2026-10-11T01:13:32.050Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: TOOL_USE_ID, content: 'done' }],
      },
      toolUseResult: {
        output: JSON.stringify({
          content: [
            {
              type: 'json',
              json: {
                file: { path: PATH, name: 'before.png', size: 163601, mtime: 1, kind: 'image' },
                caption: '修复前',
              },
            },
          ],
        }),
      },
    },
  ]
}

/** parsePresented 的判据 (presentFile.tsx):output 能解析出 file.path 才渲染卡片。 */
function parsePresented(output: unknown): { path: string; caption?: string }[] {
  if (typeof output !== 'string') return []
  try {
    const wrapper = JSON.parse(output)
    const block = Array.isArray(wrapper?.content) ? wrapper.content[0] : null
    const json = block?.json
    if (!json?.file?.path) return []
    return [{ path: json.file.path, caption: json.caption }]
  } catch {
    return []
  }
}

describe('loadTranscriptMessages — PresentFile 历史回放', () => {
  it('content 为占位 done 时从 toolUseResult.output 恢复展示数据', () => {
    const out = loadTranscriptMessages(SID, presentFileMessages() as any)
    const entry = out.find((m: any) => m.toolUseId === TOOL_USE_ID)

    expect(entry).toBeDefined()
    expect(entry!.type).toBe('tool_use:done')
    expect(parsePresented(entry!.output)).toEqual([{ path: PATH, caption: '修复前' }])
  })

  it('保留工具入参 (input 不受 output 修复影响)', () => {
    const out = loadTranscriptMessages(SID, presentFileMessages() as any)
    const entry = out.find((m: any) => m.toolUseId === TOOL_USE_ID)

    expect(entry!.name).toBe('PresentFile')
    expect(entry!.input).toEqual({ path: PATH, caption: '修复前' })
  })

  it('content 不是占位 done 时不做任何回退', () => {
    // 常规工具的真实输出必须原样透传,哪怕 toolUseResult 另有其值。
    const messages = [
      {
        uuid: 'u1',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }],
        },
      },
      {
        uuid: 'u2',
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't2', content: 'total 0\ndone' }],
        },
        toolUseResult: { output: '{"content":[{"type":"json","json":{"file":{"path":"/nope"}}}]}' },
      },
    ]
    const out = loadTranscriptMessages(SID, messages as any)
    const entry = out.find((m: any) => m.toolUseId === 't2')

    expect(entry!.output).toBe('total 0\ndone')
  })

  it('is_error 时仍用 content 作为 error,不走回退', () => {
    const messages = [
      {
        uuid: 'u1',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't3', name: 'PresentFile', input: {} }],
        },
      },
      {
        uuid: 'u2',
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't3', content: 'done', is_error: true },
          ],
        },
        toolUseResult: { output: '{"content":[{"type":"json","json":{"file":{"path":"/x"}}}]}' },
      },
    ]
    const out = loadTranscriptMessages(SID, messages as any)
    const entry = out.find((m: any) => m.toolUseId === 't3')

    expect(entry!.type).toBe('tool_use:error')
    expect(entry!.error).toBe('done')
  })
})
