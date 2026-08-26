import { useCallback } from 'react'
import { api } from '../lib/api.js'
import { useAgentStore, type AgentMessage } from '../store/useAgentStore.js'

const TITLE_MAX_LEN = 50

export function deriveLocalTitle(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0]!.trim()
  if (!firstLine) return ''
  if (firstLine.length <= TITLE_MAX_LEN) return firstLine
  return firstLine.slice(0, TITLE_MAX_LEN - 1) + '…'
}

export interface UseSubmitPromptResult {
  submitPrompt: (
    text: string,
    opts?: { skipPushUserMsg?: boolean },
  ) => Promise<void>
  pushUserMsg: (
    text: string,
    isRenderedPrompt?: boolean,
    attachments?: PendingAttachmentLike[],
  ) => void
}

interface PendingAttachmentLike {
  localId: string
  mime: string
  filename: string
  // thumbnailUrl 是 objectURL, MessageBubble.AttachmentStrip 用来渲染缩略图;
  // 不写入 server 持久化, 仅前端 transient 渲染用. 上传时由 AgentInputBox
  // 通过 URL.createObjectURL(file) 创建.
  thumbnailUrl: string
  base64DataUrl: string
  status: 'reading' | 'ready' | 'error'
}

export function useSubmitPrompt(): UseSubmitPromptResult {
  const pushUserMsg = useCallback(
    (text: string, isRenderedPrompt = false, attachments: PendingAttachmentLike[] = []) => {
      useAgentStore.setState((s) => ({
        status: 'streaming' as const,
        messages: [
          ...s.messages,
          {
            eventId: `user-${Date.now()}-${isRenderedPrompt ? 'r' : 'o'}`,
            sessionId: '',
            ts: Date.now(),
            turnIndex: 0,
            type: 'user.text',
            text,
            isRenderedPrompt,
            attachments,
          } as AgentMessage,
        ],
        sendSeq: s.sendSeq + 1,
      }))
    },
    [],
  )

  const submitPrompt = useCallback(
    async (text: string, opts?: { skipPushUserMsg?: boolean }) => {
      const s = useAgentStore.getState()
      const sid = s.sessionId || s.activeSessionId || undefined
      const resp = await api.post<{
        sessionId: string
        queued?: boolean
      }>('/agent/prompt', {
        prompt: text || undefined,
        sessionId: sid,
      }, {
        headers: sid ? { 'X-Session-Id': sid } : undefined,
      })
      // 排队(对话进行中提交): 消息不立即写 transcript, 由 queue.changed
      // 事件在真正开始执行时由 AgentInputBox watcher pushUserMsg。
      // 仅"立即执行"才乐观写入, 保持原有即时反馈。
      if (!opts?.skipPushUserMsg && resp.queued !== true) {
        pushUserMsg(text)
      }
      const returnedSessionId = resp.sessionId
      useAgentStore.setState({
        sessionId: returnedSessionId,
        activeSessionId: returnedSessionId,
      })
      const localTitle = deriveLocalTitle(text)
      if (localTitle) {
        useAgentStore.getState().applySessionEvent({
          type: 'session.renamed',
          sessionId: returnedSessionId,
          title: localTitle,
          eventId: `session-renamed-${returnedSessionId}`,
          ts: Date.now(),
        })
      }
    },
    [pushUserMsg],
  )

  return { submitPrompt, pushUserMsg }
}

// 保留 export 给测试/调试使用 — 类型与 AgentInputBox.PendingAttachment 对齐。
export type { PendingAttachmentLike }
