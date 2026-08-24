/**
 * dsh-019 Phase 3: dsh subagent 任务详情 — 不含 Drawer 外壳的纯内容组件。
 *
 * 与 `SubagentDetailDrawer` 共享渲染逻辑(Descriptions / PromptBlock /
 * Tool Calls Collapse / Result),由不同宿主决定如何包装:
 *
 * - `SubagentDetailDrawer` — 包成独立 Drawer 给 SubagentsTab 用
 * - `TaskDrawer` (dsh subagent 分支) — 直接渲染在 TaskDrawer 内,
 *   不嵌套 Drawer(避免两层 Drawer 的视觉问题,见 plan
 *   `squishy-cuddling-allen.md` 改动 2 第 6 步)
 *
 * 数据源:`GET /api/subagent-tasks/:id` 拉完整 DshTaskState(prompt /
 * startedAt / finishedAt / result / error / toolCalls / blocks /
 * lastAssistantMessage)。父组件通过 SSE `subagent.changed` 推 store 拿
 * 到 status 实时更新,本组件 fetch 只在 taskId 变化时跑一次。
 *
 * Task 15 (dsh-subagent-task-alignment): 新增 ContentBlockRenderer —
 * server 返回 `blocks: SubagentContentBlock[]` 时,按 block.type
 * 分支渲染(thinking/text/tool_use/tool_result/image),未知 type
 * 降级为 JSON 预格式块。
 */

import { useEffect, useState } from 'react'
import { Collapse, Descriptions, Spin, Typography } from 'antd'
import { CodeOutlined } from '@ant-design/icons'
import { useAgentStore } from '../../store/useAgentStore.js'
import type { SubagentContentBlock } from '../../shared/subagentEvents.js'
import { ThinkingBlock } from '../transcript/MessageBubble.js'
import { MarkdownText } from '../markdown/MarkdownText.js'

const { Paragraph } = Typography

export interface ToolCallView {
  callId: string
  toolName: string
  input: unknown
  output?: unknown
  status: 'running' | 'done' | 'error'
  ts: number
  durationMs?: number
  error?: { name: string; code: string }
}

export interface SubagentDetail {
  taskId: string
  sessionId: string
  parentSessionId?: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  prompt: string
  startedAt: number
  finishedAt?: number
  result?: unknown
  error?: string
  toolCalls?: ToolCallView[]
  /**
   * Task 15: vendor `@deepseek-ai/dsh-subagent` 输出 ContentBlock 流,
   * server 落盘后通过 `/api/subagent-tasks/:id` 一并下发。 UI 优先按
   * `blocks` 逐块渲染(thinking/text/tool_use/tool_result/image);若
   * blocks 缺失, 回退到原 toolCalls Collapse 视图, 不破坏 dsh-024
   * `running → terminal` 触发 refetch 的回归路径。
   *
   * 来源:`getDshSubagentToolCalls` 读 `~/.zai/tasks-dsh/<taskId>.json`
   * (cordis `subagent/message` 事件在 vendor 端不存在, 见 Task 7
   * vendor-reality fix,改读落盘 JSON)。
   */
  blocks?: SubagentContentBlock[]
  /**
   * `subagent.end` event 的 `lastAssistantMessage` 字段(数组形式),
   * 在 blocks 末尾追加(若有),并不重复渲染已有 block。
   */
  lastAssistantMessage?: SubagentContentBlock[]
}

const TOOL_STATUS_COLOR: Record<ToolCallView['status'], string> = {
  running: 'var(--warning)',
  done: 'var(--success)',
  error: 'var(--error)',
}

const TOOL_STATUS_LABEL: Record<ToolCallView['status'], string> = {
  running: '运行中',
  done: '完成',
  error: '失败',
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}

function formatDuration(start: number, end?: number): string {
  const endMs = end ?? Date.now()
  const ms = endMs - start
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
}

function formatDurationShort(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatResult(result: unknown): string {
  if (result == null) return ''
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

/**
 * dsh 给的 tool input 是模型生成的 raw JSON 字符串(arguments 字段),
 * 摘要取前 80 字符做单行展示。
 */
function formatToolInputSummary(toolName: string, input: unknown): string {
  if (input == null) return ''
  if (typeof input === 'string') {
    const trimmed = input.length > 80 ? input.slice(0, 80) + '…' : input
    return `${toolName}(${trimmed})`
  }
  try {
    const s = JSON.stringify(input)
    const trimmed = s.length > 80 ? s.slice(0, 80) + '…' : s
    return `${toolName}(${trimmed})`
  } catch {
    return `${toolName}(?)`
  }
}

/**
 * Task 15: ContentBlockRenderer — 按 Anthropic-shaped
 * `SubagentContentBlock.type` 分支渲染 5 种内建类型(thinking /
 * text / tool_use / tool_result / image),未知 type 降级为 raw JSON
 * pre 块,确保新增 vendor block 类型时不会让 UI 静默丢失内容。
 *
 * 与原 `toolCalls` Collapse 路径互斥:`SubagentDetailBody` 仅在
 * `detail.blocks` 非空时走 ContentBlockRenderer 链路,否则继续用
 * Collapse 渲染 `detail.toolCalls`(保留 dsh-024 回归与现状)。
 *
 * aria-label: 整组渲染对屏幕阅读器使用 `role="group"` + 中文
 * aria-label "子代理输出块",符合 AGENTS.md UI 规范 — ContentBlock
 * 内容本身由组件语义表达(strong/list/table 等),不再单独给每个
 * block 加 label,避免噪声。
 */
function ContentBlockRenderer({ block }: { block: SubagentContentBlock }) {
  if (block.type === 'thinking') {
    return <ThinkingBlock text={block.thinking} />
  }
  if (block.type === 'text') {
    return <MarkdownText text={block.text} />
  }
  if (block.type === 'tool_use') {
    return (
      <div
        style={{
          border: '1px solid var(--border-light)',
          borderRadius: 4,
          padding: 8,
          margin: '4px 0',
          background: 'var(--bg-faint-02)',
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontFamily: 'ui-monospace, monospace',
            color: 'var(--ui-text-color)',
            marginBottom: 4,
          }}
        >
          工具调用 · {block.name}
        </div>
        <pre
          style={{
            fontSize: 11,
            margin: 0,
            padding: 6,
            background: 'var(--bg-card, #fafafa)',
            borderRadius: 3,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: 'ui-monospace, monospace',
            maxHeight: 240,
            overflow: 'auto',
          }}
        >
          {JSON.stringify(block.input, null, 2)}
        </pre>
      </div>
    )
  }
  if (block.type === 'tool_result') {
    const isError = !!block.is_error
    const body =
      typeof block.content === 'string'
        ? block.content
        : JSON.stringify(block.content, null, 2)
    return (
      <div
        style={{
          borderLeft: `2px solid ${isError ? 'var(--error)' : 'var(--accent-start)'}`,
          paddingLeft: 8,
          margin: '4px 0',
          fontSize: 12,
        }}
      >
        <span style={{ marginRight: 4 }}>{isError ? '❌' : '✅'}</span>
        <pre
          style={{
            display: 'inline',
            margin: 0,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: 'ui-monospace, monospace',
            color: isError ? 'var(--error)' : undefined,
          }}
        >
          {body}
        </pre>
      </div>
    )
  }
  if (block.type === 'image') {
    return (
      <img
        src={`data:${block.source.media_type};base64,${block.source.data}`}
        alt="子代理图片"
        style={{ maxWidth: '100%', display: 'block', margin: '4px 0' }}
      />
    )
  }
  // 未知 type — 降级为 raw JSON pre 块,保证新 vendor 类型不会静默丢内容
  return (
    <pre
      style={{
        background: 'var(--bg-faint-04, #fffbe6)',
        padding: 8,
        fontSize: 11,
        borderRadius: 4,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily: 'ui-monospace, monospace',
        margin: '4px 0',
      }}
    >
      {JSON.stringify(block, null, 2)}
    </pre>
  )
}

/**
 * 把 `detail.blocks` 与 `detail.lastAssistantMessage` 拼成一条渲染流:
 * - blocks 优先(主路径)
 * - lastAssistantMessage 中与 blocks 已渲染重复的 element 跳过
 *   (Zod discriminated union 字段相同即视为重复,简化为字符串 hash)
 * - 用 <ol> 顺序输出,方便屏幕阅读器朗读顺序
 */
function ContentBlocksList({
  blocks,
  lastAssistantMessage,
}: {
  blocks?: SubagentContentBlock[]
  lastAssistantMessage?: SubagentContentBlock[]
}) {
  if (!blocks || blocks.length === 0) {
    if (!lastAssistantMessage || lastAssistantMessage.length === 0) return null
    return (
      <ol
        aria-label="子代理输出块"
        style={{ listStyle: 'none', padding: 0, margin: 0 }}
      >
        {lastAssistantMessage.map((block, i) => (
          <li key={i} role="presentation">
            <ContentBlockRenderer block={block} />
          </li>
        ))}
      </ol>
    )
  }
  const seen = new Set<string>()
  for (const b of blocks) seen.add(JSON.stringify(b))
  const trailing =
    lastAssistantMessage?.filter((b) => !seen.has(JSON.stringify(b))) ?? []
  return (
    <ol
      aria-label="子代理输出块"
      style={{ listStyle: 'none', padding: 0, margin: 0 }}
    >
      {blocks.map((block, i) => (
        <li key={i} role="presentation">
          <ContentBlockRenderer block={block} />
        </li>
      ))}
      {trailing.map((block, i) => (
        <li key={`trailing-${i}`} role="presentation">
          <ContentBlockRenderer block={block} />
        </li>
      ))}
    </ol>
  )
}

export function SubagentDetailBody({
  taskId,
  reloadSignal = 0,
}: {
  taskId: string
  /**
   * 父组件递增这个 number 触发重 fetch。SubagentDetailDrawer 用此支持
   * Reload 按钮。TaskDrawer 嵌入本组件时通常传 0(不重 fetch,实时性靠 SSE)。
   */
  reloadSignal?: number
}) {
  const [detail, setDetail] = useState<SubagentDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // dsh-024 修复:订阅 store 里的 live status — SSE 'subagent.changed'
  // 推到 useAgentStore.subagentTasksBySession,触发组件 re-render。
  // 当 status 从 'running' 变为终态(done/failed/cancelled)时,触发
  // 重新 fetch — 因为 body 内容(result / toolCalls / finishedAt)只
  // 在 taskStore 落盘时更新,SSE 事件本身只携带 status 字段;不重新
  // 拉详情抽屉里就显示不出 Agent 的最终回复,只能刷新页面才能看到
  // (用户痛点:「完成之后,看不到 Agent 的回复,但是刷新页面重新加载
  // 又看到了思考和结果展示」)。
  const liveStatus = useAgentStore((s) => {
    for (const sid of Object.keys(s.subagentTasksBySession)) {
      const t = s.subagentTasksBySession[sid]?.find((task) => task.id === taskId)
      if (t) return t.status as SubagentDetail['status'] | undefined
    }
    return undefined
  })

  // 拉详情 — taskId 变化 / reloadSignal 递增 / liveStatus 变化时
  // 重新 fetch。running → terminal 的状态切换是关键触发点。
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/subagent-tasks/${encodeURIComponent(taskId)}`)
      .then((r) => {
        if (!r.ok) {
          if (r.status === 404) throw new Error('subagent_task_not_found')
          if (r.status === 503) throw new Error('dsh_subagent_unavailable')
          throw new Error(`HTTP ${r.status}`)
        }
        return r.json() as Promise<SubagentDetail>
      })
      .then((d) => {
        if (cancelled) return
        setDetail(d)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setDetail(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [taskId, reloadSignal, liveStatus])

  if (loading && !detail) {
    return (
      <div style={{ textAlign: 'center', padding: 40 }}>
        <Spin />
      </div>
    )
  }
  if (error) {
    return (
      <div style={{ padding: 16, color: 'var(--error)', fontSize: 13 }}>
        加载失败: {error}
      </div>
    )
  }
  if (!detail) return null

  return (
    <div>
      <Descriptions column={1} size="small" bordered>
        <Descriptions.Item label="Task ID">
          <code style={{ fontSize: 11 }}>{detail.taskId}</code>
        </Descriptions.Item>
        <Descriptions.Item label="Session ID">
          <code style={{ fontSize: 11 }}>{detail.sessionId}</code>
        </Descriptions.Item>
        {detail.parentSessionId && (
          <Descriptions.Item label="Parent Session">
            <code style={{ fontSize: 11 }}>{detail.parentSessionId}</code>
          </Descriptions.Item>
        )}
        <Descriptions.Item label="Started At">
          {formatTimestamp(detail.startedAt)}
        </Descriptions.Item>
        {detail.finishedAt && (
          <Descriptions.Item label="Finished At">
            {formatTimestamp(detail.finishedAt)}
          </Descriptions.Item>
        )}
        {detail.startedAt && (
          <Descriptions.Item label="Duration">
            {formatDuration(detail.startedAt, detail.finishedAt)}
          </Descriptions.Item>
        )}
      </Descriptions>

      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--ui-text-color)' }}>
          Prompt
        </div>
        <Paragraph
          copyable={{ tooltips: ['复制', '已复制'] }}
          style={{
            fontSize: 12,
            background: 'var(--bg-card, #fafafa)',
            padding: 8,
            borderRadius: 4,
            marginBottom: 0,
            maxHeight: 200,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {detail.prompt || '(empty)'}
        </Paragraph>
      </div>

      {detail.error && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--error)' }}>
            Error
          </div>
          <Paragraph
            copyable
            style={{
              fontSize: 12,
              background: 'var(--bg-card, #fff5f5)',
              padding: 8,
              borderRadius: 4,
              marginBottom: 0,
              color: 'var(--error)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {detail.error}
          </Paragraph>
        </div>
      )}

      {/* Task 15: ContentBlock[] 主渲染路径 (vendor dsh-subagent output).
          仅在 detail.blocks / detail.lastAssistantMessage 至少有一个
          非空时启用,作为 toolCalls Collapse 之外的并行视图。 */}
      {(detail.blocks?.length || detail.lastAssistantMessage?.length) && (
        <div style={{ marginTop: 16 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              marginBottom: 4,
              color: 'var(--ui-text-color)',
            }}
          >
            Content Blocks
          </div>
          <ContentBlocksList
            blocks={detail.blocks}
            lastAssistantMessage={detail.lastAssistantMessage}
          />
        </div>
      )}

      {detail.toolCalls && detail.toolCalls.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              marginBottom: 4,
              color: 'var(--ui-text-color)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <CodeOutlined />
            Tool Calls ({detail.toolCalls.length})
          </div>
          <Collapse
            size="small"
            bordered={false}
            ghost
            items={detail.toolCalls.map((tc, idx) => ({
              key: tc.callId || `tc-${idx}`,
              label: (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 12,
                    fontFamily: 'ui-monospace, monospace',
                    minWidth: 0,
                  }}
                >
                  <span
                    style={{
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: 'var(--text-primary)',
                    }}
                  >
                    {formatToolInputSummary(tc.toolName, tc.input)}
                  </span>
                  <span
                    style={{
                      marginLeft: 'auto',
                      flexShrink: 0,
                      color: TOOL_STATUS_COLOR[tc.status],
                      fontSize: 11,
                    }}
                  >
                    {TOOL_STATUS_LABEL[tc.status]}
                    {tc.durationMs !== undefined && (
                      <> · {formatDurationShort(tc.durationMs)}</>
                    )}
                  </span>
                </div>
              ),
              children: (
                <div style={{ fontSize: 12 }}>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: 'var(--ui-text-color)',
                      marginBottom: 2,
                    }}
                  >
                    Input
                  </div>
                  <Paragraph
                    copyable
                    style={{
                      fontSize: 12,
                      background: 'var(--bg-card, #fafafa)',
                      padding: 8,
                      borderRadius: 4,
                      marginBottom: 8,
                      maxHeight: 240,
                      overflow: 'auto',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      fontFamily: 'ui-monospace, monospace',
                    }}
                  >
                    {typeof tc.input === 'string'
                      ? tc.input
                      : formatResult(tc.input) || '(empty)'}
                  </Paragraph>
                  {tc.output !== undefined && (
                    <>
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          color: 'var(--ui-text-color)',
                          marginBottom: 2,
                        }}
                      >
                        Output
                      </div>
                      <Paragraph
                        copyable
                        style={{
                          fontSize: 12,
                          background:
                            tc.status === 'error'
                              ? 'var(--bg-card, #fff5f5)'
                              : 'var(--bg-card, #fafafa)',
                          padding: 8,
                          borderRadius: 4,
                          marginBottom: 0,
                          maxHeight: 240,
                          overflow: 'auto',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          fontFamily: 'ui-monospace, monospace',
                          color: tc.status === 'error' ? 'var(--error)' : undefined,
                        }}
                      >
                        {formatResult(tc.output).slice(0, 4096) || '(empty)'}
                      </Paragraph>
                    </>
                  )}
                  {tc.error && (
                    <div
                      style={{
                        marginTop: 6,
                        fontSize: 11,
                        color: 'var(--error)',
                      }}
                    >
                      {tc.error.name} ({tc.error.code})
                    </div>
                  )}
                </div>
              ),
            }))}
          />
        </div>
      )}

      {detail.result !== undefined && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--ui-text-color)' }}>
            Result
          </div>
          <Paragraph
            copyable
            style={{
              fontSize: 12,
              background: 'var(--bg-card, #fafafa)',
              padding: 8,
              borderRadius: 4,
              marginBottom: 0,
              maxHeight: 300,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'monospace',
            }}
          >
            {formatResult(detail.result).slice(0, 4096) || '(empty)'}
          </Paragraph>
        </div>
      )}
    </div>
  )
}