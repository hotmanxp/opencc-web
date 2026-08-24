// @vitest-environment happy-dom
import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SubagentDetailBody } from '../../../../src/web/src/components/splitPane/SubagentDetailBody.js'
import { useAgentStore } from '../../../../src/web/src/store/useAgentStore.js'

afterEach(() => {
  useAgentStore.setState({
    subagentTasksBySession: {},
    agentTasksBySession: {},
    bashTasksBySession: {},
  })
  vi.unstubAllGlobals()
})

/**
 * Task 15: SubagentDetailBody 新增 ContentBlockRenderer(5 种 type 渲染).
 *
 * 实施范围对齐仓库现实:
 *  - 走 disk-backed 模式:ContentBlockRenderer 直接接 `blocks: SubagentContentBlock[]`,
 *    测试 mock fetch 返回 `{ blocks }` 直接验证 ContentBlockRenderer 行为。
 *  - Tool use/result 通过 detail.blocks 渲染,绕过原 toolCalls Collapse 路径。
 *    原 Collapse-only 视图在 toolCalls 为空 / 未提供时仍按 detail.toolCalls 渲染,
 *    不破坏 dsh-024 自动 refetch 回归。
 *
 * 见 packages/zai/src/shared/subagentEvents.ts:23 SubagentContentBlockSchema
 * 与 packages/dsh-bridge/src/subagent/contentBlock.ts:11 (vendor mirror).
 */
describe('SubagentDetailBody ContentBlock 渲染 (Task 15)', () => {
  function mockFetchWithBlocks(blocks: unknown[]) {
    const fetchMock = vi
      .fn<[string], Promise<Response>>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            taskId: 'r1',
            sessionId: 'sess-1',
            status: 'done',
            prompt: 'noop',
            startedAt: 1_000,
            finishedAt: 2_000,
            blocks,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('renders thinking block', async () => {
    mockFetchWithBlocks([{ type: 'thinking', thinking: 'reasoning...' }])
    const { container } = render(<SubagentDetailBody taskId="r1" />)
    await vi.waitFor(() => {
      expect(container.textContent).toContain('reasoning...')
    })
  })

  it('renders text block via markdown', async () => {
    mockFetchWithBlocks([{ type: 'text', text: '**hello**' }])
    const { container } = render(<SubagentDetailBody taskId="r1" />)
    await vi.waitFor(() => {
      // MarkdownText 把 **hello** 渲染为 <strong>hello</strong>
      expect(container.querySelector('strong')?.textContent).toBe('hello')
    })
  })

  it('renders tool_use block', async () => {
    mockFetchWithBlocks([
      { type: 'tool_use', id: 'a', name: 'Read', input: { path: '/x' } },
    ])
    const { container } = render(<SubagentDetailBody taskId="r1" />)
    await vi.waitFor(() => {
      expect(container.textContent).toMatch(/Read/)
    })
  })

  it('renders tool_result block', async () => {
    mockFetchWithBlocks([
      { type: 'tool_result', tool_use_id: 'a', content: 'output' },
    ])
    const { container } = render(<SubagentDetailBody taskId="r1" />)
    await vi.waitFor(() => {
      expect(container.textContent).toContain('output')
    })
  })

  it('renders image block via img tag', async () => {
    mockFetchWithBlocks([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: '...' },
      },
    ])
    const { container } = render(<SubagentDetailBody taskId="r1" />)
    await vi.waitFor(() => {
      const img = container.querySelector('img')
      expect(img).toBeTruthy()
      expect(img?.getAttribute('src')).toContain('data:image/png;base64,...')
    })
  })

  it('unknown type renders as pre with JSON', async () => {
    // @ts-expect-error 测试未知 type — ContentBlockRenderer 必须降级
    const blocks = [{ type: 'bogus', x: 1 }]
    mockFetchWithBlocks(blocks)
    const { container } = render(<SubagentDetailBody taskId="r1" />)
    await vi.waitFor(() => {
      // 降级 pre 里的 JSON 应包含原 type 字符串
      expect(container.textContent).toMatch(/"type":\s*"bogus"/)
    })
  })
})
