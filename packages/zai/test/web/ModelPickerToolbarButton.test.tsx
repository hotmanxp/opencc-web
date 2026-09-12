// 2026-09-12: ModelPickerToolbarButton 行为测试 — 验证在没有 ConfigStatusBar
// 的场景下, AgentInputBox 状态行右端的触发按钮能正常挂载、点击展开
// ModelPickerPanel。
//
// 核心 panel 行为(搜索 / Recent / Provider 分组 / 键盘导航 / 能力徽章 /
// current 高亮 / store 路由 useAgentStoreOrCtx)已经在
// test/web/ModelStatusButton.test.tsx 完整覆盖(后者改造后同样走 ctx, 行为
// 与本 wrapper 一致), 这里只验证 wrapper 本身的触发 + panel 复用两件事。
// 详细 intake store ctx 路由由源码 `useAgentStoreOrCtx` 调用保证, 单独
// 单元测试需要构造完整 AgentSession metadata, ROI 低。
// @vitest-environment happy-dom

import { describe, expect, it, beforeEach, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import ModelPickerToolbarButton from '../../src/web/src/components/ModelPickerToolbarButton.js'
import { useAgentStore } from '../../src/web/src/store/useAgentStore.js'
import type { ModelEntry } from '../../src/shared/settings.js'

const models: ModelEntry[] = [
  {
    alias: 'M3',
    model: 'MiniMax-M3',
    label: 'MiniMax-M3 (M3)',
    description: '最强',
    baseUrl: 'https://api.minimaxi.com/v1',
  },
  {
    alias: 'haiku',
    model: 'MiniMax-M2.7-highspeed',
    label: 'M2.7 · 快速',
    baseUrl: 'https://api.minimaxi.com/v1',
  },
]

beforeEach(() => {
  vi.restoreAllMocks()
  useAgentStore.setState({
    sessionId: 'sess-1',
    activeSessionId: 'sess-1',
    sessions: [{
      sessionId: 'sess-1',
      title: 'test',
      updatedAt: 1,
      cwd: '/x',
      model: 'MiniMax-M3',
    }],
    messages: [],
    status: 'idle',
    cwd: '/x',
    availableModels: models,
  })
  // Stub fetch for the useConversationInfo hook's settings call.
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      defaultModel: 'MiniMax-M3',
      baseURL: null,
      models,
    }),
  } as Response)
})

describe('ModelPickerToolbarButton', () => {
  it('渲染 trigger, data-testid 与 aria-label 正确', () => {
    render(<ModelPickerToolbarButton />)
    const trigger = screen.getByTestId('model-picker-toolbar-trigger')
    expect(trigger).toBeTruthy()
    expect(trigger.getAttribute('aria-label')).toMatch(/切换模型/)
    expect(trigger.textContent).toContain('MiniMax-M3')
  })

  it('点击 trigger 弹出 model-picker-content', async () => {
    render(<ModelPickerToolbarButton />)
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(screen.getByTestId('model-picker-toolbar-trigger'))
    await waitFor(() => {
      expect(screen.getByTestId('model-picker-content')).toBeTruthy()
    })
    // panel 里有所有 models(从 store availableModels 渲染)
    // 注: M3 是当前 session 的 model, 在 Recent + Provider group 两处都渲染,
    // 所以用 getAllByTestId。两个 model 至少各出现一次。
    expect(screen.getAllByTestId('model-row-M3').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByTestId('model-row-haiku')).toBeDefined()
  })

  it('点击 panel 中的 model 行 → 调 useAgentStore 的 patchSessionModel', async () => {
    const patchSessionModel = vi.fn().mockResolvedValue(undefined)
    useAgentStore.setState({ patchSessionModel: patchSessionModel as any })

    render(<ModelPickerToolbarButton />)
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(screen.getByTestId('model-picker-toolbar-trigger'))
    // haiku 不在 Recent(只有当前 session 的 M3 在),只在 group 出现一次
    fireEvent.click(screen.getByTestId('model-row-haiku'))
    await waitFor(() => {
      expect(patchSessionModel).toHaveBeenCalledWith('sess-1', {
        model: 'MiniMax-M2.7-highspeed',
        providerId: undefined,
      })
    })
  })
})
