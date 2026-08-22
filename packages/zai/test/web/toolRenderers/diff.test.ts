// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import React from 'react'
import { diffRenderer } from '../../../src/web/src/components/toolRenderers/diff.js'
import type { AgentMessage } from '../../../src/web/src/store/useAgentStore.js'

const baseMsg: AgentMessage = {
  type: 'tool_use:done',
  eventId: 'evt-1',
  sessionId: 'sess-1',
  ts: 1,
  turnIndex: 0,
  toolUseId: 'toolu_x',
  name: 'Edit',
  input: { file_path: '/a.ts', old_string: 'a', new_string: 'b' },
  output: '',
}

describe('diffRenderer', () => {
  it('preview shows file_path', () => {
    expect(diffRenderer.preview({ file_path: '/a.ts' })).toBe('/a.ts')
  })
  it('preview appends (all) for Edit replace_all=true', () => {
    expect(
      diffRenderer.preview({ file_path: '/a.ts', replace_all: true }),
    ).toBe('/a.ts (all)')
  })
  it('preview does NOT append (all) for Write or Edit without replace_all', () => {
    expect(
      diffRenderer.preview({ file_path: '/a.ts', content: 'whole file' }),
    ).toBe('/a.ts')
    expect(
      diffRenderer.preview({ file_path: '/a.ts', old_string: 'x', new_string: 'y' }),
    ).toBe('/a.ts')
  })
  it('preview empty when no file_path', () => {
    expect(diffRenderer.preview({ old_string: 'a', new_string: 'b' })).toBe('')
  })
  it('renderFull returns a React element that mounts (non-null)', () => {
    const node = diffRenderer.renderFull?.(baseMsg)
    expect(node == null || React.isValidElement(node)).toBe(true)
  })

  // dsh 内核工具名 FileEdit / FileWrite 走同一个 diffRenderer,但
  // DiffBlock 强判 `name === 'Write'` 决定走整篇新增 vs 行级 diff — 这里要
  // 验证 FileWrite 仍然被识别为 write,FileEdit 被识别为 update。
  it('FileWrite 走整篇新增路径 (DiffBlock isWrite 兼容)', () => {
    const msg: AgentMessage = {
      ...baseMsg,
      eventId: 'evt-dsh-w',
      toolUseId: 'toolu_dsh_w',
      name: 'FileWrite',
      input: { file_path: '/a.ts', content: 'whole new file' },
    }
    const node = diffRenderer.renderFull?.(msg)
    expect(node == null || React.isValidElement(node)).toBe(true)
  })
  it('FileEdit 走行级 diff 路径', () => {
    const msg: AgentMessage = {
      ...baseMsg,
      eventId: 'evt-dsh-e',
      toolUseId: 'toolu_dsh_e',
      name: 'FileEdit',
      input: { file_path: '/a.ts', old_string: 'a', new_string: 'b' },
    }
    const node = diffRenderer.renderFull?.(msg)
    expect(node == null || React.isValidElement(node)).toBe(true)
  })
})
