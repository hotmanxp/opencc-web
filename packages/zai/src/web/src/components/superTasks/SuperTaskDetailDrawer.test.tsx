// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import SuperTaskDetailDrawer from './SuperTaskDetailDrawer'

/** 构造 /api/super-tasks/:id 的 TaskDetails mock。 */
function taskDetailsMock(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    json: async () => ({
      task: {
        summary: {
          id: 'tf-x', title: 'T', status: 'processing', bucket: 'processing-tasks',
          executorTaskId: 'a1234567', verifierTaskId: null,
        },
        specMd: '# spec', planMd: '# plan', processMd: '# 执行记录\n## [DONE]',
        verificationMd: '',
        ...over,
      },
    }),
  }
}

function eventsStreamMock(): { ok: boolean; body: ReadableStream<Uint8Array> } {
  const frame = (
    seq: number,
    event: string,
    data: Record<string, unknown>,
  ): string =>
    `id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  return {
    ok: true,
    body: new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            frame(1, 'system', { seq: 1, ts: 1, type: 'system', data: { subtype: 'init' } }),
          ),
        )
        c.enqueue(
          new TextEncoder().encode(
            frame(2, 'system', {
              seq: 2,
              ts: 2,
              type: 'system',
              data: { subtype: 'compact_boundary' },
            }),
          ),
        )
        c.close()
      },
    }),
  }
}

describe('SuperTaskDetailDrawer', () => {
  it('渲染任务详情 tabs + 把 SSE 帧按 kind 分支渲染到 Timeline', async () => {
    // 回归:旧实现本地 EventFrame.seq 与运行时 SseFrame.id 不一致,Timeline key 恒为
    // "undefined" → React 双键告警。本测试改用 processEventRenderer 真实分支 →
    // system 帧被翻译为 `<code>[init]</code>`,无 same key 告警,Timeline 两行都对。
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/events')) return eventsStreamMock()
      return taskDetailsMock()
    }))
    render(<SuperTaskDetailDrawer taskId="tf-x" onClose={() => {}} />)
    expect(await screen.findByText('执行过程')).toBeTruthy()
    expect(await screen.findByText('process.md')).toBeTruthy()
    expect(await screen.findByText('验证记录')).toBeTruthy()
    expect(screen.getAllByText('[init]').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('[compact_boundary]').length).toBeGreaterThanOrEqual(1)
    expect(document.querySelectorAll('.ant-timeline-item').length).toBe(2)
    // processing 桶 → 事件流来源是执行 Agent
    expect(await screen.findByText(/当前事件流来源:执行 Agent/)).toBeTruthy()
    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining('same key'))
    errSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  it('verifying 桶 + verifierTaskId → 事件流切到验证 Agent,并渲染 verification.md', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/events')) return eventsStreamMock()
      return taskDetailsMock({
        summary: {
          id: 'tf-x', title: 'T', status: 'verifying', bucket: 'verifying-tasks',
          executorTaskId: 'a1234567', verifierTaskId: 'vrf-7654321',
        },
        verificationMd: '# 验证记录\n\n## 轮次 1\n\n结论: PASS',
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SuperTaskDetailDrawer taskId="tf-x" onClose={() => {}} />)
    // 事件流订阅打到 verifier task id(vrf-7654321),而不是 executor
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(urls.some((u) => u.includes('/events') && u.includes('vrf-7654321'))).toBe(true)
    })
    expect(await screen.findByText(/当前事件流来源:验证 Agent\(verifier\)/)).toBeTruthy()
    // 验证记录 Tab 懒渲染:点击切过去再断言内容
    fireEvent.click(await screen.findByText('验证记录'))
    expect(await screen.findByText('结论: PASS')).toBeTruthy()
    vi.unstubAllGlobals()
  })

  it('brainstorm.md tab(2026-09-03):有纪要时渲染内容', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/events')) return eventsStreamMock()
      return taskDetailsMock({ brainstormMd: '# 讨论纪要\n\n用户确认目标为导出 CSV。' })
    }))
    render(<SuperTaskDetailDrawer taskId="tf-x" onClose={() => {}} />)
    fireEvent.click(await screen.findByText('brainstorm.md'))
    expect(await screen.findByText('用户确认目标为导出 CSV。')).toBeTruthy()
    vi.unstubAllGlobals()
  })

  it('brainstorm.md tab(2026-09-03):无纪要时显示占位', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/events')) return eventsStreamMock()
      return taskDetailsMock({ brainstormMd: '' })
    }))
    render(<SuperTaskDetailDrawer taskId="tf-x" onClose={() => {}} />)
    fireEvent.click(await screen.findByText('brainstorm.md'))
    expect(await screen.findByText('尚无讨论纪要')).toBeTruthy()
    vi.unstubAllGlobals()
  })
})
