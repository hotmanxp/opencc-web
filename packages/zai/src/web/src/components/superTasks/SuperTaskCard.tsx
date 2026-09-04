import { createElement, type JSX } from 'react'
import { Button, Checkbox, Popconfirm, Space, Tag, Tooltip } from 'antd'
import { DeleteOutlined, PlayCircleOutlined, PauseCircleOutlined } from '@ant-design/icons'
import type { TaskSummary } from '../../lib/superTaskApi'
import { useSuperTaskStore } from '../../store/useSuperTaskStore'

/** 火柴人动画(2026-09-02,任务工厂动感增强)。
 *
 * processing 卡片显示"工作中"小人:右臂大幅挥动持锤子、左腿/右腿交替抬步;
 * verifying 卡片显示"检查中"小人:右臂举放大镜左右扫视、头微微点头。
 * 用 SVG SMIL `<animateTransform>` 直接驱动关节旋转(无需 `transform-origin`,
 * 跨 Chromium / Firefox / WebKit 表现一致)。JSX 不直接支持未知标签会报警告,
 * 用 createElement 显式构造可消除 warning。
 */
function WorkingStickman({ status }: { status: 'processing' | 'verifying' }): JSX.Element {
  const isWorking = status === 'processing'
  const color = isWorking ? '#a855f7' : '#06b6d4'
  const title = isWorking ? '任务执行中' : '任务验证中'
  // 旋转中心统一为关节:右臂 (11,8) 肩;腿 (11,13) 胯。
  const armRotation = isWorking
    ? '0 11 8; -55 11 8; 0 11 8; 30 11 8; 0 11 8'   // 工作: 上下挥动
    : '0 11 8; 10 11 8; 0 11 8; -10 11 8; 0 11 8'    // 检查: 左右扫视
  const legL = isWorking ? '0 11 13; -22 11 13; 22 11 13; 0 11 13' : '0 11 13'
  const legR = isWorking ? '0 11 13; 22 11 13; -22 11 13; 0 11 13' : '0 11 13'
  const headNod = isWorking ? '0 0; 0 -0.6; 0 0' : '0 0; 0 0.6; 0 0'
  const headDur = isWorking ? '0.6s' : '1s'
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      data-testid={`stickman-${status}`}
      style={{
        color,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        width: 22,
        height: 22,
      }}
    >
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
        {/* 头(执行中随身体弹,验证中微微点头) */}
        {createElement('g', null,
          createElement('animateTransform', {
            attributeName: 'transform', type: 'translate',
            values: headNod, dur: headDur, repeatCount: 'indefinite',
          }),
          createElement('circle', {
            cx: 11, cy: 4, r: 1.8,
            stroke: 'currentColor', strokeWidth: 1.4, fill: 'none',
          }),
        )}
        {/* 身体 */}
        <line
          x1={11} y1={5.8} x2={11} y2={13}
          stroke="currentColor" strokeWidth={1.4} strokeLinecap="round"
        />
        {/* 左臂(静止) */}
        <line
          x1={11} y1={8} x2={7.5} y2={11}
          stroke="currentColor" strokeWidth={1.4} strokeLinecap="round"
        />
        {/* 右臂 + 工具(挥动/扫视) */}
        {createElement('g', null,
          createElement('animateTransform', {
            attributeName: 'transform', type: 'rotate',
            values: armRotation, dur: '0.6s', repeatCount: 'indefinite',
          }),
          // 手臂
          createElement('line', {
            x1: 11, y1: 8, x2: 14.5, y2: 11,
            stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
          }),
          // 工具: 锤子(工作中)/ 放大镜(验证中)
          isWorking
            ? createElement('rect', {
                x: 14, y: 9, width: 3.5, height: 2,
                fill: 'currentColor', rx: 0.3,
              })
            : createElement('circle', {
                cx: 17, cy: 10.5, r: 2.2,
                stroke: 'currentColor', strokeWidth: 1.2, fill: 'none',
              }),
        )}
        {/* 左腿 */}
        {createElement('g', null,
          createElement('animateTransform', {
            attributeName: 'transform', type: 'rotate',
            values: legL, dur: '0.5s', repeatCount: 'indefinite',
          }),
          createElement('line', {
            x1: 11, y1: 13, x2: 8, y2: 18,
            stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
          }),
        )}
        {/* 右腿 */}
        {createElement('g', null,
          createElement('animateTransform', {
            attributeName: 'transform', type: 'rotate',
            values: legR, dur: '0.5s', repeatCount: 'indefinite',
          }),
          createElement('line', {
            x1: 11, y1: 13, x2: 14, y2: 18,
            stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
          }),
        )}
      </svg>
    </span>
  )
}

/** 状态 Tag 配色 + 文案。2026-09-04 起 export 出来供移动端 MobileSuperTaskCard 复用。 */
export const STATUS_TAG: Record<string, { color: string; label: string }> = {
  queued: { color: 'default', label: '排队' },
  processing: { color: 'purple', label: '执行中' },
  paused: { color: 'warning', label: '已暂停' },
  verifying: { color: 'cyan', label: '验证中' },
  done: { color: 'success', label: '完成' },
  failed: { color: 'error', label: '失败' },
}

/** 调度优先级 Tag 配色(zai patch 2026-09-02):P0 红、P1 橙、P2 蓝、P3 灰。
 *  AntD Tag `color` 接受预设关键字 + hex;P0 用 red、P1 用 orange 走预设,
 *  P2 走 blue 预设,P3 走 default(灰)。2026-09-04 起 export 出来供移动端复用。 */
export const PRIORITY_TAG: Record<string, { color: string; label: string }> = {
  P0: { color: 'red', label: 'P0 紧急' },
  P1: { color: 'orange', label: 'P1 高' },
  P2: { color: 'blue', label: 'P2 普通' },
  P3: { color: 'default', label: 'P3 低' },
}

/** 卡片左侧状态色条(亮色化,用户 2026-09-01;verifying 加青色 2026-09-02)。
 *  2026-09-04 起 export 出来供移动端 MobileSuperTaskCard 复用。 */
export const STATUS_ACCENT: Record<string, string> = {
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
          {/* zai patch (2026-09-02, priority Tag): P0 红 / P1 橙 / P2 蓝 / P3 灰。
              缺省 P2 也显示,让用户一眼看清调度排序。dependsOn 非空时附 tooltip。 */}
          {task.priority && (
            <Tooltip
              title={
                task.dependsOn && task.dependsOn.length > 0
                  ? `${PRIORITY_TAG[task.priority]?.label ?? task.priority} · 依赖 ${task.dependsOn.length} 个任务(${task.dependsOn.join(', ')})`
                  : PRIORITY_TAG[task.priority]?.label ?? task.priority
              }
            >
              <Tag
                color={PRIORITY_TAG[task.priority]?.color ?? 'default'}
                style={{ marginInlineEnd: 0 }}
                data-priority={task.priority}
                data-testid={`priority-${task.id}`}
              >
                {task.priority}
              </Tag>
            </Tooltip>
          )}
          {task.agent && task.agent !== 'default' && <Tag style={{ marginInlineEnd: 0 }}>{task.agent}</Tag>}
          {/* 火柴人动画(2026-09-02):仅 processing 桶(且 status=processing) 与 verifying 桶显示,
              paused / done / failed / queued 都不动。放在 Space 末尾让"状态指示群"视觉对齐。 */}
          {(inProcessing && task.status === 'processing') || inVerifying ? (
            <WorkingStickman status={inVerifying ? 'verifying' : 'processing'} />
          ) : null}
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