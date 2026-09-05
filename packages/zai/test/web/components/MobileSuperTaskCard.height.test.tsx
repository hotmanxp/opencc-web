// @vitest-environment happy-dom
// zai patch (2026-09-05, tf-7l9rsb47):移动端 superTask 卡片按执行中卡设固定高度。
//
// 背景:此前根 div `minHeight: 56` 导致短内容卡视觉塌陷(queue 单行 tag
// + 短标题 → 渲染 ~70px;processing 卡三行内容 → ~108px),queue / processing
// / verifying / finished 四 tab 内卡片高度不齐。本测试断言:
//  - 4 种 status(queued / processing / verifying / done)渲染时,根 div
//    `style.minHeight` 都 ≥ 基线 `BASELINE_MIN_HEIGHT`(=108)
//  - 同一容器内渲染多张不同 status 的卡,所有根 div 的 `style.minHeight`
//    完全一致(防止有人按 status 写分支 height,再次破坏齐顶齐底)
//
// 设计取舍:断言 style 字段而不是真实 offsetHeight。happy-dom 不渲染
// layout,getBoundingClientRect/offsetHeight 全是 0;style 是组件契约
// 的最小可信证据。108 是 tf-7l9rsb47 commit 注释里的「实测基线估算」
// 值,与根 div 注释一致 —— 谁动这个值,测试先红。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { render } from '@testing-library/react'
import MobileSuperTaskCard from '../../../src/web/src/components/superTasks/MobileSuperTaskCard.js'
import { useSuperTaskStore } from '../../../src/web/src/store/useSuperTaskStore.js'
import type { TaskSummary } from '../../../src/web/src/lib/superTaskApi.js'

const { deleteSuperTasksMock } = vi.hoisted(() => ({
  deleteSuperTasksMock: vi.fn(async () => undefined),
}))
vi.mock('../../../src/web/src/lib/superTaskApi.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/web/src/lib/superTaskApi.js')>(
    '../../../src/web/src/lib/superTaskApi.js',
  )
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

// zai patch (2026-09-05, tf-7l9rsb47):基线值,与 MobileSuperTaskCard.tsx
// 根 div style.minHeight 注释里的「实测基线估算 108」严格对齐。任何把
// 这值改小的人,本测试必须先红,确保短内容卡不会再塌陷到 ~70px。
const BASELINE_MIN_HEIGHT = 108

describe('MobileSuperTaskCard — 固定高度 (2026-09-05 tf-7l9rsb47)', () => {
  it('H1:queued 卡根 div minHeight ≥ 108(避免短内容卡塌陷到 56)', () => {
    render(
      <MobileSuperTaskCard
        task={baseTask({ id: 'tf-h01', status: 'queued', bucket: 'queue-tasks' })}
        onOpen={vi.fn()}
      />,
    )
    const root = document.querySelector('[data-testid="mobile-task-card-tf-h01"]') as HTMLElement | null
    expect(root).toBeTruthy()
    // min-height 是 CSS 短横,React 转成 style.minHeight
    const styleMin = parseInt(String(root?.style.minHeight ?? ''), 10)
    expect(Number.isFinite(styleMin)).toBe(true)
    expect(styleMin).toBeGreaterThanOrEqual(BASELINE_MIN_HEIGHT)
  })

  it('H1b:processing / verifying / done 卡根 div minHeight ≥ 108', () => {
    const cases: Array<{ id: string; status: TaskSummary['status']; bucket: TaskSummary['bucket'] }> = [
      { id: 'tf-h02', status: 'processing', bucket: 'processing-tasks' },
      { id: 'tf-h03', status: 'verifying', bucket: 'verifying-tasks' },
      { id: 'tf-h04', status: 'done', bucket: 'finished-tasks' },
    ]
    for (const c of cases) {
      render(
        <MobileSuperTaskCard
          task={baseTask({ id: c.id, status: c.status, bucket: c.bucket })}
          onOpen={vi.fn()}
        />,
      )
      const root = document.querySelector(`[data-testid="mobile-task-card-${c.id}"]`) as HTMLElement | null
      expect(root).toBeTruthy()
      const styleMin = parseInt(String(root?.style.minHeight ?? ''), 10)
      expect(styleMin).toBeGreaterThanOrEqual(BASELINE_MIN_HEIGHT)
    }
  })

  it('H2:同一容器内渲染 4 张不同 status 的卡 → 所有根 div minHeight 完全一致(齐顶齐底)', () => {
    const cases: Array<{ id: string; status: TaskSummary['status']; bucket: TaskSummary['bucket'] }> = [
      { id: 'tf-mh1', status: 'queued', bucket: 'queue-tasks' },
      { id: 'tf-mh2', status: 'processing', bucket: 'processing-tasks' },
      { id: 'tf-mh3', status: 'verifying', bucket: 'verifying-tasks' },
      { id: 'tf-mh4', status: 'done', bucket: 'finished-tasks' },
    ]
    // zai patch (2026-09-05, tf-7l9rsb47):RTL v12+ 默认 auto-cleanup,
    // 循环 render() 之间会彼此 unmount。这里用单一 fragment 一次 render,
    // 把 4 张卡作为兄弟节点挂到同一容器 —— 模拟 MobileSuperTasks 列表
    // 同时挂载 4 tab 卡片的真实 DOM 形态,语义等价。
    render(
      <>
        {cases.map((c) => (
          <MobileSuperTaskCard
            key={c.id}
            task={baseTask({ id: c.id, status: c.status, bucket: c.bucket })}
            onOpen={vi.fn()}
          />
        ))}
      </>,
    )
    const heights: number[] = cases.map((c) => {
      const el = document.querySelector(`[data-testid="mobile-task-card-${c.id}"]`) as HTMLElement | null
      expect(el).toBeTruthy()
      return parseInt(String(el?.style.minHeight ?? ''), 10)
    })
    // 全部值相等(且都 ≥ 基线)—— 防止有人按 status 写分支 height
    expect(heights.every((h) => Number.isFinite(h) && h >= BASELINE_MIN_HEIGHT)).toBe(true)
    expect(new Set(heights).size).toBe(1)
  })

  it('H3:根 div 已具备 display:flex + flexDirection:column(timestamp 贴底前提)', () => {
    render(<MobileSuperTaskCard task={baseTask({ id: 'tf-h05' })} onOpen={vi.fn()} />)
    const root = document.querySelector('[data-testid="mobile-task-card-tf-h05"]') as HTMLElement | null
    expect(root).toBeTruthy()
    // jsdom / happy-dom 都会把 inline style 暴露在 style.display / style.flexDirection
    expect(root?.style.display).toBe('flex')
    expect(root?.style.flexDirection).toBe('column')
  })

  it('H4:根 div 带 data-status 属性,值等于 task.status(便于 status 维度聚合回归)', () => {
    const cases: Array<{ id: string; status: TaskSummary['status'] }> = [
      { id: 'tf-h06q', status: 'queued' },
      { id: 'tf-h06p', status: 'processing' },
      { id: 'tf-h06v', status: 'verifying' },
      { id: 'tf-h06d', status: 'done' },
    ]
    for (const c of cases) {
      render(
        <MobileSuperTaskCard
          task={baseTask({ id: c.id, status: c.status, bucket:
            c.status === 'queued' ? 'queue-tasks' :
            c.status === 'processing' ? 'processing-tasks' :
            c.status === 'verifying' ? 'verifying-tasks' : 'finished-tasks',
          })}
          onOpen={vi.fn()}
        />,
      )
      const el = document.querySelector(`[data-testid="mobile-task-card-${c.id}"]`) as HTMLElement | null
      expect(el).toBeTruthy()
      expect(el?.getAttribute('data-status')).toBe(c.status)
    }
  })
})
