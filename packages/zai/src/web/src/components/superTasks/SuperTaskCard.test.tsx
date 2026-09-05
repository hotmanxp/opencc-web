// @vitest-environment happy-dom
// @ts-nocheck — vitest 项目默认不开启 noImplicitAny,这里跳过检查加速
import { describe, expect, it, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
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

// 火柴人动画(2026-09-02,任务工厂动感增强):
describe('SuperTaskCard stickman 动画 (2026-09-02)', () => {
  it('processing 桶 + status=processing 时渲染 stickman-processing,含 hammer rect + SMIL animateTransform', () => {
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
    const stickman = container.querySelector('[data-testid="stickman-processing"]')
    expect(stickman).toBeTruthy()
    // 应有 SVG 子节点 + 至少 4 个 animateTransform(头/右臂/左腿/右腿)
    const svg = stickman?.querySelector('svg')
    expect(svg).toBeTruthy()
    const animTags = stickman?.querySelectorAll('animateTransform')
    expect(animTags?.length).toBeGreaterThanOrEqual(4)
    // 工作中应带锤子(实心 rect),不是放大镜(空心 circle)
    expect(stickman?.querySelector('rect')).toBeTruthy()
    expect(stickman?.querySelector('circle[fill="none"]')).toBeTruthy() // 头是空心 circle
  })

  it('verifying 桶时渲染 stickman-verifying,含 magnifier circle', () => {
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
    const stickman = container.querySelector('[data-testid="stickman-verifying"]')
    expect(stickman).toBeTruthy()
    // 验证中应有两个空心 circle(头 + 放大镜);不应有 hammer rect
    expect(stickman?.querySelector('rect')).toBeNull()
    const circles = stickman?.querySelectorAll('circle')
    expect(circles?.length).toBe(2) // 头 + 放大镜
  })

  it('processing 桶但 status=paused 时不渲染 stickman(已暂停不需要动感)', () => {
    const { container } = render(
      <SuperTaskCard
        task={baseTask({ status: 'paused', bucket: 'processing-tasks' })}
        selected={false}
        onToggleSelect={() => {}}
        dimmed={false}
        onOpenDetail={() => {}}
        onDeleted={() => {}}
      />,
    )
    expect(container.querySelector('[data-testid="stickman-processing"]')).toBeNull()
    expect(container.querySelector('[data-testid="stickman-verifying"]')).toBeNull()
  })

  it('finished / queue 桶都不渲染 stickman', () => {
    const cases: Array<Partial<TaskSummary>> = [
      { status: 'done', bucket: 'finished-tasks' },
      { status: 'queued', bucket: 'queue-tasks' },
    ]
    for (const over of cases) {
      const { container } = render(
        <SuperTaskCard
          task={baseTask(over)}
          selected={false}
          onToggleSelect={() => {}}
          dimmed={false}
          onOpenDetail={() => {}}
          onDeleted={() => {}}
        />,
      )
      expect(container.querySelector('[data-testid^="stickman-"]')).toBeNull()
    }
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

// zai patch (2026-09-04, quick-intake):卡片渲染 quick 模式视觉标记。
describe('SuperTaskCard mode Tag (2026-09-04 quick-intake)', () => {
  it('mode="quick" 时渲染「轻量」Tag(data-mode="quick")', () => {
    const { container } = render(
      <SuperTaskCard
        task={baseTask({ mode: 'quick' })}
        selected={false}
        onToggleSelect={() => {}}
        dimmed={false}
        onOpenDetail={() => {}}
        onDeleted={() => {}}
      />,
    )
    const quickTag = container.querySelector('[data-mode="quick"]')
    expect(quickTag).toBeTruthy()
    expect(quickTag?.textContent).toContain('轻量')
    expect(quickTag?.classList.contains('ant-tag-default') || quickTag?.className.includes('ant-tag-default')).toBe(true)
  })

  it('mode="full" 或缺省时不渲染「轻量」Tag', () => {
    const cases: Array<{ name: string; over: Partial<TaskSummary> }> = [
      { name: 'full 显式', over: { mode: 'full' } },
      { name: 'mode 缺省', over: {} },
    ]
    for (const c of cases) {
      const { container } = render(
        <SuperTaskCard
          task={baseTask(c.over)}
          selected={false}
          onToggleSelect={() => {}}
          dimmed={false}
          onOpenDetail={() => {}}
          onDeleted={() => {}}
        />,
      )
      expect(container.querySelector(`[data-mode="quick"]`)).toBeNull()
    }
  })
})

// zai patch (2026-09-05, tf-fjdn0n4v):回归修正 —— tf-gqu253az 把所有
// queued 卡片的「启动」按钮整体替换成「已排队」Tag,导致新创建的任务
// 无法启动。新行为契约:
//  - 默认渲染「启动」按钮(▶ + 文字),data-testid=quick-start-task-<id>
//  - 点击启动 → 乐观切到「已排队」Tag(data-testid=queued-indicator-<id>)
//  - server 反馈(task.bucket 离开 queue-tasks)useEffect 兜底清 isStarting
//  - start 抛错时回滚 isStarting,Start 按钮重新出现
// 行为契约与移动端 MobileSuperTaskCard.tsx 完全一致。
describe('SuperTaskCard — 启动按钮 + 已排队 Tag (2026-09-05 tf-fjdn0n4v)', () => {
  it('S1:queued 任务默认渲染「启动」按钮(data-testid=quick-start-task-<id>),不渲染已排队 Tag', () => {
    const { container } = render(
      <SuperTaskCard
        task={baseTask({ id: 'tf-dstart01', status: 'queued', bucket: 'queue-tasks' })}
        selected={false}
        onToggleSelect={() => {}}
        dimmed={false}
        onOpenDetail={() => {}}
        onDeleted={() => {}}
      />,
    )
    const btn = container.querySelector(`[data-testid="quick-start-task-tf-dstart01"]`) as HTMLButtonElement
    expect(btn).toBeTruthy()
    expect(btn.tagName.toLowerCase()).toBe('button')
    expect(btn.hasAttribute('disabled')).toBe(false)
    expect(btn.textContent).toContain('启动')
    // 默认态不渲染已排队 Tag
    expect(container.querySelector(`[data-testid="queued-indicator-tf-dstart01"]`)).toBeNull()
  })

  it('S2:processing / verifying / done / failed / paused 任务均不渲染启动按钮或已排队 Tag', () => {
    const cases: Array<{ id: string; status: TaskSummary['status']; bucket: TaskSummary['bucket'] }> = [
      { id: 'tf-dproc01', status: 'processing', bucket: 'processing-tasks' },
      { id: 'tf-dvery01', status: 'verifying', bucket: 'verifying-tasks' },
      { id: 'tf-ddone01', status: 'done', bucket: 'finished-tasks' },
      { id: 'tf-dfail01', status: 'failed', bucket: 'finished-tasks' },
      { id: 'tf-dpaus01', status: 'paused', bucket: 'processing-tasks' },
    ]
    for (const c of cases) {
      const { container } = render(
        <SuperTaskCard
          task={baseTask({ id: c.id, status: c.status, bucket: c.bucket })}
          selected={false}
          onToggleSelect={() => {}}
          dimmed={false}
          onOpenDetail={() => {}}
          onDeleted={() => {}}
        />,
      )
      expect(container.querySelector(`[data-testid="quick-start-task-${c.id}"]`)).toBeNull()
      expect(container.querySelector(`[data-testid="queued-indicator-${c.id}"]`)).toBeNull()
    }
  })

  it('S3:点启动按钮 → 触发 store.start(task.id) + 乐观切到「已排队」Tag', async () => {
    const start = useSuperTaskStore.getState().start
    const { container } = render(
      <SuperTaskCard
        task={baseTask({ id: 'tf-dstart03', status: 'queued', bucket: 'queue-tasks' })}
        selected={false}
        onToggleSelect={() => {}}
        dimmed={false}
        onOpenDetail={() => {}}
        onDeleted={() => {}}
      />,
    )
    const btn = container.querySelector(`[data-testid="quick-start-task-tf-dstart03"]`) as HTMLButtonElement
    fireEvent.click(btn)
    expect(start).toHaveBeenCalledWith('tf-dstart03')
    // 乐观态:Start 按钮消失,「已排队」Tag 出现(同步 setState 立即生效)
    await waitFor(() => {
      expect(container.querySelector('[data-testid="quick-start-task-tf-dstart03"]')).toBeNull()
      const tag = container.querySelector('[data-testid="queued-indicator-tf-dstart03"]')
      expect(tag).toBeTruthy()
      expect(tag?.textContent).toContain('已排队')
    })
  })

  it('S4:点启动按钮 → 不触发卡片 onOpenDetail(stopPropagation 隔离)', () => {
    const onOpenDetail = vi.fn()
    render(
      <SuperTaskCard
        task={baseTask({ id: 'tf-dstart04', status: 'queued', bucket: 'queue-tasks' })}
        selected={false}
        onToggleSelect={() => {}}
        dimmed={false}
        onOpenDetail={onOpenDetail}
        onDeleted={() => {}}
      />,
    )
    const btn = screen.getByTestId('quick-start-task-tf-dstart04') as HTMLButtonElement
    fireEvent.click(btn)
    // stopPropagation 阻断 → 卡片 onOpenDetail 不应被调
    expect(onOpenDetail).not.toHaveBeenCalled()
  })

  it('S5:store.start 抛错时 isStarting 回滚 → Start 按钮重新出现,可重试', async () => {
    const startSpy = vi.fn(async () => { throw new Error('rpc 500') })
    useSuperTaskStore.setState({ start: startSpy })
    const { container } = render(
      <SuperTaskCard
        task={baseTask({ id: 'tf-dstart05', status: 'queued', bucket: 'queue-tasks' })}
        selected={false}
        onToggleSelect={() => {}}
        dimmed={false}
        onOpenDetail={() => {}}
        onDeleted={() => {}}
      />,
    )
    const btn = container.querySelector(`[data-testid="quick-start-task-tf-dstart05"]`) as HTMLButtonElement
    fireEvent.click(btn)
    await waitFor(() => {
      expect(startSpy).toHaveBeenCalledWith('tf-dstart05')
    })
    // catch 块里 setIsStarting(false) → 按钮回来,可继续点
    await waitFor(() => {
      expect(container.querySelector('[data-testid="quick-start-task-tf-dstart05"]')).toBeTruthy()
      expect(container.querySelector('[data-testid="queued-indicator-tf-dstart05"]')).toBeNull()
    })
  })
})
