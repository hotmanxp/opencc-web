import { useState, useRef, useEffect, useMemo, type CSSProperties } from 'react'
import { Typography, Button } from 'antd'
import { RobotFilled, UpOutlined } from '@ant-design/icons'
import {
  useAgentStoreOrCtx,
  useAgentStoreOrCtxApi,
} from '../store/useAgentStore'
import { useAppStore } from '../store/useAppStore'
import QuestionCard from '../components/QuestionCard.jsx'
import PermissionConfirmCard from '../components/PermissionConfirmCard.jsx'
import TodoZone from '../components/TodoZone.jsx'
import AgentInputBox, { type AgentInputBoxProps } from '../components/AgentInputBox'
import { MessageListView } from '../components/transcript/MessageListView.js'
import { useAutoScrollToBottom } from '../hooks/useAutoScrollToBottom'

const { Paragraph } = Typography

/**
 * Agent.tsx 的对话核心 — 抽出来供 MobileAgent / Desktop 复用。
 * 只负责:消息裁剪 + 渲染 + QuestionCard + AgentInputBox + 自动滚动 + Esc 中断。
 * 不负责:左侧 sessions 栏、右侧 SplitPane、ConfigStatusBar、Drawer 容器。
 * 这些由调用方(Agent.tsx / MobileAgent.tsx / Desktop.tsx)各自决定怎么挂。
 *
 * 工具栏定制(AgentInputBoxProps 透传):分屏等场景专属按钮不内置在
 * AgentInputBox,由调用方经 toolbarLeftSlot / toolbarRightSlot 插槽注入;
 * transcript 修复按钮默认隐藏,showTranscriptRepair 显式开启(/agent)。
 *
 * 移动端判断走 useAppStore.isMobile (由 useIsMobile() hook 在 Layout 顶部
 * 同步), 不再走 props, 让组件树更扁.
 */
export default function AgentConversation({
  toolbarLeftSlot,
  toolbarRightSlot,
  showTranscriptRepair,
  hideShareAndPlugin,
  showModelPicker,
  bottomStackStyle,
}: AgentInputBoxProps & { bottomStackStyle?: CSSProperties } = {}) {
  const messages = useAgentStoreOrCtx((s) => s.messages)
  const maxVisibleMessages = useAppStore((s) => s.maxVisibleMessages)
  const outputStyle = useAppStore((s) => s.outputStyle)
  const isMobile = useAppStore((s) => s.isMobile)
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

  const status = useAgentStoreOrCtx((s) => s.status)
  const sessionId = useAgentStoreOrCtx((s) => s.sessionId)
  const transcriptCollapsed = useAgentStoreOrCtx((s) => s.transcriptCollapsed)
  const pendingAsk = useAgentStoreOrCtx((s) => s.pendingAsk)
  const setAskAnswer = useAgentStoreOrCtx((s) => s.setAskAnswer)
  const setAskNotes = useAgentStoreOrCtx((s) => s.setAskNotes)
  const setAskOtherText = useAgentStoreOrCtx((s) => s.setAskOtherText)
  const submitAsk = useAgentStoreOrCtx((s) => s.submitAsk)
  const rejectAsk = useAgentStoreOrCtx((s) => s.rejectAsk)

  const v2TasksBySession = useAgentStoreOrCtx((s) => s.v2TasksBySession)
  const v2TasksForCurrentSession =
    sessionId != null ? (v2TasksBySession[sessionId] ?? []) : []

  const stop = useAgentStoreOrCtx((s) => s.stop)
  const questionCardRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const autoScroll = useAutoScrollToBottom(scrollContainerRef)

  useEffect(() => {
    if (pendingAsk) {
      questionCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
      return
    }
    // 补传 folded + messagesRef,激活 useAutoScrollToBottom 的折叠视图 fallback 路径:
    //   - folded=true 时 CollapsedMessageBubble 的 maxHeight:140 clamp 让 outer
    //     scrollHeight 失真, contentGrew=false 但 store 真的写过新数据 (引用换),
    //     hook 内部规则 #3.5 用 messagesRefChanged 兜底 follow。
    //   - expanded 视图下这两个 opts 是 noop (folded=false 走原路径, messagesRef
    //     仅作 hook 内部 prevMessagesRef 缓存)。
    autoScroll.scrollToBottom(messages.length, {
      folded: transcriptCollapsed,
      messagesRef: messages,
    })
  }, [messages, pendingAsk, transcriptCollapsed, autoScroll])

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
      className="flex-1 flex flex-col min-w-0 max-w-full overflow-x-hidden"
      style={{
        paddingTop: isMobile ? 0 : 20,
      }}
    >
      <div
        ref={scrollContainerRef}
        className="flex-1 min-h-0 overflow-y-auto max-w-full overflow-x-hidden mb-1 bg-[var(--bg-body)] px-2"
      >
        {messages.length === 0 && (
          <div className="text-center mt-20 text-[var(--text-tertiary)]">
            <RobotFilled className="text-5xl mb-4 text-[var(--accent-start)]" />
            <Paragraph type="secondary">发送消息开始与 AI Agent 对话</Paragraph>
            <Paragraph type="secondary" className="text-xs">
              支持文件搜索、读写文件和 Bash 执行
            </Paragraph>
          </div>
        )}
        <TodoZone tasks={v2TasksForCurrentSession} />
        {showPill && (
          <div className="sticky top-0 z-10 flex justify-center pt-2 pb-1">
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
      <div className="bottom-stack" style={bottomStackStyle}>
        <AgentInputBox
          toolbarLeftSlot={toolbarLeftSlot}
          toolbarRightSlot={toolbarRightSlot}
          showTranscriptRepair={showTranscriptRepair}
          hideShareAndPlugin={hideShareAndPlugin}
          showModelPicker={showModelPicker}
        />
      </div>
    </div>
  )
}