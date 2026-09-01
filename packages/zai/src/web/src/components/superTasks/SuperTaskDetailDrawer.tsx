import { useEffect, useState } from 'react'
import { Drawer, Tabs, Typography, Spin, Timeline } from 'antd'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { fetchSuperTaskDetail } from '../../lib/superTaskApi'
import { subscribeTaskEvents } from '../../lib/taskApi'
import type { TaskDetails } from '../../lib/superTaskApi'

/** 执行过程事件帧（taskApi.subscribeTaskEvents 产出，字段对齐 taskApi.SseFrame）。 */
interface EventFrame {
  id: string | number
  event: string
  data: Record<string, unknown> | null
}

/**
 * SuperTaskDetailDrawer — 任务详情抽屉（Task 10）。
 *
 * 抽屉打开后拉取任务详情（/api/super-tasks/:id），并在 open 期间每 3s 轮询
 * 刷新（process.md 增量追加）。任务已派生执行子 Agent（index.md 的
 * executorTaskId）时，执行过程 Tab 通过 `/api/tasks/:id/events` 订阅执行器
 * 的工具调用与消息流，缓冲最近 200 帧。
 */
export default function SuperTaskDetailDrawer({
  taskId,
  onClose,
}: {
  taskId: string | null
  onClose: () => void
}): JSX.Element {
  const [detail, setDetail] = useState<TaskDetails | null>(null)
  const [events, setEvents] = useState<EventFrame[]>([])

  // 详情拉取 + 3s 轮询（抽屉 open 期间持续刷新 process.md / spec.md / plan.md）
  useEffect(() => {
    if (!taskId) {
      setDetail(null)
      setEvents([])
      return
    }
    let cancelled = false
    setDetail(null)
    setEvents([])
    const load = async (): Promise<void> => {
      try {
        const d = await fetchSuperTaskDetail(taskId)
        if (!cancelled) setDetail(d)
      } catch {
        if (!cancelled) setDetail(null)
      }
    }
    void load()
    const pollId = window.setInterval(() => void load(), 3000)
    return () => {
      cancelled = true
      window.clearInterval(pollId)
    }
  }, [taskId])

  // executor 存在时订阅执行器事件流；executorTaskId 可能晚于首帧详情出现
  // （任务先创建、后派发执行子 Agent），因此以 detail 变化驱动订阅。
  const executorId = detail?.summary.executorTaskId ?? null
  useEffect(() => {
    if (!executorId) {
      setEvents([])
      return
    }
    const ctrl = new AbortController()
    const run = async (): Promise<void> => {
      try {
        for await (const frame of subscribeTaskEvents(executorId, 0, ctrl.signal)) {
          setEvents((p) => [...p, frame as EventFrame].slice(-200))
        }
      } catch {
        // abort / 流结束静默
      }
    }
    void run()
    return () => ctrl.abort()
  }, [executorId])

  return (
    <Drawer
      open={taskId != null}
      onClose={onClose}
      width={720}
      title={detail ? `任务 ${detail.summary.id}` : '任务详情'}
    >
      {!detail ? (
        <Spin />
      ) : (
        <>
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            {detail.summary.title}
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
            状态：{detail.summary.status} · Agent：{detail.summary.agent ?? 'default'}
            {detail.summary.executorTaskId ? ` · 执行任务：${detail.summary.executorTaskId}` : ''}
          </Typography.Paragraph>
          <Tabs
            items={[
              {
                key: 'process',
                label: '执行过程',
                children: detail.summary.executorTaskId ? (
                  events.length > 0 ? (
                    <Timeline
                      items={events.map((e) => {
                        // e.data 来自 SSE 事件负载，可能是非对象原始值——先归一化为对象再取字段
                        const data =
                          e.data !== null && typeof e.data === 'object'
                            ? (e.data as Record<string, unknown>)
                            : null
                        return {
                          key: String(e.id),
                          color:
                            data?.status === 'completed'
                              ? 'green'
                              : data?.status === 'error'
                                ? 'red'
                                : 'blue',
                          children: `${String(e.event)} · ${String(
                            data?.description ?? JSON.stringify(e.data ?? {}).slice(0, 120),
                          )}`,
                        }
                      })}
                    />
                  ) : (
                    <Typography.Text type="secondary">等待执行事件…</Typography.Text>
                  )
                ) : (
                  <Typography.Text type="secondary">尚未派生执行子 Agent</Typography.Text>
                ),
              },
              {
                key: 'spec',
                label: 'spec.md',
                children: <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.specMd ?? ''}</ReactMarkdown>,
              },
              {
                key: 'plan',
                label: 'plan.md',
                children: <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.planMd ?? ''}</ReactMarkdown>,
              },
              {
                key: 'processMd',
                label: 'process.md',
                children: <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.processMd ?? ''}</ReactMarkdown>,
              },
            ]}
          />
        </>
      )}
    </Drawer>
  )
}