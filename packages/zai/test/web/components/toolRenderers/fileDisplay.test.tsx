// @vitest-environment happy-dom
import '@testing-library/jest-dom'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import React from 'react'
import { fileDisplayRenderer } from '../../../../src/web/src/components/toolRenderers/fileDisplay.js'
import { useAgentStore } from '../../../../src/web/src/store/useAgentStore.js'

function makeMsg(files: any[]) {
  // wire shape: displayFilesTool 输出的是 JSON 字符串 — 包了 Anthropic 风格
  // content block { content: [{ type: 'json', json: { files } }] }. 浏览器侧的
  // useAgentStore 把它存到 msg.output (字符串). 这跟 Anthropic tool_result 的
  // array 形态不一样, 见 fileDisplay.tsx parseFiles 的适配注释.
  return {
    type: 'tool_use:done' as const,
    toolUseId: 'tu-1',
    name: 'DisplayFiles',
    input: { paths: files.map((f) => f.path) },
    output: JSON.stringify({
      content: [{ type: 'json', json: { files } }],
    }),
  } as any
}

describe('fileDisplayRenderer.renderFull', () => {
  beforeEach(() => {
    useAgentStore.setState({
      filePreviewPath: null,
      openFilePreview: (p) => useAgentStore.setState({ filePreviewPath: p }),
      closeFilePreview: () => useAgentStore.setState({ filePreviewPath: null }),
    })
  })

  it('renders one card per file', () => {
    const msg = makeMsg([
      { path: '/a.ts', name: 'a.ts', size: 100, mtime: 0, kind: 'text' },
      { path: '/b.png', name: 'b.png', size: 200, mtime: 0, kind: 'image' },
    ])
    const { container } = render(<>{fileDisplayRenderer.renderFull!(msg)}</>)
    expect(container.textContent).toContain('a.ts')
    expect(container.textContent).toContain('b.png')
  })

  it('shows error tag for files with error', () => {
    const msg = makeMsg([
      { path: '/nope.txt', name: 'nope.txt', size: 0, mtime: 0, kind: 'binary',
        error: { code: 'ENOENT', message: 'not found' } },
    ])
    const { container } = render(<>{fileDisplayRenderer.renderFull!(msg)}</>)
    expect(container.textContent).toContain('文件不存在')
  })

  it('disables preview button for files > 1 MiB', () => {
    const msg = makeMsg([
      { path: '/big.ts', name: 'big.ts', size: 2 * 1024 * 1024, mtime: 0, kind: 'text' },
    ])
    render(<>{fileDisplayRenderer.renderFull!(msg)}</>)
    const previewBtn = screen.getByRole('button', { name: /预览/ })
    expect(previewBtn).toBeDisabled()
  })

  it('calls openFilePreview on preview click', () => {
    const msg = makeMsg([
      { path: '/a.ts', name: 'a.ts', size: 100, mtime: 0, kind: 'text' },
    ])
    render(<>{fileDisplayRenderer.renderFull!(msg)}</>)
    fireEvent.click(screen.getByRole('button', { name: /预览/ }))
    expect(useAgentStore.getState().filePreviewPath).toBe('/a.ts')
  })

  it('calls /api/fs/reveal on open-folder click', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response())
    const msg = makeMsg([
      { path: '/a.ts', name: 'a.ts', size: 100, mtime: 0, kind: 'text' },
    ])
    render(<>{fileDisplayRenderer.renderFull!(msg)}</>)
    fireEvent.click(screen.getByRole('button', { name: /打开目录/ }))
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/fs/reveal',
      expect.objectContaining({ method: 'POST' }),
    )
    fetchSpy.mockRestore()
  })
})

describe('fileDisplayRenderer.preview', () => {
  it('returns "展示 N 个文件" summary', () => {
    expect(fileDisplayRenderer.preview({ paths: ['/a', '/b', '/c'] } as any)).toBe('展示 3 个文件')
  })
})

describe('fileDisplayRenderer.skipOuterGroup', () => {
  it('标记为 true 让 compact 视图跳过 ToolGroupCard 外壳', () => {
    // MessageListView.tsx:shouldSkipOuterGroup 依赖此标记把 DisplayFiles
    // 直接路由到 MessageBubble, 与 expanded 视图视觉一致.
    expect(fileDisplayRenderer.skipOuterGroup).toBe(true)
  })
})