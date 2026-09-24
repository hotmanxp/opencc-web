import { describe, expect, it } from 'vitest'
import type { AgentMessage, AgentStatus } from '../../../src/web/src/store/useAgentStore.js'
import {
  ARTIFACT_WRITE_TOOLS,
  deriveTurnArtifacts,
} from '../../../src/web/src/components/transcript/deriveTurnArtifacts.js'

// Lightweight factory — only fields the derivation reads.
function userMsg(eventId: string, text: string): AgentMessage {
  return { type: 'user.text', text, eventId, sessionId: 's1', ts: 1, turnIndex: 0 } as AgentMessage
}

function toolMsg(
  type: string,
  name: string,
  input: Record<string, unknown>,
): AgentMessage {
  return {
    type,
    name,
    input,
    eventId: `evt-${name}-${type}-${JSON.stringify(input)}`,
    sessionId: 's1',
    ts: 1,
    turnIndex: 0,
  } as unknown as AgentMessage
}

function assistantMsg(eventId: string, text: string): AgentMessage {
  return { type: 'assistant.text', text, eventId, sessionId: 's1', ts: 1, turnIndex: 0 } as AgentMessage
}

const idle: AgentStatus = 'idle'

describe('deriveTurnArtifacts — 轮次切分', () => {
  it('无 user.text 时返回空数组', () => {
    const msgs = [assistantMsg('a1', 'hi'), toolMsg('tool_use:start', 'Write', { file_path: '/tmp/a.ts' })]
    expect(deriveTurnArtifacts(msgs, { status: idle })).toEqual([])
  })

  it('单轮:锚点 = 该轮最后一条消息的下标', () => {
    const msgs = [
      userMsg('u1', 'go'),
      toolMsg('tool_use:start', 'Write', { file_path: '/tmp/a.ts' }),
      assistantMsg('a1', 'done'),
    ]
    const out = deriveTurnArtifacts(msgs, { status: idle })
    expect(out).toHaveLength(1)
    expect(out[0]!.endIndex).toBe(2)
    expect(out[0]!.turnKey).toBe('u1')
  })

  it('多轮:每轮各自的锚点与 turnKey', () => {
    const msgs = [
      userMsg('u1', 'first'),
      toolMsg('tool_use:start', 'Write', { file_path: '/tmp/a.ts' }),
      assistantMsg('a1', 'done1'),
      userMsg('u2', 'second'),
      toolMsg('tool_use:start', 'Edit', { file_path: '/tmp/b.ts' }),
      assistantMsg('a2', 'done2'),
    ]
    const out = deriveTurnArtifacts(msgs, { status: idle })
    expect(out.map((t) => [t.endIndex, t.turnKey])).toEqual([[2, 'u1'], [5, 'u2']])
    expect(out[0]!.files.map((f) => f.path)).toEqual(['/tmp/a.ts'])
    expect(out[1]!.files.map((f) => f.path)).toEqual(['/tmp/b.ts'])
  })

  it('产物只含本轮文件,不跨轮累加', () => {
    const msgs = [
      userMsg('u1', 'first'),
      toolMsg('tool_use:start', 'Write', { file_path: '/tmp/a.ts' }),
      userMsg('u2', 'second'),
      toolMsg('tool_use:start', 'Edit', { file_path: '/tmp/b.ts' }),
    ]
    const out = deriveTurnArtifacts(msgs, { status: idle })
    expect(out[1]!.files.map((f) => f.path)).toEqual(['/tmp/b.ts'])
  })

  it('数组被裁剪后不以 user.text 开头时,开头那段残留消息不产出', () => {
    // 对应 spec §3.5:AgentConversation 按 maxVisibleMessages 裁剪后,
    // 老轮次的锚点可能整个落到可视区之外 —— 被切掉头部的残段没有 user.text
    // 作为起点,不构成一轮,自然不渲染产物块。
    const msgs = [
      toolMsg('tool_use:start', 'Write', { file_path: '/tmp/a.ts' }),
      assistantMsg('a1', 'done'),
      userMsg('u2', 'second'),
      toolMsg('tool_use:start', 'Edit', { file_path: '/tmp/b.ts' }),
    ]
    const out = deriveTurnArtifacts(msgs, { status: idle })
    expect(out).toHaveLength(1)
    expect(out[0]!.files.map((f) => f.path)).toEqual(['/tmp/b.ts'])
  })
})

describe('deriveTurnArtifacts — 结算时机', () => {
  it('最后一轮处于 streaming 时不产出', () => {
    const msgs = [
      userMsg('u1', 'go'),
      toolMsg('tool_use:start', 'Write', { file_path: '/tmp/a.ts' }),
    ]
    expect(deriveTurnArtifacts(msgs, { status: 'streaming' })).toEqual([])
  })

  it('被下一轮顶掉的轮次即使仍在 streaming 也产出', () => {
    const msgs = [
      userMsg('u1', 'first'),
      toolMsg('tool_use:start', 'Write', { file_path: '/tmp/a.ts' }),
      userMsg('u2', 'second'),
    ]
    const out = deriveTurnArtifacts(msgs, { status: 'streaming' })
    expect(out).toHaveLength(1)
    expect(out[0]!.turnKey).toBe('u1')
  })

  it('aborted / error 轮次照常产出', () => {
    const msgs = [userMsg('u1', 'go'), toolMsg('tool_use:start', 'Write', { file_path: '/tmp/a.ts' })]
    expect(deriveTurnArtifacts(msgs, { status: 'aborted' })).toHaveLength(1)
    expect(deriveTurnArtifacts(msgs, { status: 'error' })).toHaveLength(1)
  })

  it('没有文件改动的轮次不产出', () => {
    const msgs = [userMsg('u1', 'hi'), assistantMsg('a1', 'hello')]
    expect(deriveTurnArtifacts(msgs, { status: idle })).toEqual([])
  })
})

describe('deriveTurnArtifacts — 提取规则', () => {
  it('白名单只含写入类工具', () => {
    expect(Object.keys(ARTIFACT_WRITE_TOOLS).sort()).toEqual([
      'Edit',
      'MultiEdit',
      'NotebookEdit',
      'Write',
    ])
  })

  it('只读工具(Read / Grep / Glob)不计入', () => {
    const msgs = [
      userMsg('u1', 'go'),
      toolMsg('tool_use:start', 'Read', { file_path: '/tmp/a.ts' }),
      toolMsg('tool_use:start', 'Grep', { path: '/tmp' }),
      toolMsg('tool_use:start', 'Glob', { path: 'src/**/*.ts' }),
      assistantMsg('a1', 'done'),
    ]
    expect(deriveTurnArtifacts(msgs, { status: idle })).toEqual([])
  })

  it('NotebookEdit 取 notebook_path', () => {
    const msgs = [
      userMsg('u1', 'go'),
      toolMsg('tool_use:start', 'NotebookEdit', { notebook_path: '/tmp/n.ipynb' }),
    ]
    const out = deriveTurnArtifacts(msgs, { status: idle })
    expect(out[0]!.files[0]).toMatchObject({ path: '/tmp/n.ipynb', label: '编辑', written: false })
  })

  it('tool_use:done / tool_use:error 也计入(input 仍在)', () => {
    const msgs = [
      userMsg('u1', 'go'),
      toolMsg('tool_use:done', 'Write', { file_path: '/tmp/a.ts' }),
      toolMsg('tool_use:error', 'Edit', { file_path: '/tmp/b.ts' }),
    ]
    const out = deriveTurnArtifacts(msgs, { status: idle })
    expect(out[0]!.files.map((f) => f.path)).toEqual(['/tmp/a.ts', '/tmp/b.ts'])
  })

  it('路径为空串或非字符串时跳过', () => {
    const msgs = [
      userMsg('u1', 'go'),
      toolMsg('tool_use:start', 'Write', { file_path: '' }),
      toolMsg('tool_use:start', 'Edit', { file_path: 42 }),
      toolMsg('tool_use:start', 'Write', {}),
    ]
    expect(deriveTurnArtifacts(msgs, { status: idle })).toEqual([])
  })
})

describe('deriveTurnArtifacts — 去重与徽标', () => {
  it('同一路径合并一行,保持首次出现顺序,count 累加', () => {
    const msgs = [
      userMsg('u1', 'go'),
      toolMsg('tool_use:start', 'Edit', { file_path: '/tmp/b.ts' }),
      toolMsg('tool_use:start', 'Edit', { file_path: '/tmp/a.ts' }),
      toolMsg('tool_use:start', 'Edit', { file_path: '/tmp/b.ts' }),
    ]
    const out = deriveTurnArtifacts(msgs, { status: idle })
    expect(out[0]!.files).toEqual([
      { path: '/tmp/b.ts', label: '编辑', count: 2, written: false },
      { path: '/tmp/a.ts', label: '编辑', count: 1, written: false },
    ])
  })

  it('出现过 Write 就是「写入」徽标,与出现顺序无关', () => {
    const writeFirst = [
      userMsg('u1', 'go'),
      toolMsg('tool_use:start', 'Write', { file_path: '/tmp/a.ts' }),
      toolMsg('tool_use:start', 'Edit', { file_path: '/tmp/a.ts' }),
    ]
    expect(deriveTurnArtifacts(writeFirst, { status: idle })[0]!.files[0]).toMatchObject({
      label: '写入',
      written: true,
      count: 2,
    })

    const writeLast = [
      userMsg('u1', 'go'),
      toolMsg('tool_use:start', 'Edit', { file_path: '/tmp/a.ts' }),
      toolMsg('tool_use:start', 'Write', { file_path: '/tmp/a.ts' }),
    ]
    expect(deriveTurnArtifacts(writeLast, { status: idle })[0]!.files[0]).toMatchObject({
      label: '写入',
      written: true,
      count: 2,
    })
  })

  it('路径原样保留,不做规范化(不同写法视为两个条目)', () => {
    const msgs = [
      userMsg('u1', 'go'),
      toolMsg('tool_use:start', 'Edit', { file_path: 'src/a.ts' }),
      toolMsg('tool_use:start', 'Edit', { file_path: './src/a.ts' }),
    ]
    expect(deriveTurnArtifacts(msgs, { status: idle })[0]!.files).toHaveLength(2)
  })
})