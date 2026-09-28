// zai patch (2026-09-28): ModelPickerPanel 底部「Reasoning effort」四档控件。
//
// 重点覆盖第一版踩过的坑: 门控原先只认 (model, providerId) 精确命中的那条,
// 而 capability 是「模型」的属性 —— 用户自建 profile 常常不带 capabilities
// (实测 provider_1790414326756 给 MiniMax-M3 标了 supportsReasoning, 却漏了
// 同 profile 下的 MiniMax-M3.1-Flash-Preview), 内置目录那份却是齐的。
// 同一个模型名因此在 availableModels 里有两条, 精确命中没声明的那条就会把
// 控件整个藏掉 —— 用户视角就是「加了功能但找不到」。
// @vitest-environment happy-dom

import { describe, expect, it, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import ModelPickerPanel from '../../src/web/src/components/ModelPickerPanel.js'
import { useAgentStore } from '../../src/web/src/store/useAgentStore.js'
import type { ModelEntry } from '../../src/shared/settings.js'

/** 用户自建 profile: MiniMax-M3 声明了能力, Flash-Preview 漏了。 */
const USER_PROFILE = 'provider_1790414326756'

function modelEntry(
  model: string,
  providerId: string,
  supportsReasoning?: boolean,
  effort?: { levels?: string[]; defaultLevel?: string },
): ModelEntry {
  return {
    alias: `${providerId}-${model.toLowerCase()}`,
    model,
    label: model,
    providerId,
    ...(supportsReasoning === undefined && !effort
      ? {}
      : {
        capabilities: {
          ...(supportsReasoning === undefined ? {} : { supportsReasoning }),
          ...(effort?.levels ? { effortLevels: effort.levels } : {}),
          ...(effort?.defaultLevel ? { defaultEffortLevel: effort.defaultLevel } : {}),
        },
      }),
  }
}

/** 服务端会为支持推理的模型挂上这两项(见 routes/agentSettings.ts)。 */
const FIVE_TIER = {
  levels: ['low', 'medium', 'high', 'xhigh', 'max'],
  defaultLevel: 'max',
}

function mount(sessionModel: string, entries: ModelEntry[], effort?: 'off' | 'low' | 'medium' | 'high') {
  useAgentStore.setState({
    sessionId: 'sess-1',
    activeSessionId: 'sess-1',
    sessions: [{
      sessionId: 'sess-1',
      title: 'test',
      updatedAt: 1,
      cwd: '/x',
      model: sessionModel,
      providerId: USER_PROFILE,
      ...(effort ? { effort } : {}),
    }],
    messages: [],
    status: 'idle',
    cwd: '/x',
    availableModels: entries,
  })
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ defaultModel: sessionModel, baseURL: null, models: entries }),
  } as Response)
  return render(<ModelPickerPanel />)
}

const offBtn = () => screen.getByRole('button', { name: 'off' })
const highBtn = () => screen.getByRole('button', { name: 'high' })

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('ModelPickerPanel — Reasoning effort 控件', () => {
  it('回归: 当前 profile 缺 capabilities, 但同名条目声明了 → 控件仍显示', () => {
    // 这正是线上那份数据的形状: 自建 profile 漏标 Flash-Preview,
    // builtin-openplatform 那条标了 true。
    mount('MiniMax-M3.1-Flash-Preview', [
      modelEntry('MiniMax-M3.1-Flash-Preview', USER_PROFILE),            // 无 capabilities
      modelEntry('MiniMax-M3.1-Flash-Preview', 'builtin-openplatform', true, FIVE_TIER),
    ])
    expect(screen.getByText('Reasoning effort')).toBeTruthy()
    expect(highBtn()).toBeTruthy()
  })

  it('同名条目全部显式 false → 控件隐藏(不给调必然失败的档位)', () => {
    mount('deepseek-flash', [
      modelEntry('deepseek-flash', USER_PROFILE, false),
      modelEntry('deepseek-flash', 'builtin-deepseek', false),
    ])
    expect(screen.queryByText('Reasoning effort')).toBeNull()
  })

  it('完全无 capabilities 数据 → 隐藏(不猜)', () => {
    mount('unknown-model', [modelEntry('unknown-model', USER_PROFILE)])
    expect(screen.queryByText('Reasoning effort')).toBeNull()
  })

  it('五档模型渲染五个档位(含 xhigh / max)', () => {
    mount('MiniMax-M3.1-Flash-Preview', [
      modelEntry('MiniMax-M3.1-Flash-Preview', USER_PROFILE, true, FIVE_TIER),
    ])
    for (const level of ['off', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(screen.getByRole('button', { name: level })).toBeTruthy()
    }
  })

  it('三档模型不渲染 xhigh / max —— 档位跟着模型走', () => {
    mount('MiniMax-M2.7', [
      modelEntry('MiniMax-M2.7', USER_PROFILE, true, {
        levels: ['low', 'medium', 'high'],
      }),
    ])
    expect(screen.getByRole('button', { name: 'high' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'xhigh' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'max' })).toBeNull()
  })

  it('未设过 effort 时, 选中的是模型声明的默认档(五档模型 → max)', () => {
    mount('MiniMax-M3.1-Flash-Preview', [
      modelEntry('MiniMax-M3.1-Flash-Preview', USER_PROFILE, true, FIVE_TIER),
    ])
    expect(screen.getByRole('button', { name: 'max' }).className).toContain('#a78bfa')
    expect(offBtn().className).not.toContain('#a78bfa')
  })

  it('换模型后存储档位不属于新模型 → 钳到该模型默认档, 不出现「全不亮」', () => {
    // medium → GLM(只收 low/high/max)。换模型不会重写 meta.effort,
    // 若直接拿存储值比对, 四个按钮会一个都不亮。
    mount('zhiniao-glm-5.1', [
      modelEntry('zhiniao-glm-5.1', USER_PROFILE, true, {
        levels: ['low', 'high', 'max'],
      }),
    ], 'medium')
    const lit = ['off', 'low', 'medium', 'high', 'xhigh', 'max'].filter(
      (l) => screen.queryByRole('button', { name: l })?.className.includes('#a78bfa'),
    )
    expect(lit).toHaveLength(1)
    expect(offBtn().className).toContain('#a78bfa')
  })

  it('控件在弹框顶部 —— 排在搜索框之前, 不用滚过模型列表', () => {
    // 放末尾时要滚过 Recent + 全部分组才看得到, 而这是模型名旁唯一的调参
    // 入口。用 DOM 顺序锁住位置: effort 块必须早于搜索输入框。
    mount('MiniMax-M3', [modelEntry('MiniMax-M3', USER_PROFILE, true, {
      levels: ['low', 'medium', 'high', 'max'],
    })])
    const effort = screen.getByText('Reasoning effort')
    const search = screen.getByPlaceholderText('Search')
    expect(
      effort.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('渲染三档 + off, 未设过时 off 为选中态', () => {
    mount('MiniMax-M3', [modelEntry('MiniMax-M3', USER_PROFILE, true, {
      levels: ['low', 'medium', 'high', 'max'],
    })])
    for (const level of ['off', 'low', 'medium', 'high', 'max']) {
      expect(screen.getByRole('button', { name: level })).toBeTruthy()
    }
    expect(offBtn().className).toContain('#a78bfa')
    expect(highBtn().className).not.toContain('#a78bfa')
  })

  it('会话已设 high 时 high 为选中态', () => {
    mount('MiniMax-M3', [modelEntry('MiniMax-M3', USER_PROFILE, true, {
      levels: ['low', 'medium', 'high', 'max'],
    })], 'high')
    expect(highBtn().className).toContain('#a78bfa')
    expect(offBtn().className).not.toContain('#a78bfa')
  })

  it('点击档位写入 store 并 PATCH effort', async () => {
    const patch = vi.fn().mockResolvedValue({ ok: true } as Response)
    mount('MiniMax-M3', [modelEntry('MiniMax-M3', USER_PROFILE, true, {
      levels: ['low', 'medium', 'high', 'max'],
    })])
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(patch)

    highBtn().click()
    await vi.waitFor(() => {
      expect(useAgentStore.getState().sessions[0].effort).toBe('high')
    })
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/agent/sessions/sess-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ effort: 'high' }),
      }),
    )
  })

  it('xhigh 能原样 PATCH 出去(不被 zai 侧的枚举吃掉)', async () => {
    mount('MiniMax-M3.1-Flash-Preview', [
      modelEntry('MiniMax-M3.1-Flash-Preview', USER_PROFILE, true, FIVE_TIER),
    ])
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response)

    screen.getByRole('button', { name: 'xhigh' }).click()

    await vi.waitFor(() => {
      expect(useAgentStore.getState().sessions[0].effort).toBe('xhigh')
    })
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/agent/sessions/sess-1',
      expect.objectContaining({ body: JSON.stringify({ effort: 'xhigh' }) }),
    )
  })

  it('点击已选中的档位不重复 PATCH', () => {
    mount('MiniMax-M3', [modelEntry('MiniMax-M3', USER_PROFILE, true, {
      levels: ['low', 'medium', 'high', 'max'],
    })], 'low')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response)

    screen.getByRole('button', { name: 'low' }).click()

    // 只看 PATCH —— mount 触发的 /api/agent/settings GET 也会记在 spy 上。
    const patches = fetchSpy.mock.calls.filter(
      ([url, init]) =>
        url === '/api/agent/sessions/sess-1' && init?.method === 'PATCH',
    )
    expect(patches).toHaveLength(0)
    expect(useAgentStore.getState().sessions[0].effort).toBe('low')
  })
})
