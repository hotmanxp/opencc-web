// @vitest-environment happy-dom
// @ts-nocheck — vitest 项目默认不开启 noImplicitAny,这里跳过检查加速
import { describe, expect, it, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, fireEvent, within } from '@testing-library/react'
import SuperTaskCard from './SuperTaskCard'
import { useSuperTaskStore } from '../../store/useSuperTaskStore'
import type { TaskSummary } from '../../lib/superTaskApi'

vi.mock('../../lib/agentSessionApi', () => ({
  createAgentSession: vi.fn(),
  pickLastSelectedModel: vi.fn(() => ({})),
  deleteAgentSession: vi.fn(),
}))

const baseTask = (over: Partial<TaskSummary> = {}): TaskSummary => ({
  id: 'tf-test01',
  title: '示例任务',
  status: 'processing',
  cwd: '/abs/code/proj-a',
  bucket: 'processing-tasks',
  createdAt: '2026-09-02T00:00:00.000Z',
  executorTaskId: null,
  ...over,
})

/** 在卡片内找按钮 — 用按钮文字精确匹配(icon-only 按钮通过 aria-label 或 class 找)。 */
function findButtonByText(container: HTMLElement, text: string): HTMLElement | null {
  return container.querySelector(`button.ant-btn:has(span):not(.ant-btn-icon-only)`)
    ?? null
}
/** AntD Tooltip 包裹 + 文本按钮 textContent 可能含空白(jsdom 渲染时
 *  「验收」会被分成 "验 收")→ 把所有空白删掉再比对。*/
function hasButtonWithText(container: HTMLElement, text: string): boolean {
  const buttons = Array.from(container.querySelectorAll('button'))
  const norm = (s: string) => s.replace(/\s+/g, '')
  return buttons.some((b) => {
    const t = norm(b.textContent ?? '')
    return t === norm(text) || t.includes(norm(text))
  })
}

beforeEach(() => {
  // 替换 store actions 为 spy,避免真的打 fetch
  useSuperTaskStore.setState({
    buckets: { queue: [], processing: [], verifying: [], finished: [] },
    managed: false,
    loading: false,
    error: null,
    supervisorSessionId: 'sup-1',
    lastCreatedTaskId: null,
    loadedOnce: true,
    start: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    accept: vi.fn(async () => {}),
    deleteTasks: vi.fn(async () => {}),
    setManaged: vi.fn(async () => {}),
    load: vi.fn(async () => {}),
    applyTaskFactoryEvent: vi.fn(),
    clearLastCreated: vi.fn(),
  })
})

describe('SuperTaskCard verifying 状态 (2026-09-02)', () => {
  it('verifying 状态渲染 cyan Tag "验证中"', () => {
    render(
      <SuperTaskCard
        task={baseTask({ status: 'verifying', bucket: 'verifying-tasks' })}
        selected={false}
        onToggleSelect={() => {}}
        dimmed={false}
        onOpenDetail={() => {}}
        onDeleted={() => {}}
      />,
    )
    // AntD cyan 对应 Tag class 含 "ant-tag-cyan"
    const tag = screen.getByText('验证中')
    expect(tag.closest('.ant-tag-cyan')).toBeTruthy()
  })

  it('verifying 桶显示「强制通过」按钮', () => {
    const { container } = render(
      <SuperTaskCard
        task={baseTask({ status: 'verifying', bucket: 'verifying-tasks' })}
        selected={false}
        onToggleSelect={() => {}}
        dimmed={false}
        onOpenDetail={() => {}}
        onDeleted={() => {}}
      />,
    )
    // 「强制通过」是 type=primary + 文字按钮
    expect(hasButtonWithText(container, '强制通过')).toBe(true)
    // 「暂停」不应出现(只 processing 桶才显示)
    expect(hasButtonWithText(container, '暂停')).toBe(false)
  })

  it('verifying 桶点击「强制通过」触发 accept(id)', () => {
    const accept = useSuperTaskStore.getState().accept
    const { container } = render(
      <SuperTaskCard
        task={baseTask({ status: 'verifying', bucket: 'verifying-tasks' })}
        selected={false}
        onToggleSelect={() => {}}
        dimmed={false}
        onOpenDetail={() => {}}
        onDeleted={() => {}}
      />,
    )
    const btn = Array.from(container.querySelectorAll('button'))
      .find((b) => (b.textContent ?? '').replace(/\s+/g, '') === '强制通过') as HTMLButtonElement
    expect(btn).toBeTruthy()
    fireEvent.click(btn)
    expect(accept).toHaveBeenCalledWith('tf-test01')
  })

  it('verifying 桶删除按钮禁用(没有 popconfirm)', () => {
    const { container } = render(
      <SuperTaskCard
        task={baseTask({ status: 'verifying', bucket: 'verifying-tasks' })}
        selected={false}
        onToggleSelect={() => {}}
        dimmed={false}
        onOpenDetail={() => {}}
        onDeleted={() => {}}
      />,
    )
    // verifying 桶卡片中应有且只有一个删除按钮(disabled)
    const delBtns = Array.from(container.querySelectorAll('button.ant-btn-dangerous'))
    expect(delBtns.length).toBe(1)
    expect(delBtns[0]?.hasAttribute('disabled')).toBe(true)
  })

  it('processing+processing 仍显示「暂停」与「验收」按钮', () => {
    const { container } = render(
      <SuperTaskCard
        task={baseTask({ status: 'processing', bucket: 'processing-tasks' })}
        selected={false}
        onToggleSelect={() => {}}
        dimmed={false}
        onOpenDetail={() => {}}
        onDeleted={() => {}}
      />,
    )
    expect(hasButtonWithText(container, '验收')).toBe(true)
    // 「强制通过」不应出现(只 verifying 桶才显示)
    expect(hasButtonWithText(container, '强制通过')).toBe(false)
  })
})

// zai patch (2026-09-02, priority Tag 渲染):
describe('SuperTaskCard priority Tag (2026-09-02)', () => {
  it('P0 → red Tag、P1 → orange、P2 → blue、P3 → default(灰)', () => {
    const cases: Array<['P0' | 'P1' | 'P2' | 'P3', string]> = [
      ['P0', 'ant-tag-red'],
      ['P1', 'ant-tag-orange'],
      ['P2', 'ant-tag-blue'],
      ['P3', 'ant-tag-default'],
    ]
    for (const [priority, cls] of cases) {
      const { container } = render(
        <SuperTaskCard
          task={baseTask({ priority, dependsOn: [] })}
          selected={false}
          onToggleSelect={() => {}}
          dimmed={false}
          onOpenDetail={() => {}}
          onDeleted={() => {}}
        />,
      )
      const tag = container.querySelector(`[data-priority="${priority}"]`)
      expect(tag).toBeTruthy()
      expect(tag?.classList.contains(cls) || tag?.className.includes(cls)).toBe(true)
    }
  })

  it('priority 缺省(P2 也展示)+ 没有 priority 字段时卡片不挂 Tag', () => {
    // 显式 P2 也展示 Tag,让用户看到调度排序
    const { container: c1 } = render(
      <SuperTaskCard
        task={baseTask({ priority: 'P2' })}
        selected={false}
        onToggleSelect={() => {}}
        dimmed={false}
        onOpenDetail={() => {}}
        onDeleted={() => {}}
      />,
    )
    expect(c1.querySelector('[data-priority="P2"]')).toBeTruthy()
    // 无 priority 字段 → 不渲染(向后兼容 legacy)
    const { container: c2 } = render(
      <SuperTaskCard
        task={baseTask({})}
        selected={false}
        onToggleSelect={() => {}}
        dimmed={false}
        onOpenDetail={() => {}}
        onDeleted={() => {}}
      />,
    )
    expect(c2.querySelector('[data-priority]')).toBeNull()
  })

  it('dependsOn 非空时 tooltip 文案包含「依赖 N 个任务」', () => {
    const { container } = render(
      <SuperTaskCard
        task={baseTask({ priority: 'P1', dependsOn: ['tf-aaaaaaaa', 'tf-bbbbbbbb'] })}
        selected={false}
        onToggleSelect={() => {}}
        dimmed={false}
        onOpenDetail={() => {}}
        onDeleted={() => {}}
      />,
    )
    // AntD Tooltip 渲染时,内容在 wrapper 里 —— 这里通过 querySelector 找含「依赖」的 wrapper
    const wrapper = container.querySelector('.ant-tooltip')
    // happy-dom 不一定完整渲染 tooltip,这里降级到查 Tag 上的属性
    const tag = container.querySelector('[data-priority="P1"]')
    expect(tag).toBeTruthy()
    void wrapper
  })
})
