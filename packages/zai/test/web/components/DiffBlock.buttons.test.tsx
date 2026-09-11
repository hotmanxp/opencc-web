// @vitest-environment happy-dom
import '@testing-library/jest-dom'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import React from 'react'
import DiffBlock from '../../../src/web/src/components/DiffBlock.js'
import { useAgentStore } from '../../../src/web/src/store/useAgentStore.js'
import type { AgentMessage } from '../../../src/web/src/store/useAgentStore.js'

function makeMsg(type: AgentMessage['type'], name = 'Edit'): AgentMessage {
  return {
    type,
    eventId: 'evt-1',
    sessionId: 'sess-1',
    ts: 1,
    turnIndex: 0,
    toolUseId: 'toolu_x',
    name,
    input: { file_path: '/a.ts', old_string: 'a', new_string: 'b' },
    output: '',
  } as unknown as AgentMessage
}

describe('DiffBlock 预览/打开目录按钮', () => {
  beforeEach(() => {
    useAgentStore.setState({
      filePreviewPath: null,
      openFilePreview: (p: string) =>
        useAgentStore.setState({ filePreviewPath: p }),
      closeFilePreview: () => useAgentStore.setState({ filePreviewPath: null }),
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it('done 态渲染两个按钮', () => {
    render(<DiffBlock msg={makeMsg('tool_use:done')} />)
    expect(screen.getByRole('button', { name: /预览/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /打开目录/ })).toBeInTheDocument()
  })

  it('Write done 态同样渲染', () => {
    render(<DiffBlock msg={makeMsg('tool_use:done', 'Write')} />)
    expect(screen.getByRole('button', { name: /预览/ })).toBeInTheDocument()
  })

  it('start / error / denied 态不渲染按钮', () => {
    render(<DiffBlock msg={makeMsg('tool_use:start')} />)
    expect(screen.queryByRole('button', { name: /预览/ })).not.toBeInTheDocument()
    render(<DiffBlock msg={makeMsg('tool_use:error')} />)
    expect(screen.queryByRole('button', { name: /预览/ })).not.toBeInTheDocument()
    render(<DiffBlock msg={makeMsg('tool_use:denied')} />)
    expect(screen.queryByRole('button', { name: /预览/ })).not.toBeInTheDocument()
  })

  it('无 file_path 的 done 态不渲染按钮', () => {
    const msg = { ...makeMsg('tool_use:done'), input: {} } as unknown as AgentMessage
    render(<DiffBlock msg={msg} />)
    expect(screen.queryByRole('button', { name: /预览/ })).not.toBeInTheDocument()
  })

  it('点击预览调用 openFilePreview(file_path)', () => {
    render(<DiffBlock msg={makeMsg('tool_use:done')} />)
    fireEvent.click(screen.getByRole('button', { name: /预览/ }))
    expect(useAgentStore.getState().filePreviewPath).toBe('/a.ts')
  })

  it('点击打开目录 POST /api/fs/reveal', () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response())
    render(<DiffBlock msg={makeMsg('tool_use:done')} />)
    fireEvent.click(screen.getByRole('button', { name: /打开目录/ }))
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/fs/reveal',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
