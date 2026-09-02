import { useCallback } from 'react'
import { api } from '../lib/api.js'
import { useAgentStoreOrCtxApi, type AgentMessage } from '../store/useAgentStore.js'

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
    opts?: {
      skipPushUserMsg?: boolean
      /** slash 指令原始输入(`/cmd args`):随展开 prompt 一起上送,服务端按此落可见行 */
      commandText?: string
    },
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
  // 2026-09-02:必须在 hook 顶层取 store api(Modal 内 AgentInputBox 通过
  // Provider 注入 intake store,callback 内 `useAgentStoreOrCtxApi()` 会触发
  // "Invalid hook call")。closure 引用 storeApi,运行时跟着 Context 切换。
  const storeApi = useAgentStoreOrCtxApi()
  const pushUserMsg = useCallback(
    (text: string, isRenderedPrompt = false, attachments: PendingAttachmentLike[] = []) => {
      storeApi.setState((s) => ({
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
    [storeApi],
  )

  const submitPrompt = useCallback(
    async (text: string, opts?: { skipPushUserMsg?: boolean; commandText?: string }) => {
      const s = storeApi.getState()
      // zai race fix (2026-08-28): `creatingSession` 是 store 层标记
      // createNewSession 异步窗口(50–200ms)的字段 — 此期间 sid 必为
      // null,fallback 到 activeSessionId 反而会把消息发到旧 session,
      // 也会 phantom race 出错。`creatingSession=true` → fail loud 放弃。
      // 非 race 状态下保留原 `sessionId || activeSessionId` fallback。
      if (s.creatingSession) {
        console.warn(
          '[useSubmitPrompt] called during createNewSession race window; aborting POST to avoid phantom session.',
        )
        return
      }
      const sid = s.sessionId || s.activeSessionId || undefined
      if (!sid) {
        console.warn(
          '[useSubmitPrompt] no sessionId and no activeSessionId; aborting POST.',
        )
        return
      }
      const resp = await api.post<{
        sessionId: string
        queued?: boolean
      }>('/agent/prompt', {
        prompt: text || undefined,
        ...(opts?.commandText ? { displayText: opts.commandText } : {}),
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
      storeApi.setState({
        sessionId: returnedSessionId,
        activeSessionId: returnedSessionId,
      })
      // 会话标题取用户原始输入(指令场景是 `/cmd args`,不是展开提示词)。
      const localTitle = deriveLocalTitle(opts?.commandText ?? text)
      if (localTitle) {
        storeApi.getState().applySessionEvent({
          type: 'session.renamed',
          sessionId: returnedSessionId,
          title: localTitle,
          eventId: `session-renamed-${returnedSessionId}`,
          ts: Date.now(),
        })
      }
    },
    [pushUserMsg, storeApi],
  )

  return { submitPrompt, pushUserMsg }
}

// 保留 export 给测试/调试使用 — 类型与 AgentInputBox.PendingAttachment 对齐。
export type { PendingAttachmentLike }
