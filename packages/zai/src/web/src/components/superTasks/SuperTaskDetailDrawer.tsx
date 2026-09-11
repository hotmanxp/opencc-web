import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Drawer, Empty, Space, Tabs, Tag, Typography, Spin, Timeline, Collapse } from 'antd'
import type { CSSProperties } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MarkdownText } from '../markdown/MarkdownText.js'
import { fetchSuperTaskDetail } from '../../lib/superTaskApi'
import { subscribeTaskEvents } from '../../lib/taskApi'
import type { TaskDetails, TaskSummary } from '../../lib/superTaskApi'
import { toRendered, mergeConsecutiveAssistantText, type RenderedEvent } from './processEventRenderer'
import { useAppStore } from '../../store/useAppStore'

/**
 * 按「当前干活的 Agent」挑要订阅的事件流:
 * - verifying 桶 / finished 桶 → 优先 verifier 流(verifier 是验证阶段与收尾的
 *   最后工作者);verifierTaskId 缺失(旧任务)回落 executor 流。
 * - 其余(processing/queue/paused) → executor 流。
 */
function pickActiveStream(s: TaskSummary | undefined): {
  id: string | null
  role: 'executor' | 'verifier' | null
} {
  if (!s) return { id: null, role: null }
  const executor = s.executorTaskId ?? null
  const verifier = s.verifierTaskId ?? null
  if (s.bucket === 'verifying-tasks' || s.bucket === 'finished-tasks') {
    if (verifier) return { id: verifier, role: 'verifier' }
    return { id: executor, role: executor ? 'executor' : null }
  }
  return { id: executor, role: executor ? 'executor' : null }
}

/** 事件流事件帧（taskApi.subscribeTaskEvents 产出，字段对齐 taskApi.SseFrame）。 */
interface EventFrame {
  id: string | number
  event: string
  data: Record<string, unknown> | null
}

/**
 * 工具调用/结果的展开状态 —— component 局部 useState，关闭抽屉 / 卸载组件
 * 时丢，不进 URL 不进 store。AntD Tabs 默认 destroyInactiveTabPane=false,
 * 切 tab 不重挂载 → 状态保留。
 */
interface Expansion {
  input?: boolean
  result?: boolean
}

/**
 * Status badge colors for the drawer header (tf-3u5g7p4z): queued gray /
 * processing blue / paused gold / verifying orange / done green / failed red.
 * Labels reuse the same Chinese wording as SuperTaskCard's STATUS_TAG.
 */
const STATUS_BADGE: Record<string, { color: string; label: string }> = {
  queued: { color: 'default', label: '排队' },
  processing: { color: 'blue', label: '执行中' },
  paused: { color: 'gold', label: '已暂停' },
  verifying: { color: 'orange', label: '验证中' },
  done: { color: 'green', label: '完成' },
  failed: { color: 'red', label: '失败' },
}

/**
 * SuperTaskDetailDrawer — 任务详情抽屉（Task 10）。
 *
 * 抽屉打开后拉取任务详情（/api/super-tasks/:id），并在 open 期间每 3s 轮询
 * 刷新（process.md 增量追加）。任务已派生执行子 Agent（task.yaml 的
 * executorTaskId）时，事件流 Tab 通过 `/api/tasks/:id/events` 订阅执行器
 * 的工具调用与消息流，缓冲最近 200 帧。
 */
export default function SuperTaskDetailDrawer({
  taskId,
  onClose,
}: {
  taskId: string | null
  onClose: () => void
}): JSX.Element {
  // 移动端走 bottom Drawer + 90% 高度(对齐 MobileSupervisorDrawer 的同款
  // 抽屉模式);桌面端保持 width=720 默认 right 抽屉。SuperTaskDetailDrawer
  // 同时被 SuperTaskPanel(桌面)与 MobileSuperTasks(/m-super-tasks)引用,
  // 通过 useAppStore.isMobile(由 useIsMobile 在 Layout / MobileLayout 顶层
  // 通过 matchMedia 同步)做 props 分流 —— 桌面路由 isMobile=false → 抽屉
  // 走 width=720;移动路由 isMobile=true → 抽屉走 placement="bottom"。
  const isMobile = useAppStore((s) => s.isMobile)
  const [detail, setDetail] = useState<TaskDetails | null>(null)
  const [events, setEvents] = useState<EventFrame[]>([])
  // Timeline collapse/expand state — collapsed mode keeps only the latest 20 frames
  // ("flowing window"); toggled via the button above the Timeline. Reset on taskId
  // change so switching tasks does not inherit the previous task's expansion.
  const [showAll, setShowAll] = useState(false)

  // 详情拉取 + 3s 轮询（抽屉 open 期间持续刷新 process.md / spec.md / plan.md）
  useEffect(() => {
    if (!taskId) {
      setDetail(null)
      setEvents([])
      setShowAll(false)
      return
    }
    let cancelled = false
    setDetail(null)
    setEvents([])
    setShowAll(false)
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

  // 活跃子 Agent(executor 或 verifier)存在时订阅其事件流;task id 可能晚于
  // 首帧详情出现(任务先创建、后派发子 Agent),因此以 detail 变化驱动订阅。
  const active = pickActiveStream(detail?.summary)
  const activeStreamId = active.id
  useEffect(() => {
    if (!activeStreamId) {
      setEvents([])
      return
    }
    const ctrl = new AbortController()
    const run = async (): Promise<void> => {
      try {
        for await (const frame of subscribeTaskEvents(activeStreamId, 0, ctrl.signal)) {
          setEvents((p) => [...p, frame as EventFrame].slice(-200))
        }
      } catch {
        // abort / 流结束静默
      }
    }
    void run()
    return () => ctrl.abort()
  }, [activeStreamId])

  // 把 SSE 帧流翻译成结构化渲染事件 —— 翻译规则全在 processEventRenderer.ts。
  // dsh(CliAgent)逐 token 上报 assistant_message,合并连续文本碎片为一行,
  // 否则 200 帧缓冲会被碎片填满、Timeline 不可读;合并后 badge / slice(-20)
  // 按「回合」计数而非碎片。
  const rendered = useMemo(
    () =>
      mergeConsecutiveAssistantText(
        events
          .map((e) =>
            toRendered({ id: e.id, event: e.event, data: e.data as unknown }),
          )
          .filter((r): r is RenderedEvent => r !== null),
      ),
    [events],
  )

  // Timeline 数据源：收起态（默认）走「最近 20 条」流动窗口，新事件到来
  // 时旧头部自动挤出；展开态走全部 rendered。Tab 上的事件计数 badge
  // 仍读 rendered.length（总数），不受 visible 影响。
  const VISIBLE_WINDOW = 20
  const visible = showAll ? rendered : rendered.slice(-VISIBLE_WINDOW)
  const canToggle = rendered.length > VISIBLE_WINDOW

  // 工具调用展开状态 —— 用 Map<toolUseId, {...}>，null 表示已渲染的
  // task-ended 行不算「工具调用」，不进 map。
  const [expanded, setExpanded] = useState<Map<string, Expansion>>(new Map())
  const toggleExpand = (key: string, field: keyof Expansion): void => {
    setExpanded((p) => {
      const cur = p.get(key) ?? {}
      const next = new Map(p)
      next.set(key, { ...cur, [field]: !(cur[field] ?? false) })
      return next
    })
  }

  // Resolve the status badge once for the header; unknown statuses fall back
  // to a default-gray tag showing the raw value.
  const statusBadge = detail
    ? STATUS_BADGE[detail.summary.status] ?? { color: 'default', label: detail.summary.status }
    : null

  return (
    <Drawer
      open={taskId != null}
      onClose={onClose}
      {...(isMobile
        ? {
            placement: 'bottom' as const,
            height: '90%',
            destroyOnHidden: false,
            // 让 Drawer body 在 mobile 走 flex 列向布局 —— 上方 title /
            // status / quick banner 用 flexShrink:0 锁住高度,Tabs 拿
            // flex:1 + minHeight:0 吃满剩余垂直空间,Timeline wrapper
            // 再 flex:1 拿到 tab pane 内全部可用高度。tf-hq086lfy 修的
            // 就是这里:旧版 maxHeight=calc(100vh-240px) 在窄屏把 Timeline
            // 滚到可视区外、fallback 文本被压到 ~0px 看不见;改 flex 后
            // 整条 Timeline 区始终挂在 drawer 内,首屏就能看见首个 frame。
            styles: {
              body: { display: 'flex', flexDirection: 'column' },
            },
          }
        : { width: 720 })}
      data-testid={isMobile ? 'mobile-detail-drawer' : 'desktop-detail-drawer'}
      title={detail ? `任务 ${detail.summary.id}` : '任务详情'}
    >
      {!detail ? (
        <Spin />
      ) : (
        // mobile 端把内容包成 flex 列向容器,让 Tabs 自适应吃满剩余高度;
        // desktop 端不强制布局(保留原有 maxHeight 计算路径)。
        <div
          style={
            isMobile
              ? { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }
              : undefined
          }
        >
          <Typography.Title level={5} style={{ marginTop: 0, flexShrink: isMobile ? 0 : undefined }}>
            {detail.summary.title}
          </Typography.Title>
          {/* Header meta (tf-3u5g7p4z): colored status badge + light info tags,
              replacing the old single grey text line for readability. */}
          <Space
            size={[6, 6]}
            wrap
            data-testid="task-status-badges"
            style={{ marginBottom: 8, flexShrink: isMobile ? 0 : undefined }}
          >
            <Tag color={statusBadge?.color} style={{ marginInlineEnd: 0 }}>
              状态:{statusBadge?.label}
            </Tag>
            <Tag style={{ marginInlineEnd: 0 }}>
              Agent:{detail.summary.agent ?? 'default'}
            </Tag>
            {detail.summary.executorTaskId && (
              <Tag style={{ marginInlineEnd: 0 }}>
                执行任务:{detail.summary.executorTaskId}
              </Tag>
            )}
            {detail.summary.verifierTaskId && (
              <Tag style={{ marginInlineEnd: 0 }}>
                验证任务:{detail.summary.verifierTaskId}
              </Tag>
            )}
            {detail.summary.mode === 'quick' && (
              <Tag style={{ marginInlineEnd: 0 }}>模式:quick</Tag>
            )}
          </Space>
          {/* zai patch (2026-09-04, quick-intake):quick 任务顶部加横幅明示,
              同时下文 Tabs 按 mode 过滤掉 plan.md / brainstorm.md Tab。 */}
          {detail.summary.mode === 'quick' && (
            <Alert
              type="info"
              showIcon
              message={
                <span style={{ color: '#0958d9', fontWeight: 600 }}>
                  本任务为快速创建,无 plan.md / brainstorm.md
                </span>
              }
              description={
                <span style={{ color: 'rgba(0,0,0,0.72)' }}>
                  任务目录只包含 task.yaml + process.md + 最小 docs/spec.md(title/description/priority/cwd 快照);验证走轻量路径(build + lint + 关键文件 diff 的 code review)。
                </span>
              }
              style={{
                marginBottom: 12,
                flexShrink: isMobile ? 0 : undefined,
                // tf-3u5g7p4z: deepen the light-blue background and emphasize
                // the left border so the banner is not missed at a glance.
                background: '#e6f4ff',
                border: '1px solid #91caff',
                borderLeft: '4px solid #1677ff',
              }}
              data-testid="quick-mode-banner"
            />
          )}
          <Tabs
            style={isMobile ? { flex: 1, minHeight: 0 } : undefined}
            items={(() => {
              const isQuick = detail.summary.mode === 'quick'
              const items: Array<{
                key: string; label: JSX.Element | string; children: JSX.Element
              }> = [
                {
                  key: 'process',
                  // tab 标签带事件计数 badge —— tf-hq086lfy:旧版空 fallback
                  // 「等待执行事件...」在 mobile 窄屏被 maxHeight 截到 0 像素,
                  // 用户看不出「事件流是开的,只是还没收到」;现在加 badge +
                  // AntD Empty 图标让有无事件状态一目了然。
                  label: (
                    <span data-testid="process-tab-label">
                      事件流
                      {rendered.length > 0 && (
                        <span
                          style={{
                            marginLeft: 6,
                            padding: '0 6px',
                            background: '#f97316',
                            color: '#fff',
                            borderRadius: 8,
                            fontSize: 11,
                            lineHeight: '16px',
                            display: 'inline-block',
                          }}
                          data-testid="process-event-count"
                        >
                          {rendered.length}
                        </span>
                      )}
                    </span>
                  ),
                  children: activeStreamId ? (
                    <div
                      style={
                        isMobile
                          ? {
                              display: 'flex',
                              flexDirection: 'column',
                              height: '100%',
                              minHeight: 0,
                            }
                          : undefined
                      }
                    >
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: 12, flexShrink: isMobile ? 0 : undefined }}
                      >
                        当前事件流来源:{active.role === 'verifier' ? '验证 Agent(verifier)' : '执行 Agent(executor)'}
                        {` · task ${activeStreamId}`}
                      </Typography.Text>
                      {/* 展开/收起切换 —— 事件数 > 20 时显示,挂在 Timeline 上方;
                          收起态显示「显示全部 (N)」,展开态显示「收起」。
                          收起态 Timeline 只跑最近 20 条 (visible 切片),新事件到来
                          时旧头部自动挤出(流动窗口)。≤20 条不显示按钮。 */}
                      {canToggle && (
                        <div style={{ marginTop: 4 }}>
                          <Button
                            type="link"
                            size="small"
                            onClick={() => setShowAll((s) => !s)}
                            data-testid="event-stream-toggle"
                            style={{ padding: 0, fontSize: 12 }}
                          >
                            {showAll ? '收起' : `显示全部 (${rendered.length})`}
                          </Button>
                        </div>
                      )}
                      {rendered.length > 0 ? (
                        // mobile:flex:1 吃满 tab pane 剩余高度,scroll 在
                        // 这里完成(避免 drawer body 双重 scroll);desktop:
                        // 保留 maxHeight=calc(100vh-310px) 路径不变。
                        <div
                          style={
                            isMobile
                              ? {
                                  flex: 1,
                                  minHeight: 0,
                                  overflowY: 'auto',
                                  marginTop: 8,
                                  WebkitOverflowScrolling: 'touch',
                                }
                              : {
                                  maxHeight: 'calc(100vh - 310px)',
                                  overflow: 'auto',
                                  marginTop: 8,
                                }
                          }
                          data-testid="process-timeline-scroll"
                        >
                          <Timeline
                            items={visible.map((r) => ({
                              key: rowKey(r),
                              color: dotColor(r),
                              children: (
                                <RenderedEventRow
                                  ev={r}
                                  expanded={expanded}
                                  toggle={toggleExpand}
                                />
                              ),
                            }))}
                          />
                        </div>
                      ) : (
                        // 空状态用 AntD Empty(带图标 + 文案)而不是裸文本,
                        // —— tf-hq086lfy:旧版「等待执行事件...」单行小灰字在
                        // 移动端窄屏被压扁不可见;Empty 图标占用一整行,
                        // 「事件流是开的」信号不会被 maxHeight 吃掉。
                        <div
                          style={
                            isMobile
                              ? {
                                  flex: 1,
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  marginTop: 8,
                                  minHeight: 0,
                                }
                              : { marginTop: 8 }
                          }
                          data-testid="process-empty-state"
                        >
                          <Empty
                            image={Empty.PRESENTED_IMAGE_SIMPLE}
                            description="等待执行事件..."
                          />
                        </div>
                      )}
                    </div>
                  ) : (
                    <Typography.Text type="secondary">尚未派生执行/验证子 Agent</Typography.Text>
                  ),
                },
                {
                  key: 'verification',
                  label: '验证记录',
                  children: detail.verificationMd ? (
                    <MarkdownText text={detail.verificationMd} />
                  ) : (
                    <Typography.Text type="secondary">尚无验证记录</Typography.Text>
                  ),
                },
              ]
              // quick 模式不显示 brainstorm.md / plan.md Tab —— 这些文件根本不会被创建。
              if (!isQuick) {
                items.push({
                  key: 'brainstorm',
                  label: 'brainstorm.md',
                  children: detail.brainstormMd ? (
                    <MarkdownText text={detail.brainstormMd} />
                  ) : (
                    <Typography.Text type="secondary">尚无讨论纪要</Typography.Text>
                  ),
                })
              }
              items.push({
                key: 'spec',
                label: 'spec.md',
                children: <MarkdownText text={detail.specMd ?? ''} />,
              })
              if (!isQuick) {
                items.push({
                  key: 'plan',
                  label: 'plan.md',
                  children: <MarkdownText text={detail.planMd ?? ''} />,
                })
              }
              items.push({
                key: 'processMd',
                label: 'process.md',
                children: <MarkdownText text={detail.processMd ?? ''} />,
              })
              return items
            })()}
          />
        </div>
      )}
    </Drawer>
  )
}

/** Timeline 每行的 key —— 同 seq 不同 kind 也要区分,避免折叠键冲突。 */
function rowKey(r: RenderedEvent): string {
  if (r.kind === 'task-ended') return `ended-${r.status}`
  return `${r.seq}-${r.kind}`
}

/** Timeline 圆点颜色 —— 按 kind 分层(blue=assistant-text/red=error/gray=thinking etc.)。 */
function dotColor(r: RenderedEvent): string {
  switch (r.kind) {
    case 'system':
      return 'gray'
    case 'user':
      return 'green'
    case 'assistant-text':
      return 'blue'
    case 'thinking':
      return 'gray'
    case 'tool-use':
      return 'purple'
    case 'tool-result':
      return r.isError ? 'red' : 'gray'
    case 'task-ended':
      return r.status === 'completed' ? 'green' : r.status === 'failed' ? 'red' : 'gray'
  }
}

/** 工具调用/结果行的 JSON 面板 —— 渲染传入对象 + 折叠状态。 */
function JsonPanel({
  data,
  open,
  error,
}: {
  data: unknown
  open: boolean
  error?: boolean
}): JSX.Element {
  if (!open) return <span style={{ fontSize: 11, color: error ? '#c41d7f' : '#999' }}>▸</span>
  const style: CSSProperties = {
    marginTop: 4,
    padding: 8,
    background: error ? '#fff1f0' : '#fafafa',
    border: `1px solid ${error ? '#ffa39e' : '#e8e8e8'}`,
    borderRadius: 4,
    fontSize: 12,
    fontFamily: 'monospace',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: 240,
    overflow: 'auto',
  }
  return (
    <div style={style}>
      <code>{JSON.stringify(data, null, 2)}</code>
    </div>
  )
}

/** 思考块折叠 —— <Collapse> 包裹整段文本。 */
function ThinkingBlock({ text }: { text: string }): JSX.Element {
  return (
    <Collapse
      size="small"
      ghost
      items={[
        {
          key: 't',
          label: <span style={{ color: '#888' }}>[思考]</span>,
          children: <div style={{ whiteSpace: 'pre-wrap', color: '#555' }}>{text}</div>,
        },
      ]}
    />
  )
}

/** 7 种 kind 分支的渲染 —— 在 Timeline children 槽里。 */
function RenderedEventRow({
  ev,
  expanded,
  toggle,
}: {
  ev: RenderedEvent
  expanded: Map<string, Expansion>
  toggle: (key: string, field: keyof Expansion) => void
}): JSX.Element {
  switch (ev.kind) {
    case 'system':
      return (
        <span style={{ color: '#888' }}>
          <code>[{ev.sub}]</code>
        </span>
      )
    case 'user':
      return (
        <div>
          <blockquote
            style={{
              margin: '4px 0',
              padding: '4px 10px',
              borderLeft: '3px solid #52c41a',
              background: '#f6ffed',
            }}
          >
            {ev.text}
          </blockquote>
          {(ev.cwd || ev.agent) && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {ev.cwd ? `cwd: ${ev.cwd}` : ''}
              {ev.cwd && ev.agent ? ' · ' : ''}
              {ev.agent ? `agent: ${ev.agent}` : ''}
            </Typography.Text>
          )}
        </div>
      )
    case 'assistant-text':
      return (
        <div style={{ marginTop: 2 }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{ev.text}</ReactMarkdown>
        </div>
      )
    case 'thinking':
      return <ThinkingBlock text={ev.text} />
    case 'tool-use': {
      const open = expanded.get(ev.toolUseId)?.input ?? false
      return (
        <div>
          <a
            onClick={(e) => {
              e.preventDefault()
              toggle(ev.toolUseId, 'input')
            }}
            style={{ color: '#722ed1', cursor: 'pointer' }}
          >
            [Tool: {ev.name}] {ev.summary} {open ? '▾' : '▸'}
          </a>
          <JsonPanel data={ev.fullInput} open={open} />
        </div>
      )
    }
    case 'tool-result': {
      const open = expanded.get(ev.toolUseId)?.result ?? false
      const color = ev.isError ? '#c41d7f' : '#666'
      return (
        <div style={{ marginTop: 2, paddingLeft: 12, borderLeft: '2px solid #eee' }}>
          <a
            onClick={(e) => {
              e.preventDefault()
              toggle(ev.toolUseId, 'result')
            }}
            style={{ color, cursor: 'pointer', fontSize: 13 }}
          >
            ↳ result · {ev.summary} {open ? '▾' : '▸'}
          </a>
          <JsonPanel data={ev.fullContent} open={open} error={ev.isError} />
        </div>
      )
    }
    case 'task-ended':
      if (ev.status === 'completed')
        return <span style={{ color: '#52c41a' }}>✓ 任务完成</span>
      if (ev.status === 'failed')
        return (
          <span style={{ color: '#ff4d4f' }}>
            ✗ 失败:{ev.error ?? '未知错误'}
          </span>
        )
      return <span style={{ color: '#999' }}>− 已取消</span>
  }
}
