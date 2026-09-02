import { useMemo, useState } from 'react'
import { Button, Checkbox, Popconfirm, Tooltip, message } from 'antd'
import { DeleteOutlined } from '@ant-design/icons'
import { useSuperTaskStore } from '../../store/useSuperTaskStore'
import type { TaskSummary } from '../../lib/superTaskApi'
import NewSuperTaskModal from './NewSuperTaskModal'
import SuperTaskDetailDrawer from './SuperTaskDetailDrawer'
import SuperTaskCard from './SuperTaskCard'
import TaskOverviewBar, { matchFilter, type SuperTaskFilter } from './TaskOverviewBar'

/**
 * SuperTaskPanel — 看板式任务面板（kanban）。
 *
 * 顶部 TaskOverviewBar(总览统计卡组 + AI 托管 Switch + 新建任务),下方三栏看板:
 * 队列 / 执行中 / 已完成。每栏:栏头(计数 + 全选 + 删除选中 N,processing 桶删除禁用)
 * + 纵向卡片列表。卡片点击开详情抽屉;筛选态由 TaskOverviewBar 控制,非命中卡片降透明。
 *
 * 数据加载 + 3s 轮询由父组件 SuperTasks.tsx 统一驱动,本组件不重复触发。
 */

export type BucketKey = 'queue' | 'processing' | 'finished'

const LANE_TITLE: Record<BucketKey, string> = { queue: '队列', processing: '执行中', finished: '已完成' }

/** 栏头配色(亮色化,用户 2026-09-01)。 */
const LANE_COLOR: Record<BucketKey, string> = {
  queue: '#3b82f6',
  processing: '#a855f7',
  finished: '#22c55e',
}

export default function SuperTaskPanel(): JSX.Element {
  const buckets = useSuperTaskStore((s) => s.buckets)
  const loading = useSuperTaskStore((s) => s.loading)
  const loadedOnce = useSuperTaskStore((s) => s.loadedOnce)

  const [selected, setSelected] = useState<Record<BucketKey, string[]>>({
    queue: [], processing: [], finished: [],
  })
  const [newModalOpen, setNewModalOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [filter, setFilter] = useState<SuperTaskFilter>('all')

  const isEmpty = useMemo(
    () => buckets.queue.length === 0 && buckets.processing.length === 0 && buckets.finished.length === 0,
    [buckets],
  )

  async function handleDelete(key: BucketKey): Promise<void> {
    const ids = selected[key]
    if (ids.length === 0) return
    try {
      await useSuperTaskStore.getState().deleteTasks(ids)
      setSelected((p) => ({ ...p, [key]: [] }))
    } catch (err) {
      message.error(err instanceof Error ? err.message : '删除失败')
    }
  }

  function toggleSelect(key: BucketKey, id: string, checked: boolean): void {
    setSelected((p) => ({
      ...p,
      [key]: checked ? [...p[key], id] : p[key].filter((x) => x !== id),
    }))
  }

  function toggleSelectAll(key: BucketKey, rows: TaskSummary[], checked: boolean): void {
    setSelected((p) => ({ ...p, [key]: checked ? rows.map((r) => r.id) : [] }))
  }

  function renderLane(key: BucketKey, rows: TaskSummary[], canDelete: boolean): JSX.Element {
    const sel = selected[key]
    const allSelected = rows.length > 0 && sel.length === rows.length
    const someSelected = sel.length > 0 && !allSelected
    const laneColor = LANE_COLOR[key]
    return (
      <div
        data-testid={`lane-${key}`}
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          background: '#f8fafc',
          border: '1px solid #e5e9f0',
          borderRadius: 12,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            borderBottom: '1px solid #e5e9f0',
            flexWrap: 'wrap',
          }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: laneColor,
              flexShrink: 0,
            }}
          />
          <span style={{ fontWeight: 600, color: laneColor }}>{LANE_TITLE[key]}</span>
          <span
            style={{
              fontSize: 12,
              color: '#64748b',
              background: '#eef2f7',
              borderRadius: 999,
              padding: '0 8px',
              lineHeight: '18px',
            }}
          >
            {rows.length}
          </span>
          <div style={{ flex: 1 }} />
          <Checkbox
            checked={allSelected}
            indeterminate={someSelected}
            onChange={(e) => toggleSelectAll(key, rows, e.target.checked)}
            aria-label={`全选${LANE_TITLE[key]}`}
          />
          {canDelete ? (
            <Popconfirm
              title={`删除选中的 ${sel.length} 个任务?`}
              okText="确定"
              cancelText="取消"
              onConfirm={() => void handleDelete(key)}
            >
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                disabled={sel.length === 0}
                data-testid={`delete-selected-${key}`}
              >
                删除选中
              </Button>
            </Popconfirm>
          ) : (
            <Tooltip title="进行中任务需先暂停才能删除">
              <Button size="small" danger icon={<DeleteOutlined />} disabled>
                删除选中
              </Button>
            </Tooltip>
          )}
        </div>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          {rows.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-tertiary, #999)', padding: '24px 0', fontSize: 13 }}>
              暂无任务
            </div>
          ) : (
            rows.map((t) => (
              <SuperTaskCard
                key={t.id}
                task={t}
                selected={sel.includes(t.id)}
                onToggleSelect={(checked) => toggleSelect(key, t.id, checked)}
                dimmed={!matchFilter(t, filter)}
                onOpenDetail={setDetailId}
                onDeleted={(id) => toggleSelect(key, id, false)}
              />
            ))
          )}
        </div>
      </div>
    )
  }

  // 首载判定:仅当「从未成功加载过 + 桶全空 + 正在加载」→ lanes 区占位(父级
  // Spin 覆盖)。3s 轮询每轮都会置 loading,必须用 loadedOnce 过滤,否则空看板
  // 每 3s 闪一次(2026-09-02 修)。
  // 注意:顶栏 / 新建任务弹窗 / 详情抽屉**不能**随该条件一起挂载 ——
  // NewSuperTaskModal 现在承载对话状态(intake sid、草稿选择),轮询导致的
  // 卸载重挂会让 [open] effect 重跑,把对话窗口重置回草稿提示甚至瞬时消失。
  const showLanes = !(loading && isEmpty && !loadedOnce)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%', minHeight: 0 }}>
      <TaskOverviewBar filter={filter} onFilterChange={setFilter} onNewTask={() => setNewModalOpen(true)} />
      {showLanes ? (
        <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0, alignItems: 'stretch' }}>
          {renderLane('queue', buckets.queue, true)}
          {renderLane('processing', buckets.processing, false)}
          {renderLane('finished', buckets.finished, true)}
        </div>
      ) : (
        <div style={{ padding: 24, textAlign: 'center' }} />
      )}
      <NewSuperTaskModal open={newModalOpen} onClose={() => setNewModalOpen(false)} />
      <SuperTaskDetailDrawer taskId={detailId} onClose={() => setDetailId(null)} />
    </div>
  )
}