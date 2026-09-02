import { Button, Popconfirm, Space, Switch, Tooltip, message } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { useSuperTaskStore } from '../../store/useSuperTaskStore'

/** 看板筛选维度。'all' 不筛选；其余按任务 status 匹配。 */
export type SuperTaskFilter = 'all' | 'queued' | 'processing' | 'verifying' | 'done' | 'failed'

const STAT_KEYS: Array<{ key: Exclude<SuperTaskFilter, 'all'>; label: string; danger?: boolean }> = [
  { key: 'queued', label: '排队' },
  { key: 'processing', label: '执行中' },
  { key: 'verifying', label: '验证中' },
  { key: 'done', label: '已完成' },
  { key: 'failed', label: '失败', danger: true },
]

/** 统计卡配色(亮色化,用户 2026-09-01;verifying 加青色 2026-09-02)。 */
const STAT_COLORS: Record<Exclude<SuperTaskFilter, 'all'>, { bg: string; border: string; text: string }> = {
  queued: { bg: '#e8f1ff', border: '#93c5fd', text: '#1d4ed8' },
  processing: { bg: '#f3e8ff', border: '#d8b4fe', text: '#7e22ce' },
  verifying: { bg: '#ecfeff', border: '#67e8f9', text: '#0e7490' },
  done: { bg: '#e6f7ed', border: '#86efac', text: '#15803d' },
  failed: { bg: '#fdecec', border: '#fca5a5', text: '#dc2626' },
}

/** 单条任务是否命中筛选。 */
export function matchFilter(t: { status: string }, filter: SuperTaskFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'processing') return t.status === 'processing' || t.status === 'paused'
  if (filter === 'verifying') return t.status === 'verifying'
  return t.status === filter
}

export interface TaskOverviewBarProps {
  filter: SuperTaskFilter
  onFilterChange: (f: SuperTaskFilter) => void
  onNewTask: () => void
}

/**
 * 总览统计卡组 + 操作条(看板顶部)。
 *
 * - 五张统计卡(排队/执行中/验证中/已完成/失败⚠)点击筛选:再点取消;筛选态显示「清除筛选」。
 * - 右侧:AI 托管 Switch / 新建任务 / loading「刷新中…」。
 *
 * 数据源 = useSuperTaskStore.buckets(3s 轮询驱动,无新请求)。
 */
export default function TaskOverviewBar({ filter, onFilterChange, onNewTask }: TaskOverviewBarProps): JSX.Element {
  const buckets = useSuperTaskStore((s) => s.buckets)
  const managed = useSuperTaskStore((s) => s.managed)
  const loading = useSuperTaskStore((s) => s.loading)
  const setManaged = useSuperTaskStore((s) => s.setManaged)
  const resetSupervisorSession = useSuperTaskStore((s) => s.resetSupervisorSession)

  const allTasks = [...buckets.queue, ...buckets.processing, ...buckets.verifying, ...buckets.finished]
  const counts: Record<Exclude<SuperTaskFilter, 'all'>, number> = {
    queued: buckets.queue.length,
    processing: buckets.processing.length,
    verifying: buckets.verifying.length,
    done: buckets.finished.filter((t) => t.status === 'done').length,
    failed: allTasks.filter((t) => t.status === 'failed').length,
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
      <Space size={8} wrap>
        {STAT_KEYS.map((s) => {
          const active = filter === s.key
          const c = STAT_COLORS[s.key]
          return (
            <div
              key={s.key}
              data-testid={`stat-${s.key}`}
              onClick={() => onFilterChange(active ? 'all' : s.key)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                minWidth: 72,
                padding: '6px 18px',
                borderRadius: 8,
                border: active ? `2px solid ${c.border}` : `1px solid ${c.border}`,
                background: c.bg,
                cursor: 'pointer',
                opacity: filter !== 'all' && !active ? 0.45 : 1,
                transition: 'opacity .15s ease',
              }}
              title={`点击${active ? '取消' : ''}筛选「${s.label}」`}
            >
              <span style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.2, color: c.text }}>
                {counts[s.key]}
              </span>
              <span style={{ fontSize: 12, color: s.danger && counts[s.key] > 0 ? c.text : 'var(--text-secondary, #666)' }}>
                {s.label}
                {s.danger && counts[s.key] > 0 ? ' ⚠' : ''}
              </span>
            </div>
          )
        })}
        {filter !== 'all' && (
          <Button size="small" type="link" onClick={() => onFilterChange('all')}>
            ✕ 清除筛选
          </Button>
        )}
      </Space>
      <Space wrap>
        <Tooltip title="开启后由后端托管循环自动派发/验收">
          <Switch
            checked={managed}
            onChange={async (v) => {
              try {
                await setManaged(v)
              } catch {
                message.error('AI 托管切换失败')
              }
            }}
            checkedChildren="AI 托管开"
            unCheckedChildren="AI 托管关"
          />
        </Tooltip>
        {/*
          重置主管会话(2026-09-02):清 state.json.supervisorSessionId +
          同步关托管,然后 reload 触发 mount 引导重建一条新的空主管会话。
          旧 transcript 保留在磁盘,与新主管不再关联 — 这是产品决策,
          不是 bug。Popconfirm 二次确认防误点(参考 SuperTaskCard 删除
          任务的同款 UI 惯例)。
        */}
        <Popconfirm
          title="重置主管会话?"
          description={
            <span>
              将创建一条新的空主管会话替换当前对话。
              <br />
              旧的 transcript 文件保留在 <code>~/.zai/tasks/</code> 与新主管不再关联。
            </span>
          }
          okText="重置"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={async () => {
            try {
              await resetSupervisorSession()
              // 全局 reload — 让 store / 看板 / 主管 transcript 干净同步
              window.location.reload()
            } catch (err) {
              message.error(
                `重置失败: ${err instanceof Error ? err.message : String(err)}`,
              )
            }
          }}
        >
          <Tooltip title="清空当前主管会话,触发全新引导">
            <Button icon={<ReloadOutlined />} data-testid="reset-supervisor-button">
              重置会话
            </Button>
          </Tooltip>
        </Popconfirm>
        <Button type="primary" onClick={onNewTask} data-testid="new-task-button">
          新建任务
        </Button>
        {loading && <span style={{ color: 'var(--text-secondary, #666)' }}>刷新中…</span>}
      </Space>
    </div>
  )
}