// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import SuperTaskDetailDrawer from './SuperTaskDetailDrawer'

describe('SuperTaskDetailDrawer', () => {
  it('渲染任务详情 tabs + 执行事件流 Timeline（两帧无重复 key）', async () => {
    // 回归:旧实现本地 EventFrame.seq 与运行时 SseFrame.id 不一致,Timeline key 恒为
    // "undefined" → React 双键告警。这里断言无 "same key" 告警 + 两帧都渲染。
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/events')) {
        return {
          ok: true,
          body: new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('id: 1\nevent: x\ndata: {"description":"step one"}\n\n'))
              c.enqueue(new TextEncoder().encode('id: 2\nevent: x\ndata: {"description":"step two"}\n\n'))
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
    expect(await screen.findByText('x · step one')).toBeTruthy()
    expect(screen.getByText('x · step two')).toBeTruthy()
    expect(document.querySelectorAll('.ant-timeline-item').length).toBe(2)
    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining('same key'))
    errSpy.mockRestore()
  })
})