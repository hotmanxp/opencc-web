// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, fireEvent, within } from '@testing-library/react'
import SuperTaskPanel from './SuperTaskPanel'
import { useSuperTaskStore } from '../../store/useSuperTaskStore'

function setBuckets(extra?: Record<string, unknown>): void {
  useSuperTaskStore.setState({
    buckets: {
      queue: [{ id: 'tf-q', title: '排队任务', status: 'queued', cwd: '/tmp/a1', bucket: 'queue-tasks' }],
      processing: [{ id: 'tf-p', title: '执行中任务', status: 'processing', cwd: '/tmp/a2', bucket: 'processing-tasks' }],
      verifying: [],
      finished: [
        { id: 'tf-d', title: '完成任务', status: 'done', cwd: '/tmp/a3', bucket: 'finished-tasks' },
        { id: 'tf-f', title: '失败任务', status: 'failed', cwd: '/tmp/a4', bucket: 'finished-tasks' },
      ],
    },
    managed: false,
    loading: false,
    error: null,
    ...extra,
  })
}

describe('SuperTaskPanel（看板）', () => {
  it('渲染四栏看板(queue/processing/verifying/finished)并显示任务标题 + 描述', () => {
    useSuperTaskStore.setState({
      buckets: {
        queue: [{ id: 'tf-q', title: '排队任务', status: 'queued', cwd: '/tmp/a1', description: '创建 hello.txt', bucket: 'queue-tasks' }],
        processing: [{ id: 'tf-p', title: '执行中任务', status: 'processing', cwd: '/tmp/a2', bucket: 'processing-tasks' }],
        verifying: [],
        finished: [{ id: 'tf-f', title: '完成任务', status: 'done', cwd: '/tmp/a3', bucket: 'finished-tasks' }],
      },
      managed: false, loading: false, error: null,
    })
    render(<SuperTaskPanel />)
    expect(screen.getByTestId('lane-queue')).toBeTruthy()
    expect(screen.getByTestId('lane-processing')).toBeTruthy()
    expect(screen.getByTestId('lane-verifying')).toBeTruthy()
    expect(screen.getByTestId('lane-finished')).toBeTruthy()
    expect(screen.getByText('排队任务')).toBeTruthy()
    expect(screen.getByText('执行中任务')).toBeTruthy()
    expect(screen.getByText('完成任务')).toBeTruthy()
    expect(screen.getByText('创建 hello.txt')).toBeTruthy()
    expect(screen.getByText(/\/tmp\/a1/)).toBeTruthy()
  })

  it('统计卡组显示计数(排队1/执行中1/已完成1/失败1;verifying 0)', () => {
    setBuckets()
    render(<SuperTaskPanel />)
    const q = within(screen.getByTestId('stat-queued'))
    expect(q.getByText('排队')).toBeTruthy()
    expect(q.getByText('1')).toBeTruthy()
    const f = within(screen.getByTestId('stat-failed'))
    expect(f.getByText('失败 ⚠')).toBeTruthy()
    expect(f.getByText('1')).toBeTruthy()
    const d = within(screen.getByTestId('stat-done'))
    expect(d.getByText('已完成')).toBeTruthy()
    // 新增 verifying 卡存在且显示「验证中」(2026-09-02)
    const v = within(screen.getByTestId('stat-verifying'))
    expect(v.getByText('验证中')).toBeTruthy()
    expect(v.getByText('0')).toBeTruthy()
  })

  it('点击筛选卡后非命中任务卡片降透明度，再点恢复', () => {
    setBuckets()
    render(<SuperTaskPanel />)
    const doneCard = screen.getByTestId('card-tf-q') // 排队任务卡片
    // 点「已完成」卡 → 排队任务降透明且不可点
    fireEvent.click(screen.getByTestId('stat-done'))
    expect(doneCard.style.opacity).toBe('0.35')
    expect(doneCard.style.pointerEvents).toBe('none')
    // 清除筛选 → 恢复
    fireEvent.click(screen.getByTestId('stat-done'))
    expect(doneCard.style.opacity).toBe('1')
  })

  it('verifying 栏存在且显示验证中任务(2026-09-02 新增)', () => {
    useSuperTaskStore.setState({
      buckets: {
        queue: [],
        processing: [],
        verifying: [{ id: 'tf-v', title: '验证中任务', status: 'verifying', cwd: '/tmp/v1', bucket: 'verifying-tasks' }],
        finished: [],
      },
      managed: false, loading: false, error: null,
    })
    render(<SuperTaskPanel />)
    const lane = screen.getByTestId('lane-verifying')
    expect(lane.textContent).toContain('验证中')
    expect(lane.textContent).toContain('验证中任务')
    // 验证中任务显示「强制通过」按钮
    expect(within(lane).getByRole('button', { name: /强制通过/ })).toBeTruthy()
    // verifying 栏删除按钮被禁用
    expect(screen.getByTestId('delete-selected-verifying').hasAttribute('disabled')).toBe(true)
  })

  it('勾选卡片后删除按钮对选中任务调 store.deleteTasks', async () => {
    const del = vi.spyOn(useSuperTaskStore.getState(), 'deleteTasks').mockResolvedValue(undefined)
    setBuckets()
    render(<SuperTaskPanel />)
    const card = screen.getByTestId('card-tf-q')
    const cb = card.querySelector('.ant-checkbox-input') as HTMLInputElement
    expect(cb).toBeTruthy()
    fireEvent.click(cb)
    fireEvent.click(screen.getByTestId('delete-selected-queue'))
    await vi.waitFor(() => {
      expect(document.querySelector('.ant-popover-content')).toBeTruthy()
    })
    // AntD 默认 okText 在没有 ConfigProvider(zhCN) 时回退到 'OK'
    const okBtn = document.querySelector('.ant-popover-content button.ant-btn-primary') as HTMLButtonElement
    expect(okBtn).toBeTruthy()
    fireEvent.click(okBtn)
    await vi.waitFor(() => {
      expect(del).toHaveBeenCalledWith(['tf-q'])
    })
    del.mockRestore()
  })
})