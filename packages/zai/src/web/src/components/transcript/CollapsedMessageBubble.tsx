import { useEffect, useRef, useState } from 'react'
import { Button, Card, Space, Typography } from 'antd'
import { RobotFilled, UserOutlined } from '@ant-design/icons'
import type { AgentMessage } from '../../store/useAgentStore.js'
import { MarkdownText } from '../markdown/MarkdownText.js'
import { MessageCopyButton, StreamingMarkdown, ThinkingBlock } from './MessageBubble.js'
import { linkifyText } from '../../lib/linkify.js'

const { Paragraph, Text } = Typography

const CLAMP_LINES = 6
// 6 行文字在 fontSize 14 / lineHeight 1.6 下的近似高度 (~134px),
// 用于 AI 文本在 collapsed 态的 max-height 截断; 超过此高度展示 "显示更多" 按钮
// 内联展开, 不破坏 transcript 折叠结构 (fold → expand per-bubble, not transcript-level).
const AI_TEXT_MAX_HEIGHT_PX = 140

// CollapsedMessageBubble — collapsed transcript 下的单条文本气泡.
//
// 设计要点 (与 expanded 视图完全对齐, 见 MessageBubble.tsx):
// - 用户消息: 右对齐 + antd Card (深底浅字, 由 index.css 全局覆盖) + UserOutlined 图标 + line-clamp:6
// - AI 消息:   左对齐 + antd Card + RobotFilled 图标 + 完整 Markdown 渲染 + maxHeight ~6 行 + "显示更多"
// - Thinking:   直接走 MessageBubble 的 ThinkingBlock, 与 expanded 视图视觉一致
//               (思考块 spec §3.4 要求始终完整、不折叠、不截断)
// - Tool 错误:  红条 stripe (兜底, 正常路径下 tool_use:error 已被 deriveTranscriptNodes
//               归入 toolGroup, 不会进 text node)
//
// 重要: 不设置 background — index.css 第 49/53 行用 !important 强制 .ant-card 用
// var(--bg-card) (#12121a) + 浅色字, 这是 zai 暗色主题的基础. 自定义浅色背景
// (例如 #e6f4ff / #f6ffed) 在 expanded 视图也是被覆盖的 (用户无感知因为颜色没生效);
// 我们这里显式不设 bg, 让全局 CSS 一致接管, 避免气泡出现"亮底+浅字"的不可读组合.
export function CollapsedMessageBubble({
  message,
  streaming,
}: {
  message: AgentMessage
  streaming?: boolean
}) {
  const m = message as any
  const t = m.type as string

  // Thinking: 与 expanded 同款 ThinkingBlock. 兜底 'assistant' + thinking 字段的
  // legacy 路径 (transcript 回放可能产生), 一并覆盖.
  if (
    t === 'assistant.thinking' ||
    (t === 'assistant' &&
      typeof m.thinking === 'string' &&
      m.thinking.length > 0)
  ) {
    return (
      <ThinkingBlock
        text={(m.thinking as string) || (m.text as string) || ''}
        streaming={streaming}
      />
    )
  }

  // Assistant text: 左对齐, antd Card (深底浅字) + RobotFilled 图标, 与 expanded 一致
  if (t === 'assistant.text') {
    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-start',
          marginBottom: 16,
          marginRight: 20,
        }}
      >
        <Card
          size="small"
          style={{ width: '100%', maxWidth: '100%', borderRadius: 12, position: 'relative' }}
        >
          <MessageCopyButton text={(m.text as string) || ''} variant="ai" />
          <Space align="start" size={8} style={{ width: '100%' }}>
            <RobotFilled style={{ color: '#ff6600', fontSize: 18 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <AssistantTextBody
                text={(m.text as string) || ''}
                streaming={streaming}
              />
            </div>
          </Space>
        </Card>
      </div>
    )
  }

  // User text: 右对齐, antd Card + UserOutlined 图标, 与 expanded 一致 + clamp
  if (t === 'user.text' || t === 'user.message') {
    const text = (m.text as string) || (m.prompt as string) || ''
    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          marginBottom: 16,
        }}
      >
        <Card size="small" style={{ maxWidth: '70%', borderRadius: 12, position: 'relative' }}>
          {/* 横向 flex: [copy inline] [text flex:1] [UserOutlined]
              copy 与 expanded 视图一致用 inline 嵌最左, 避免短消息 + 右上绝对按钮盖住文字. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              minWidth: 0,
            }}
          >
            <MessageCopyButton text={text} variant="user" placement="inline" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <Paragraph
                ellipsis={{
                  rows: CLAMP_LINES,
                  expandable: true,
                  symbol: '显示更多',
                }}
                style={{ marginBottom: 0 }}
              >
                {linkifyText(text)}
              </Paragraph>
            </div>
            <UserOutlined style={{ flexShrink: 0, marginTop: 2 }} />
          </div>
        </Card>
      </div>
    )
  }

  // tool_use:error 兜底 (正常路径下应已被 deriveTranscriptNodes 归入 toolGroup).
  // 留一条红色 stripe 以防某些边界情况让 error message 漏到 text 节点.
  if (t === 'tool_use:error') {
    const text = (m.text as string) ?? (m.content as string) ?? ''
    return (
      <div
        style={{
          color: '#cf1322',
          padding: '4px 8px',
          borderLeft: '3px solid #cf1322',
        }}
      >
        <strong>Tool error</strong>
        <Paragraph style={{ marginBottom: 0, color: '#cf1322' }}>
          {text || '(no message)'}
        </Paragraph>
      </div>
    )
  }

  // 兜底: 未知文本类型 — 纯文本 + clamp, 至少不丢内容
  const text = (m.text as string) ?? (m.content as string) ?? ''
  return (
    <Card size="small" style={{ marginBottom: 8, borderRadius: 12 }}>
      <Paragraph
        ellipsis={{
          rows: CLAMP_LINES,
          expandable: true,
          symbol: '显示更多',
        }}
        style={{ marginBottom: 0 }}
      >
        {text}
      </Paragraph>
    </Card>
  )
}

// AssistantTextBody — AI 文本气泡体, 负责 Markdown 渲染 + 内联展开.
// maxHeight clamp 是 spec §3.4 "助手文本同样 6 行 clamp" 的实践版: markdown 输出
// 不支持 CSS line-clamp (ReactMarkdown 输出的元素没法直接打 ellipsis),
// 用 maxHeight + 测 scrollHeight 模拟. 内容未溢出时不显示 "显示更多" 按钮.
function AssistantTextBody({
  text,
  streaming,
}: {
  text: string
  streaming?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [overflow, setOverflow] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (expanded || !ref.current) {
      setOverflow(false)
      return
    }
    // clientHeight 是 maxHeight 截断后的渲染高度; scrollHeight 是真实高度.
    // 二者差超过 1px 说明内容被截了, 显示展开按钮.
    setOverflow(ref.current.scrollHeight > ref.current.clientHeight + 1)
  }, [text, expanded])

  return (
    <>
      <div
        ref={ref}
        style={{
          overflow: expanded ? 'visible' : 'hidden',
          maxHeight: expanded ? 'none' : AI_TEXT_MAX_HEIGHT_PX,
        }}
      >
        {streaming ? <StreamingMarkdown text={text} /> : <MarkdownText text={text} />}
      </div>
      {overflow && (
        <Button
          type="link"
          size="small"
          onClick={() => setExpanded((x) => !x)}
          style={{ padding: 0, marginTop: 4 }}
        >
          {expanded ? '收起' : '显示更多'}
        </Button>
      )}
    </>
  )
}