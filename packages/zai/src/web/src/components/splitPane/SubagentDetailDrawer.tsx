/**
 * dsh-019 Phase 3: dsh-mode subagent 任务详情 Drawer 薄壳。
 *
 * 只负责 Drawer 外壳 + header status tag + reload / interrupt 操作栏。
 * 实际 fetch / 渲染逻辑全部在 `SubagentDetailBody` 里(TaskDrawer 也复用
 * 该 Body,避免 Drawer 套 Drawer)。
 *
 * header 的 status tag 从 `useAgentStore.subagentTasksBySession` 读(SSE
 * 推送,实时刷新);Reload 按钮递增 `reloadSignal` state 触发 Body 重 fetch。
 */

import { useState } from 'react'
import { Button, Drawer, Tag, Tooltip } from 'antd'
import {
  CheckCircleFilled,
  CloseCircleFilled,
  LoadingOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons'
import { useAgentStore } from '../../store/useAgentStore.js'
import { SubagentDetailBody, type SubagentDetail } from './SubagentDetailBody.js'

const STATUS_COLOR: Record<SubagentDetail['status'], string> = {
  running: 'processing',
  done: 'success',
  failed: 'error',
  cancelled: 'default',
}

const STATUS_LABEL: Record<SubagentDetail['status'], string> = {
  running: '运行中',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
}

const STATUS_ICON: Record<SubagentDetail['status'], JSX.Element> = {
  running: <LoadingOutlined style={{ color: 'var(--accent-start)' }} spin />,
  done: <CheckCircleFilled style={{ color: 'var(--success)' }} />,
  failed: <CloseCircleFilled style={{ color: 'var(--error)' }} />,
  cancelled: <CloseCircleFilled style={{ color: 'var(--ui-text-color)' }} />,
}

// Antd Space helper (避免在文件顶层再 import)
function Space({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'inline-flex', gap: 8 }}>{children}</div>
}

export function SubagentDetailDrawer({
  taskId,
  onClose,
  onInterrupt,
  busy,
}: {
  taskId: string | null
  onClose: () => void
  onInterrupt: (id: string) => void
  busy: string | null
}) {
  const isBusy = busy === taskId
  // 从 store 读 status — SSE 100% 推送,实时刷新。
  const status = useAgentStore((s) => {
    if (!taskId) return undefined
    for (const sid of Object.keys(s.subagentTasksBySession)) {
      const t = s.subagentTasksBySession[sid]?.find((task) => task.id === taskId)
      if (t) return t.status as SubagentDetail['status']
    }
    return undefined
  })
  const isRunning = status === 'running'

  // Reload 触发器 — 递增时让 Body 重 fetch
  const [reloadSignal, setReloadSignal] = useState(0)

  return (
    <Drawer
      title={
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>Agent 详情</span>
          {status && (
            <Tag color={STATUS_COLOR[status]} icon={STATUS_ICON[status]}>
              {STATUS_LABEL[status]}
            </Tag>
          )}
        </span>
      }
      placement="right"
      width={520}
      open={!!taskId}
      onClose={onClose}
      destroyOnClose
      extra={
        <Space>
          <Tooltip title="重新拉取">
            <Button
              size="small"
              type="text"
              icon={<ReloadOutlined />}
              onClick={() => setReloadSignal((n) => n + 1)}
            />
          </Tooltip>
          {isRunning && (
            <Tooltip title="中断这个子 agent 任务">
              <Button
                size="small"
                danger
                icon={isBusy ? <LoadingOutlined spin /> : <StopOutlined />}
                disabled={isBusy}
                loading={isBusy}
                onClick={() => taskId && onInterrupt(taskId)}
              >
                Interrupt
              </Button>
            </Tooltip>
          )}
        </Space>
      }
    >
      {taskId && <SubagentDetailBody taskId={taskId} reloadSignal={reloadSignal} />}
    </Drawer>
  )
}
