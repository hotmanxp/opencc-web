import { useState, useRef, useEffect, useMemo } from 'react'
import { Typography, Button } from 'antd'
import { RobotFilled, UpOutlined } from '@ant-design/icons'
import { useAgentStore } from '../store/useAgentStore'
import { useAppStore } from '../store/useAppStore'
import QuestionCard from '../components/QuestionCard.jsx'
import PermissionConfirmCard from '../components/PermissionConfirmCard.jsx'
import TodoZone from '../components/TodoZone.jsx'
import AgentInputBox from '../components/AgentInputBox'
import { MessageListView } from '../components/transcript/MessageListView.js'
import { useAutoScrollToBottom } from '../hooks/useAutoScrollToBottom'

const { Paragraph } = Typography

/**
 * Agent.tsx 的对话核心 — 抽出来供 MobileAgent 复用。
 * 只负责:消息裁剪 + 渲染 + QuestionCard + AgentInputBox + 自动滚动 + Esc 中断。
 * 不负责:左侧 sessions 栏、右侧 SplitPane、ConfigStatusBar、Drawer 容器。
 * 这些由调用方(Agent.tsx / MobileAgent.tsx)各自决定怎么挂。
 *
 * 移动端判断走 useAppStore.isMobile (由 useIsMobile() hook 在 Layout 顶部
 * 同步), 不再走 props, 让组件树更扁.
 */
export default function AgentConversation() {
  const messages = useAgentStore((s) => s.messages)
  const maxVisibleMessages = useAppStore((s) => s.maxVisibleMessages)
  const outputStyle = useAppStore((s) => s.outputStyle)
  const [showAllMessages, setShowAllMessages] = useState(false)

  // 消息裁剪 + compact 模式保底 — 复用 Agent.tsx 既有实现
  const { hiddenCount, visibleMessages } = useMemo(() => {
    const hc = Math.max(0, messages.length - maxVisibleMessages)
    if (showAllMessages) return { hiddenCount: 0, visibleMessages: messages }
    if (hc === 0) return { hiddenCount: 0, visibleMessages: messages }
    if (outputStyle === 'compact') {
      let lastAssistantIdx = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        if ((messages[i] as { type?: string }).type === 'assistant.text') {
          lastAssistantIdx = i
          break
        }
      }
      if (lastAssistantIdx >= 0 && lastAssistantIdx < hc) {
        return { hiddenCount: lastAssistantIdx, visibleMessages: messages.slice(lastAssistantIdx) }
      }
    }
    return { hiddenCount: hc, visibleMessages: messages.slice(hc) }
  }, [messages, maxVisibleMessages, showAllMessages, outputStyle])

  const hiddenCountAtExpandRef = useRef(hiddenCount)
  useEffect(() => {
    if (!showAllMessages) {
      hiddenCountAtExpandRef.current = hiddenCount
      return
    }
    if (hiddenCount > hiddenCountAtExpandRef.current) {
      setShowAllMessages(false)
    }
  }, [showAllMessages, hiddenCount])
  const showPill = hiddenCount > 0 && !showAllMessages

  const status = useAgentStore((s) => s.status)
  const sessionId = useAgentStore((s) => s.sessionId)
  const pendingAsk = useAgentStore((s) => s.pendingAsk)
  const setAskAnswer = useAgentStore((s) => s.setAskAnswer)
  const setAskNotes = useAgentStore((s) => s.setAskNotes)
  const setAskOtherText = useAgentStore((s) => s.setAskOtherText)
  const submitAsk = useAgentStore((s) => s.submitAsk)
  const rejectAsk = useAgentStore((s) => s.rejectAsk)

  const v2TasksBySession = useAgentStore((s) => s.v2TasksBySession)
  const v2TasksForCurrentSession =
    sessionId != null ? (v2TasksBySession[sessionId] ?? []) : []

  const stop = useAgentStore((s) => s.stop)
  const questionCardRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const autoScroll = useAutoScrollToBottom(scrollContainerRef)

  useEffect(() => {
    if (pendingAsk) {
      questionCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
      return
    }
    autoScroll.scrollToBottom(messages.length)
  }, [messages, pendingAsk, autoScroll])

  useEffect(() => {
    if (status !== 'streaming') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        void stop()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [status, stop])

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        maxWidth: '100%',
        overflowX: 'hidden',
      }}
    >
      <div
        ref={scrollContainerRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '0 8px',
          marginBottom: 4,
          background: 'var(--bg-body)',
          maxWidth: '100%',
          overflowX: 'hidden',
        }}
      >
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', marginTop: 80, color: 'var(--text-tertiary)' }}>
            <RobotFilled style={{ fontSize: 48, marginBottom: 16, color: 'var(--accent-start)' }} />
            <Paragraph type="secondary">发送消息开始与 AI Agent 对话</Paragraph>
            <Paragraph type="secondary" style={{ fontSize: 12 }}>
              支持文件搜索、读写文件和 Bash 执行
            </Paragraph>
          </div>
        )}
        <TodoZone tasks={v2TasksForCurrentSession} />
        {showPill && (
          <div
            style={{
              position: 'sticky',
              top: 0,
              zIndex: 10,
              display: 'flex',
              justifyContent: 'center',
              paddingTop: 8,
              paddingBottom: 4,
            }}
          >
            <Button
              shape="round"
              size="small"
              icon={<UpOutlined />}
              onClick={() => setShowAllMessages(true)}
              data-testid="show-all-messages-pill"
            >
              显示全部 ({hiddenCount} 条隐藏)
            </Button>
          </div>
        )}
        <MessageListView messages={visibleMessages} streaming={status === 'streaming'} />
        {pendingAsk && (
          <div ref={questionCardRef}>
            <QuestionCard
              questions={pendingAsk.questions}
              answers={pendingAsk.answers}
              annotations={pendingAsk.annotations}
              status={pendingAsk.status}
              errorMessage={pendingAsk.errorMessage}
              onAnswer={setAskAnswer}
              onNotesChange={setAskNotes}
              onOtherChange={setAskOtherText}
              onSubmit={() => void submitAsk()}
              onReject={() => void rejectAsk()}
            />
          </div>
        )}
        <PermissionConfirmCard />
      </div>
      <div className="bottom-stack">
        <AgentInputBox />
      </div>
    </div>
  )
}