// @vitest-environment happy-dom
import { render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { SubagentDetailBody } from './SubagentDetailBody.js'
import { useAgentStore } from '../../store/useAgentStore.js'

afterEach(() => {
  useAgentStore.setState({
    subagentTasksBySession: {},
    agentTasksBySession: {},
    bashTasksBySession: {},
  })
})

/**
 * dsh-024 回归:SSE 'subagent.changed' 推到 store 后,SubagentDetailBody
 * 必须感知 status 变化并自动重新 fetch — 否则用户在抽屉打开期间
 * 子 agent 完成时,抽屉正文仍停留在 initial fetch 的空 result,
 * 必须刷新页面才能看到 Agent 的最终回复(用户报告的两个问题之一)。
 *
 * 设计要点:
 *   - 测试不依赖真实 sleep / setTimeout — 用 mock fetch 的解析时机
 *     + rerender 模拟"running 期间挂载 → done 时再次 fetch"。
 *   - 不测 polling / 中断路径 — 只测 status 变化触发 refetch。
 */
describe('SubagentDetailBody — 自动响应 status 变化 (dsh-024)', () => {
  test('SSE 推送 status=done 时自动重新 fetch,展示 Agent result', async () => {
    const initialBody = {
      taskId: 'dsh-task-1',
      sessionId: 'sess-1',
      status: 'running',
      prompt: '请总结当前目录',
      startedAt: 1_000,
    }
    const finalBody = {
      ...initialBody,
      status: 'done',
      finishedAt: 2_000,
      result: '当前目录包含 12 个文件。',
      toolCalls: [
        {
          callId: 'tc-1',
          toolName: 'bash',
          input: { command: 'ls' },
          output: 'a.txt\nb.txt',
          status: 'done',
          ts: 1_500,
        },
      ],
    }
    const fetchMock = vi
      .fn<[string], Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(initialBody), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(finalBody), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    try {
      // 初始:store 已有 running entry(模拟 SSE start 已推过)
      useAgentStore.setState({
        subagentTasksBySession: {
          'session-1': [{ id: 'dsh-task-1', status: 'running' }],
        },
      })

      const { container } = render(<SubagentDetailBody taskId="dsh-task-1" />)

      // 第一次 fetch — 拿到 running 状态,无 result
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1)
      })
      expect(container.textContent).not.toContain('当前目录包含 12 个文件')

      // 模拟 SSE 'subagent.changed' action='finish' → store status 更新
      useAgentStore.getState().applySubagentChanged({
        sessionId: 'session-1',
        taskId: 'dsh-task-1',
        status: 'done',
        description: '',
        action: 'finish',
      } as never)

      // 触发 rerender 后,组件应通过 store 订阅感知 status=done 并 refetch
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2)
      })
      // 最终响应里 result 字段应渲染出来
      await waitFor(() => {
        expect(container.textContent).toContain('当前目录包含 12 个文件')
      })
      // toolCalls 也应渲染
      expect(container.textContent).toContain('bash')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('reloadSignal 递增触发重新 fetch (沿用旧契约)', async () => {
    const fetchMock = vi
      .fn<[string], Promise<Response>>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            taskId: 'dsh-task-2',
            sessionId: 'sess-2',
            status: 'running',
            prompt: 'noop',
            startedAt: 0,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    try {
      const { rerender } = render(
        <SubagentDetailBody taskId="dsh-task-2" reloadSignal={0} />,
      )
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1)
      })
      // 递增 reloadSignal → 重 fetch
      rerender(<SubagentDetailBody taskId="dsh-task-2" reloadSignal={1} />)
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2)
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
