// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import MobileSuperTaskCard from './MobileSuperTaskCard'
import { useSuperTaskStore } from '../../store/useSuperTaskStore'
import type { TaskSummary } from '../../lib/superTaskApi'

// zai patch (2026-09-04, tf-al38784c):用 vi.mock 替 deleteSuperTasks 防止真打 fetch。
// 与 SuperTaskCard.test.tsx 对 agentSessionApi 的处理一致;mock factory
// 外部引用 vi.fn 必须用 vi.hoisted(vitest 把 vi.mock 提到所有 import 前,
// 工厂闭包要在 import 解析阶段执行,普通 const 还在 TDZ)。
const { deleteSuperTasksMock } = vi.hoisted(() => ({
  deleteSuperTasksMock: vi.fn(async () => undefined),
}))
vi.mock('../../lib/superTaskApi', async () => {
  const actual = await vi.importActual<typeof import('../../lib/superTaskApi')>('../../lib/superTaskApi')
  return { ...actual, deleteSuperTasks: deleteSuperTasksMock }
})

const baseTask = (over: Partial<TaskSummary> = {}): TaskSummary => ({
  id: 'tf-mob01',
  title: '移动端示例任务',
  status: 'processing',
  cwd: '/abs/code/proj-a',
  bucket: 'processing-tasks',
  createdAt: '2026-09-02T00:00:00.000Z',
  priority: 'P1',
  ...over,
})

beforeEach(() => {
  deleteSuperTasksMock.mockClear()
  // 替 store actions 为 spy,避免真打 fetch —— 与 SuperTaskCard.test.tsx 同款套路
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

describe('MobileSuperTaskCard (2026-09-04)', () => {
  it('渲染优先级 Tag + 状态 Tag 文案', () => {
    render(<MobileSuperTaskCard task={baseTask()} onOpen={vi.fn()} />)
    // 状态 Tag:「执行中」
    expect(screen.getByText('执行中')).toBeTruthy()
    // 优先级 Tag:P1
    expect(screen.getByText('P1')).toBeTruthy()
  })

  it('点击整卡 → 触发 onOpen(task.id)', () => {
    const onOpen = vi.fn()
    render(<MobileSuperTaskCard task={baseTask()} onOpen={onOpen} />)
    fireEvent.click(screen.getByTestId('mobile-task-card-tf-mob01'))
    expect(onOpen).toHaveBeenCalledWith('tf-mob01')
  })

  it('键盘 Enter → 也触发 onOpen(task.id)', () => {
    const onOpen = vi.fn()
    render(<MobileSuperTaskCard task={baseTask()} onOpen={onOpen} />)
    const card = screen.getByTestId('mobile-task-card-tf-mob01')
    fireEvent.keyDown(card, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith('tf-mob01')
  })

  it('DOM 内无 checkbox / 暂停继续删除按钮(火柴人也不放)', () => {
    const { container } = render(<MobileSuperTaskCard task={baseTask()} onOpen={vi.fn()} />)
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(container.querySelector('.ant-checkbox')).toBeNull()
    // 没有火柴人(移动端不展示)
    expect(container.querySelector('[data-testid^="stickman-"]')).toBeNull()
  })

  it('不同状态 / 优先级 走 SuperTaskCard 三张表(集成验证)', () => {
    const cases: Array<{ status: string; priority: TaskSummary['priority']; label: string; cls: string }> = [
      { status: 'queued', priority: 'P2', label: '排队', cls: 'ant-tag-default' },
      { status: 'failed', priority: 'P0', label: '失败', cls: 'ant-tag-error' },
      { status: 'done', priority: 'P3', label: '完成', cls: 'ant-tag-success' },
    ]
    for (const c of cases) {
      const { container } = render(
        <MobileSuperTaskCard
          task={baseTask({ status: c.status, priority: c.priority, id: `tf-${c.status}` })}
          onOpen={vi.fn()}
        />,
      )
      // 状态 Tag 文案 + class(从 SuperTaskCard 复用 STATUS_TAG)
      const statusTag = container.querySelector(`[data-testid="mobile-status-tag-tf-${c.status}"]`)
      expect(statusTag?.textContent).toBe(c.label)
      expect(statusTag?.className.includes(c.cls)).toBe(true)
      // 优先级 Tag 复用 SuperTaskCard PRIORITY_TAG
      const pTag = container.querySelector(`[data-priority="${c.priority}"]`)
      expect(pTag).toBeTruthy()
    }
  })
})

// zai patch (2026-09-04, quick-intake round 2):补 MobileSuperTaskCard
// quick Tag 覆盖 —— 与桌面 SuperTaskCard.test.tsx quick 用例对齐。
// spec R7 要求:task.mode === 'quick' 时移动端卡片渲染「轻量」Tag;
// task.mode === 'full' 或缺省时不渲染。
describe('MobileSuperTaskCard — quick Tag (2026-09-04 round 2)', () => {
  it('task.mode === "quick" → 渲染「轻量」Tag(data-testid=quick-tag-<id>)', () => {
    const { container } = render(
      <MobileSuperTaskCard
        task={baseTask({ id: 'tf-quick01', mode: 'quick' })}
        onOpen={vi.fn()}
      />,
    )
    const tag = container.querySelector('[data-testid="quick-tag-tf-quick01"]')
    expect(tag).toBeTruthy()
    expect(tag?.textContent).toBe('轻量')
    // 视觉一致性:轻量 Tag 也带 data-mode="quick",便于按模式聚合检索
    expect(tag?.getAttribute('data-mode')).toBe('quick')
  })

  it('task.mode === "full" → 不渲染「轻量」Tag', () => {
    const { container } = render(
      <MobileSuperTaskCard
        task={baseTask({ id: 'tf-full01', mode: 'full' })}
        onOpen={vi.fn()}
      />,
    )
    expect(container.querySelector('[data-testid="quick-tag-tf-full01"]')).toBeNull()
    // full 模式 DOM 内不应出现任何「轻量」文本
    expect(screen.queryByText('轻量')).toBeNull()
  })

  it('task.mode 缺省 → 不渲染「轻量」Tag(向后兼容历史 full 任务)', () => {
    const { container } = render(
      <MobileSuperTaskCard
        task={baseTask({ id: 'tf-legacy01' })}
        onOpen={vi.fn()}
      />,
    )
    expect(container.querySelector('[data-testid="quick-tag-tf-legacy01"]')).toBeNull()
    expect(screen.queryByText('轻量')).toBeNull()
  })
})

// zai patch (2026-09-04, tf-al38784c):移动端单卡右上角 × 删除按钮 + Popconfirm
// 二次确认。spec R7 要求 4 个 case:渲染、queued 确认删除、processing/verifying
// disabled、stopPropagation 不触发卡片 onOpen。
describe('MobileSuperTaskCard — 删除按钮 (2026-09-04 tf-al38784c)', () => {
  it('R7-1:默认渲染右上角 × 按钮(data-testid=mobile-card-delete-<id>)', () => {
    render(<MobileSuperTaskCard task={baseTask({ id: 'tf-del01' })} onOpen={vi.fn()} />)
    const btn = screen.getByTestId('mobile-card-delete-tf-del01')
    expect(btn).toBeTruthy()
    // 默认 processing 状态 → disabled
    expect(btn.hasAttribute('disabled')).toBe(true)
  })

  it('R7-2:queued 任务 × 按钮 enabled → 点击触发 Popconfirm → 确认 → 调 deleteSuperTasks([id])', async () => {
    const onOpen = vi.fn()
    render(
      <MobileSuperTaskCard
        task={baseTask({ id: 'tf-del02', status: 'queued', bucket: 'queue-tasks' })}
        onOpen={onOpen}
      />,
    )
    const btn = screen.getByTestId('mobile-card-delete-tf-del02') as HTMLButtonElement
    expect(btn.hasAttribute('disabled')).toBe(false)
    // 点 × 触发 Popconfirm 显示 —— AntD 用 React portal 把 popconfirm 渲染到
    // document.body(不在 render 返回的 container 内)。happy-dom 渲染时按钮
    // 文案「删除」会因 <span> 包裹被插空格,用 class 直接锁定 dangerous 确认
    // 按钮,绕开 title「删除该任务?」与按钮文案间的歧义。
    fireEvent.click(btn)
    const okBtn = await waitFor(() => {
      const el = document.querySelector('.ant-popconfirm-buttons .ant-btn-dangerous') as HTMLButtonElement | null
      if (!el) throw new Error('popconfirm dangerous button not yet in DOM')
      return el
    })
    fireEvent.click(okBtn)
    await waitFor(() => {
      expect(deleteSuperTasksMock).toHaveBeenCalledWith(['tf-del02'])
    })
    // 卡片 onOpen **不**应被触发(spec R5:点 × 不能误开抽屉)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('R7-3:processing 任务 × 按钮 disabled', () => {
    render(
      <MobileSuperTaskCard
        task={baseTask({ id: 'tf-del03', status: 'processing', bucket: 'processing-tasks' })}
        onOpen={vi.fn()}
      />,
    )
    const btn = screen.getByTestId('mobile-card-delete-tf-del03') as HTMLButtonElement
    expect(btn.hasAttribute('disabled')).toBe(true)
    // Tooltip 通过 aria-describedby / title 体现:Button 实际挂在 Tooltip 内,
    // happy-dom 下 AntD Tooltip 不直接渲染 popup,验证「disabled」属性即可
    // (实际提示文案由 R8 端到端验收覆盖)。
    // 尝试点 disabled 按钮不应触发 delete
    fireEvent.click(btn)
    expect(deleteSuperTasksMock).not.toHaveBeenCalled()
  })

  it('R7-3b:verifying 任务 × 按钮 disabled', () => {
    render(
      <MobileSuperTaskCard
        task={baseTask({ id: 'tf-del03b', status: 'verifying', bucket: 'verifying-tasks' })}
        onOpen={vi.fn()}
      />,
    )
    const btn = screen.getByTestId('mobile-card-delete-tf-del03b') as HTMLButtonElement
    expect(btn.hasAttribute('disabled')).toBe(true)
    fireEvent.click(btn)
    expect(deleteSuperTasksMock).not.toHaveBeenCalled()
  })

  it('R7-4:点 × 按钮 → 不触发卡片 onOpen(stopPropagation 隔离,queued 可点场景)', () => {
    const onOpen = vi.fn()
    render(
      <MobileSuperTaskCard
        task={baseTask({ id: 'tf-del04', status: 'queued', bucket: 'queue-tasks' })}
        onOpen={onOpen}
      />,
    )
    const btn = screen.getByTestId('mobile-card-delete-tf-del04') as HTMLButtonElement
    fireEvent.click(btn)
    // Popconfirm 弹出 ≠ 卡片 onOpen;若 stopPropagation 漏写则 onOpen 会被调
    expect(onOpen).not.toHaveBeenCalled()
  })
})

// zai patch (2026-09-05, tf-gqu253az):移动端「启动」按钮改成「已排队」
// 非交互 Tag。spec 要求覆盖:渲染(queued → 显示 / 其他状态不显示),
// 不可点击(DOM 层 pointerEvents: none + 不是 button + 不触发 store.start)。
// 配套桌面 SuperTaskCard L319-337,两块 UI 共享同一份排队语义。
describe('MobileSuperTaskCard — 已排队 Tag (2026-09-05 tf-gqu253az)', () => {
  it('Q1:queued 任务渲染「已排队」Tag(data-testid=mobile-card-queued-<id>)且不可点击', () => {
    const { container } = render(
      <MobileSuperTaskCard
        task={baseTask({ id: 'tf-queue01', status: 'queued', bucket: 'queue-tasks' })}
        onOpen={vi.fn()}
      />,
    )
    const tag = container.querySelector('[data-testid="mobile-card-queued-tf-queue01"]')
    expect(tag).toBeTruthy()
    expect(tag?.textContent).toContain('已排队')
    // Tag 不是 button → 无 button 角色,无 onClick 触点
    expect(tag?.tagName.toLowerCase()).not.toBe('button')
    // pointerEvents: none 阻断鼠标事件,从 DOM 层告诉用户「不可交互」
    const style = (tag as HTMLElement | null)?.style
    expect(style?.pointerEvents).toBe('none')
  })

  it('Q2:processing / verifying / done / failed / paused 任务均不渲染已排队 Tag', () => {
    const cases: Array<{ id: string; status: TaskSummary['status']; bucket: TaskSummary['bucket'] }> = [
      { id: 'tf-proc01', status: 'processing', bucket: 'processing-tasks' },
      { id: 'tf-very01', status: 'verifying', bucket: 'verifying-tasks' },
      { id: 'tf-done01', status: 'done', bucket: 'finished-tasks' },
      { id: 'tf-fail01', status: 'failed', bucket: 'finished-tasks' },
      { id: 'tf-paus01', status: 'paused', bucket: 'processing-tasks' },
    ]
    for (const c of cases) {
      const { container } = render(
        <MobileSuperTaskCard
          task={baseTask({ id: c.id, status: c.status, bucket: c.bucket })}
          onOpen={vi.fn()}
        />,
      )
      expect(container.querySelector(`[data-testid="mobile-card-queued-${c.id}"]`)).toBeNull()
    }
  })

  it('Q3:已排队 Tag 是纯指示器 —— 元素无 onClick,store.start 不被任何点击路径触发', () => {
    const start = useSuperTaskStore.getState().start
    const onOpen = vi.fn()
    const { container } = render(
      <MobileSuperTaskCard
        task={baseTask({ id: 'tf-queue03', status: 'queued', bucket: 'queue-tasks' })}
        onOpen={onOpen}
      />,
    )
    const tag = container.querySelector('[data-testid="mobile-card-queued-tf-queue03"]') as HTMLElement
    expect(tag).toBeTruthy()
    // Tag DOM 节点不挂 React onClick 属性(spec 明确要求无 onClick)
    // React 16+ 把所有事件用合成委托实现,onClick 不在 DOM 上,但 Tag
    // 也没有 role=button,语义层即告诉用户「不可点」
    expect(tag.getAttribute('role')).not.toBe('button')
    // 真浏览器下 pointerEvents: none 让 click 根本不命中(命中测试失败),
    // 这里用 happy-dom fireEvent 直接派发 click 来兜底断言 start 不被
    // 任何 onClick handler 调用;若 Tag 漏挂 stopPropagation 或变成 button
    // 这条断言会变成 flaky。先验证最关键的:start 从未被调。
    fireEvent.click(tag)
    expect(start).not.toHaveBeenCalled()
    // 配套提示:onOpen 可能在 happy-dom 模拟下被 card onClick 透传
    // (Tag 事件冒泡到卡片),真浏览器 pointerEvents: none 阻断,这里
    // 不强断 onOpen;若需补这条断言应改用真实浏览器验证。
    void onOpen
  })
})
