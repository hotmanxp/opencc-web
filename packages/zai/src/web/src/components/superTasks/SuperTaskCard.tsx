import { Button, Checkbox, Popconfirm, Space, Tag, Tooltip } from 'antd'
import { DeleteOutlined, PlayCircleOutlined, PauseCircleOutlined } from '@ant-design/icons'
import type { TaskSummary } from '../../lib/superTaskApi'
import { useSuperTaskStore } from '../../store/useSuperTaskStore'

const STATUS_TAG: Record<string, { color: string; label: string }> = {
  queued: { color: 'default', label: '排队' },
  processing: { color: 'purple', label: '执行中' },
  paused: { color: 'warning', label: '已暂停' },
  verifying: { color: 'cyan', label: '验证中' },
  done: { color: 'success', label: '完成' },
  failed: { color: 'error', label: '失败' },
}

/** 卡片左侧状态色条(亮色化,用户 2026-09-01;verifying 加青色 2026-09-02)。 */
const STATUS_ACCENT: Record<string, string> = {
  queued: '#3b82f6',
  processing: '#a855f7',
  paused: '#f59e0b',
  verifying: '#06b6d4',
  done: '#22c55e',
  failed: '#ef4444',
}

export interface SuperTaskCardProps {
  task: TaskSummary
  selected: boolean
  onToggleSelect: (checked: boolean) => void
  dimmed: boolean
  /** 详情抽屉打开(整卡点击)。 */
  onOpenDetail: (id: string) => void
  /** 单卡删除成功后的回调(清理所选集等)。 */
  onDeleted: (id: string) => void
}

const stop = (e: React.MouseEvent | React.ChangeEvent): void => e.stopPropagation()

/**
 * 看板单任务信息卡。
 *
 * 标题 + 状态Tag + agent Tag / 描述 2 行截断 / cwd / 创建时间 + 常显操作按钮。
 * 操作按 bucket+status(2026-09-02 加 verifying 桶):
 * - queue→▶启动
 * - processing+processing→⏸暂停+验收
 * - processing+paused→▶继续
 * - verifying→强制通过(跳过 verifier 直接 MarkDone)
 * 单卡 🗑 删除(Popconfirm;processing/verifying 桶禁用含 paused)。卡片点击开详情抽屉。
 */
export default function SuperTaskCard({
  task, selected, onToggleSelect, dimmed, onOpenDetail, onDeleted,
}: SuperTaskCardProps): JSX.Element {
  const { start, pause, resume, accept, deleteTasks } = useSuperTaskStore.getState()
  const tag = STATUS_TAG[task.status] ?? { color: 'default', label: task.status }
  const accent = STATUS_ACCENT[task.status] ?? '#9ca3af'
  const inProcessing = task.bucket === 'processing-tasks'
  const inVerifying = task.bucket === 'verifying-tasks'
  // verifying 桶显示强制通过按钮(替代普通验收);processing+processing 显示验收 + 暂停
  const showAccept = inProcessing || inVerifying
  const showPause = inProcessing && task.status === 'processing'
  const showResume = inProcessing && task.status === 'paused'

  async function handleDelete(): Promise<void> {
    try {
      await deleteTasks([task.id])
      onDeleted(task.id)
    } catch (err) {
      // 删除失败由 store 抛错,这里静默(顶部统计不受影响);面板不展示 toast 依赖现有链路
      void err
    }
  }

  return (
    <div
      data-detail-id={task.id}
      data-testid={`card-${task.id}`}
      onClick={() => onOpenDetail(task.id)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '10px 12px',
        borderRadius: 10,
        background: '#ffffff',
        border: '1px solid #e5e9f0',
        borderLeft: `4px solid ${accent}`,
        boxShadow: '0 1px 3px rgba(15,23,42,.06)',
        cursor: 'pointer',
        opacity: dimmed ? 0.35 : 1,
        pointerEvents: dimmed ? 'none' : 'auto',
        transition: 'opacity .15s ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div onClick={stop} onMouseDown={stop}>
          <Checkbox
            checked={selected}
            onChange={(e) => onToggleSelect(e.target.checked)}
            aria-label={`选择任务 ${task.title}`}
          />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              // 2026-09-02 task.yaml 化后,title 改为 task.yaml 顶层字段,
              // 卡片上让它更醒目一点:稍大字号 + 字色更深 + 收紧字间距。
              fontSize: 14,
              lineHeight: 1.4,
              fontWeight: 600,
              color: '#0f172a',
              letterSpacing: 0.1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={task.title}
          >
            {task.title}
          </div>
        </div>
        <Space size={4} style={{ flexShrink: 0 }}>
          <Tag color={tag.color} style={{ marginInlineEnd: 0 }}>
            {tag.label}
          </Tag>
          {task.agent && task.agent !== 'default' && <Tag style={{ marginInlineEnd: 0 }}>{task.agent}</Tag>}
        </Space>
      </div>

      {task.description ? (
        <div
          style={{
            fontSize: 12,
            color: 'var(--text-secondary, #666)',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {task.description}
        </div>
      ) : null}

      <div
        style={{
          fontSize: 12,
          color: 'var(--text-secondary, #666)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={task.cwd}
      >
        📎 {task.cwd}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--text-tertiary, #999)' }}>
          {task.createdAt ? new Date(task.createdAt).toLocaleString() : '-'}
        </span>
        <Space size={4}>
          {task.bucket === 'queue-tasks' && (
            <Tooltip title="手工启动">
              <Button
                size="small"
                icon={<PlayCircleOutlined />}
                onClick={(e) => { stop(e); void start(task.id) }}
              />
            </Tooltip>
          )}
          {showPause && (
            <>
              <Tooltip title="暂停">
                <Button
                  size="small"
                  icon={<PauseCircleOutlined />}
                  onClick={(e) => { stop(e); void pause(task.id) }}
                />
              </Tooltip>
              <Tooltip title="人工验收">
                <Button size="small" onClick={(e) => { stop(e); void accept(task.id) }}>
                  验收
                </Button>
              </Tooltip>
            </>
          )}
          {showResume && (
            <Tooltip title="继续">
              <Button
                size="small"
                icon={<PlayCircleOutlined />}
                onClick={(e) => { stop(e); void resume(task.id) }}
              />
            </Tooltip>
          )}
          {inVerifying && (
            <Tooltip title="跳过 verifier 直接归档(强制通过)">
              <Button size="small" type="primary" onClick={(e) => { stop(e); void accept(task.id) }}>
                强制通过
              </Button>
            </Tooltip>
          )}
          {inProcessing ? (
            <Tooltip title="进行中任务需先暂停才能删除">
              <Button size="small" danger icon={<DeleteOutlined />} disabled onClick={stop} />
            </Tooltip>
          ) : inVerifying ? (
            <Tooltip title="验证中任务不可删除(等待 verifier 结论或强制通过)">
              <Button size="small" danger icon={<DeleteOutlined />} disabled onClick={stop} />
            </Tooltip>
          ) : (
            <Popconfirm
              title={`删除任务「${task.title}」？`}
              okText="确定"
              cancelText="取消"
              onConfirm={() => void handleDelete()}
            >
              <Tooltip title="删除任务">
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={stop}
                />
              </Tooltip>
            </Popconfirm>
          )}
        </Space>
      </div>
    </div>
  )
}