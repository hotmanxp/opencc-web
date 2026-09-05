// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import SuperTaskDetailDrawer from './SuperTaskDetailDrawer'
import { useAppStore } from '../../store/useAppStore'

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

  // zai patch (2026-09-04, quick-intake):quick 模式顶部横幅 + Tab 过滤。
  it('mode="quick" 时顶部显示「无 plan.md / brainstorm.md」横幅,且不显示 brainstorm.md / plan.md Tab', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/events')) return eventsStreamMock()
      return taskDetailsMock({ summary: { id: 'tf-quick', title: 'T', status: 'processing', bucket: 'processing-tasks', mode: 'quick', executorTaskId: 'a1', verifierTaskId: null } })
    }))
    render(<SuperTaskDetailDrawer taskId="tf-quick" onClose={() => {}} />)
    // 横幅出现
    expect(await screen.findByTestId('quick-mode-banner')).toBeTruthy()
    expect(await screen.findByText(/本任务为快速创建,无 plan\.md \/ brainstorm\.md/)).toBeTruthy()
    // brainstorm.md / plan.md Tab 不存在(只剩 process / verification / spec / processMd)
    expect(screen.queryByText('brainstorm.md')).toBeNull()
    expect(screen.queryByText('plan.md')).toBeNull()
    // process.md / spec.md / 验证记录 仍在
    expect(screen.getByText('process.md')).toBeTruthy()
    expect(screen.getByText('spec.md')).toBeTruthy()
    expect(screen.getByText('验证记录')).toBeTruthy()
    vi.unstubAllGlobals()
  })

  it('mode="full" 或缺省时显示完整 Tab 列表(含 brainstorm.md / plan.md)', async () => {
    const cases: Array<{ name: string; mode?: 'quick' | 'full' }> = [
      { name: 'full 显式', mode: 'full' },
      { name: 'mode 缺省', mode: undefined },
    ]
    for (const c of cases) {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (String(url).endsWith('/events')) return eventsStreamMock()
        const summary: Record<string, unknown> = {
          id: 'tf-x', title: 'T', status: 'processing', bucket: 'processing-tasks',
          executorTaskId: 'a1', verifierTaskId: null,
        }
        if (c.mode) summary.mode = c.mode
        return taskDetailsMock({ summary })
      }))
      const { unmount } = render(<SuperTaskDetailDrawer taskId="tf-x" onClose={() => {}} />)
      expect(await screen.findByText('brainstorm.md')).toBeTruthy()
      expect(screen.getByText('plan.md')).toBeTruthy()
      expect(screen.queryByTestId('quick-mode-banner')).toBeNull()
      vi.unstubAllGlobals()
      unmount()
    }
  })

  // 2026-09-05(tf-ocgwe3ej):移动端详情抽屉之前用 width=720 默认 right 抽屉,
  // 在 375–430px 视口下整个抽屉溢出可视区,事件流 Timeline / Tabs 全部
  // 渲染到屏幕外 → 用户感觉「看不到事件」。修复:useAppStore.isMobile=true
  // 时切到 placement="bottom" + height="90%" 的底部抽屉(对齐
  // MobileSupervisorDrawer 同款模式)。桌面 isMobile=false 仍走 width=720
  // 默认 right 抽屉(原行为,零回归)。
  it('isMobile=true → 抽屉走 placement="bottom" + height="90%"(data-testid=mobile-detail-drawer)', async () => {
    useAppStore.setState({ isMobile: true })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/events')) return eventsStreamMock()
      return taskDetailsMock()
    }))
    try {
      const { container } = render(<SuperTaskDetailDrawer taskId="tf-x" onClose={() => {}} />)
      // data-testid 标记走 mobile 分支
      const drawer = await screen.findByTestId('mobile-detail-drawer')
      expect(drawer).toBeTruthy()
      // AntD Drawer 走 portal:wrapper 实际挂到 document.body,这里 container
      // 找不到 drawer 根。改查全局 .ant-drawer-bottom —— 只有走 bottom
      // placement 时 AntD 才挂这个 className。
      const bottomDrawers = document.querySelectorAll('.ant-drawer-bottom')
      expect(bottomDrawers.length).toBeGreaterThanOrEqual(1)
      // 事件流仍然渲染 —— 这是用户感知「能看到事件」的最小可信证据
      expect(await screen.findByText('[init]')).toBeTruthy()
    } finally {
      useAppStore.setState({ isMobile: false })
      vi.unstubAllGlobals()
    }
  })

  it('isMobile=false → 抽屉走 width=720 默认 right 抽屉(data-testid=desktop-detail-drawer)', async () => {
    // 默认 isMobile=false,这里显式重置以防其它用例污染
    useAppStore.setState({ isMobile: false })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/events')) return eventsStreamMock()
      return taskDetailsMock()
    }))
    render(<SuperTaskDetailDrawer taskId="tf-x" onClose={() => {}} />)
    const drawer = await screen.findByTestId('desktop-detail-drawer')
    expect(drawer).toBeTruthy()
    // 桌面不应出现 mobile 分支的 .ant-drawer-bottom
    expect(document.querySelector('.ant-drawer-bottom')).toBeNull()
    // 桌面应出现默认 right drawer
    expect(document.querySelector('.ant-drawer')).toBeTruthy()
    vi.unstubAllGlobals()
  })

  // 2026-09-05 (tf-hq086lfy):移动端窄屏旧版 maxHeight=calc(100vh-240px) 把
  // Timeline wrapper 高度压成 ~0px、fallback 「等待执行事件...」单行小灰字
  // 看不见;且 Timeline 内的 [init] / 工具调用等事件帧被压到 drawer 滚出可视区。
  // 修复:mobile drawer body 走 flex 列向布局 + Timeline wrapper flex:1 +
  // Empty 组件占位 + Tab label 上挂事件计数 badge,让「事件流已开/已收到」
  // 信号在窄屏也不会被布局吃掉。
  it('isMobile=true + 有事件 → Tab label 出现事件计数 badge', async () => {
    useAppStore.setState({ isMobile: true })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/events')) return eventsStreamMock()
      return taskDetailsMock()
    }))
    try {
      render(<SuperTaskDetailDrawer taskId="tf-x" onClose={() => {}} />)
      // eventsStreamMock 推 2 帧,tab badge 应渲染 "2"
      const badge = await screen.findByTestId('process-event-count')
      expect(badge.textContent).toBe('2')
    } finally {
      useAppStore.setState({ isMobile: false })
      vi.unstubAllGlobals()
    }
  })

  it('isMobile=true + 无事件 → Empty 组件占位(data-testid=process-empty-state)', async () => {
    useAppStore.setState({ isMobile: true })
    // SSE 流只 close,不推任何帧 → rendered.length === 0
    const emptyStreamMock = (): { ok: boolean; body: ReadableStream<Uint8Array> } => ({
      ok: true,
      body: new ReadableStream({ start(c) { c.close() } }),
    })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/events')) return emptyStreamMock()
      return taskDetailsMock()
    }))
    try {
      render(<SuperTaskDetailDrawer taskId="tf-x" onClose={() => {}} />)
      // Empty 节点存在 —— 这是用户感知「事件流是开的,只是还没收到」
      // 的最小可信证据(旧版是裸 Typography.Text,窄屏会被压扁不可见)。
      const empty = await screen.findByTestId('process-empty-state')
      expect(empty).toBeTruthy()
      expect(empty.textContent).toContain('等待执行事件')
      // tab badge 此时不应出现
      expect(screen.queryByTestId('process-event-count')).toBeNull()
    } finally {
      useAppStore.setState({ isMobile: false })
      vi.unstubAllGlobals()
    }
  })

  it('isMobile=true + 有事件 → Timeline wrapper 走 flex:1 + overflowY:auto(data-testid=process-timeline-scroll)', async () => {
    useAppStore.setState({ isMobile: true })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/events')) return eventsStreamMock()
      return taskDetailsMock()
    }))
    try {
      render(<SuperTaskDetailDrawer taskId="tf-x" onClose={() => {}} />)
      const wrap = await screen.findByTestId('process-timeline-scroll')
      // mobile 分支显式声明 overflowY=auto + flex:1(不是桌面端 maxHeight=calc(...))
      const cs = window.getComputedStyle(wrap)
      expect(cs.overflowY).toBe('auto')
    } finally {
      useAppStore.setState({ isMobile: false })
      vi.unstubAllGlobals()
    }
  })

  // desktop 零回归:旧 maxHeight 路径保留
  it('isMobile=false + 有事件 → Timeline wrapper 走 maxHeight=calc(100vh - 310px)(零回归)', async () => {
    useAppStore.setState({ isMobile: false })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/events')) return eventsStreamMock()
      return taskDetailsMock()
    }))
    try {
      render(<SuperTaskDetailDrawer taskId="tf-x" onClose={() => {}} />)
      const wrap = await screen.findByTestId('process-timeline-scroll')
      const cs = window.getComputedStyle(wrap)
      // desktop 端仍是 inline style maxHeight:calc(100vh - 310px) + overflow:auto,
      // jsdom getComputedStyle 返回 inline style 直接值。
      expect(wrap.getAttribute('style') ?? '').toMatch(/max-height:\s*calc\(100vh\s*-\s*310px\)/)
      expect(cs.overflow).toMatch(/auto/)
      // tab badge 仍渲染事件计数
      expect((await screen.findByTestId('process-event-count')).textContent).toBe('2')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
