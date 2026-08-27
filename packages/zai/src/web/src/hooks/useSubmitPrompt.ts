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
      // 关键: 等 sessionId 真有值才 POST。`s.sessionId || s.activeSessionId || undefined`
      // 在 + click 后到 setSessionId(newSid) 之间的 ~50–200ms 空窗里会变成
      // undefined。如果这时 POST,server `?? newServerSid()` 又造一个
      // **phantom** session(空 sid),runtime 起来后所有 events 写到空 sid 的
      // historyBySid,但 SSE 订阅的是 + click 的 sid → events 全部丢失,
      // UI 一直 "就绪"。Send button 已经在 sessionId 为空时 disabled,
      // 但 Enter 键 / 编程触发可能绕过,这里加最后一道兜底。
      let sid = s.sessionId
      if (!sid) {
        // 不静默吞掉,打 console 让用户在 dev tools 能看到;
        // 也不弹 toast(避免噪声)。retry 一次,50ms 后再读一次(常见场景是
        // createNewSession 的 fetch 即将完成),若仍空就直接放弃。
        await new Promise((r) => setTimeout(r, 50))
        sid = useAgentStore.getState().sessionId
        if (!sid) {
          console.warn(
            '[useSubmitPrompt] sessionId not ready after 50ms, abort POST to avoid phantom session',
          )
          return
        }
      }
      const resp = await api.post<{
        sessionId: string
        queued?: boolean
      }>('/agent/prompt', {
        prompt: text || undefined,
        sessionId: sid,
      }, {
        headers: { 'X-Session-Id': sid },
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
