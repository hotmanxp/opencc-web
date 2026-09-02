// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import SuperTaskDetailDrawer from './SuperTaskDetailDrawer'

describe('SuperTaskDetailDrawer', () => {
  it('渲染任务详情 tabs + 把 SSE 帧按 kind 分支渲染到 Timeline', async () => {
    // 回归:旧实现本地 EventFrame.seq 与运行时 SseFrame.id 不一致,Timeline key 恒为
    // "undefined" → React 双键告警。本测试改用 processEventRenderer 真实分支 →
    // system 帧被翻译为 `<code>[init]</code>`,无 same key 告警,Timeline 两行都对。
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/events')) {
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
                  frame(1, 'system', {
                    seq: 1,
                    ts: 1,
                    type: 'system',
                    data: { subtype: 'init' },
                  }),
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
      return {
        ok: true,
        json: async () => ({
          task: {
            summary: { id: 'tf-x', title: 'T', status: 'processing', bucket: 'processing-tasks', executorTaskId: 'a1234567' },
            indexMd: 'body', specMd: '# spec', planMd: '# plan', processMd: '# 执行记录\n## [DONE]',
          },
        }),
      }
    }))
    render(<SuperTaskDetailDrawer taskId="tf-x" onClose={() => {}} />)
    expect(await screen.findByText('执行过程')).toBeTruthy()
    expect(await screen.findByText('process.md')).toBeTruthy()
    expect(screen.getAllByText('[init]').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('[compact_boundary]').length).toBeGreaterThanOrEqual(1)
    expect(document.querySelectorAll('.ant-timeline-item').length).toBe(2)
    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining('same key'))
    errSpy.mockRestore()
  })
})
