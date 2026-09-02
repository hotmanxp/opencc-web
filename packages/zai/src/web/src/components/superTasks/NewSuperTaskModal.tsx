import { Alert, Button, Modal, Space, Typography } from 'antd'
import { useEffect, useRef, useState } from 'react'
import AgentConversation from '../../pages/AgentConversation'
import { useAgentStore } from '../../store/useAgentStore'
import { useSuperTaskStore } from '../../store/useSuperTaskStore'
import {
  createAgentSession, deleteAgentSession, pickLastSelectedModel,
} from '../../lib/agentSessionApi'
import { LIGHT_PAGE_VARS } from './lightThemeVars'

const INTAKE_SESSION_KEY = 'zai-intake-session'
const INTAKE_MAIN_AGENT = 'task-intake'

/**
 * NewSuperTaskModal — 新建任务对话窗口(2026-09-02 改造)。
 *
 * 不再是表单:打开即建一条独立的 **task-intake 会话**(POST /api/agent/sessions
 * 带 mainAgent,transcript 与主管会话完全隔离),内嵌 AgentConversation 对话流。
 * task-intake agent 走 brainstorming 与用户聊需求,收敛后调 SuperTasksCreate
 * 落库并把纪要写入任务目录 docs/brainstorm.md。
 *
 * 生命周期:
 *  - 打开:若 localStorage 记有未完成 draft sid(且仍在 sessions 列表)→
 *    先出「继续讨论 / 新开(删旧)」选择;否则直接新建 intake 会话。
 *  - 期间:store 切到 intake sid(SSE/输入/ask 卡全部作用于该会话),关闭时
 *    恢复原主管会话 sid。
 *  - created 信号:弹窗打开后出现新的 task_factory.created(SSE →
 *    superTaskStore.lastCreatedTaskId)→ 顶部完成条 + 「完成并关闭」。
 *  - 关闭:任务已创建 → 删除 intake 会话(纪要已归档任务目录);未创建 →
 *    保留 draft(供下次恢复继续聊)。
 */
export default function NewSuperTaskModal({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}): JSX.Element {
  const [intakeSid, setIntakeSid] = useState<string | null>(null)
  const [resumeDraft, setResumeDraft] = useState<string | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const prevSidRef = useRef<string | null>(null)
  const createdBaselineRef = useRef<string | null>(null)
  const lastCreatedTaskId = useSuperTaskStore((s) => s.lastCreatedTaskId)
  const sessionId = useAgentStore((s) => s.sessionId)
  const status = useAgentStore((s) => s.status)

  const createdId =
    lastCreatedTaskId && lastCreatedTaskId !== createdBaselineRef.current
      ? lastCreatedTaskId
      : null

  async function startFresh(deleteDraft?: string | null): Promise<void> {
    setBusy(true)
    setBootError(null)
    try {
      if (deleteDraft) await deleteAgentSession(deleteDraft)
      const s = useAgentStore.getState()
      const sid = await createAgentSession({
        mainAgent: INTAKE_MAIN_AGENT,
        ...pickLastSelectedModel(s.sessions),
      })
      try { window.localStorage.setItem(INTAKE_SESSION_KEY, sid) } catch { /* quota */ }
      await s.loadSessions()
      s.setCurrentSession(sid)
      setIntakeSid(sid)
      setResumeDraft(null)
    } catch (err) {
      setBootError(err instanceof Error ? err.message : '创建需求讨论会话失败')
    } finally {
      setBusy(false)
    }
  }

  function resumeDraftSession(sid: string): void {
    const s = useAgentStore.getState()
    s.setCurrentSession(sid)
    void s.loadTranscript(sid)
    setIntakeSid(sid)
    setResumeDraft(null)
  }

  // 打开:暂存当前(主管)会话 sid,决定 恢复/新建。
  useEffect(() => {
    if (!open) return
    const s = useAgentStore.getState()
    prevSidRef.current = s.sessionId
    createdBaselineRef.current = useSuperTaskStore.getState().lastCreatedTaskId
    let draft: string | null = null
    try { draft = window.localStorage.getItem(INTAKE_SESSION_KEY) } catch { /* disabled */ }
    if (draft && s.sessions.some((x) => x.sessionId === draft)) {
      setResumeDraft(draft)
      setIntakeSid(null)
      return
    }
    if (draft) {
      try { window.localStorage.removeItem(INTAKE_SESSION_KEY) } catch { /* disabled */ }
    }
    void startFresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 关闭:一律恢复原主管会话;已建任务则删掉 intake 会话,未建保留草稿。
  async function handleClose(): Promise<void> {
    const sid = intakeSid
    const done = Boolean(createdId)
    setBusy(true)
    try {
      const s = useAgentStore.getState()
      if (prevSidRef.current) s.setCurrentSession(prevSidRef.current)
      if (sid) {
        if (done) {
          await deleteAgentSession(sid)
          try { window.localStorage.removeItem(INTAKE_SESSION_KEY) } catch { /* disabled */ }
          useSuperTaskStore.getState().clearLastCreated()
          void s.loadSessions()
        }
      }
    } finally {
      setIntakeSid(null)
      setResumeDraft(null)
      setBootError(null)
      setBusy(false)
      onClose()
    }
  }

  return (
    <Modal
      open={open}
      onCancel={() => void handleClose()}
      footer={null}
      width={720}
      destroyOnHidden
      title="新建任务 · 需求讨论"
      styles={{ body: { padding: 0 } }}
    >
      <div
        style={{
          ...LIGHT_PAGE_VARS,
          // Modal 走 portal 挂在 document.body 下,拿不到页面根 div 上的亮色
          // CSS 变量;不在此重注入一份,AgentConversation 的 var(--bg-body) 会
          // 解析回全局暗色主题 → 黑底 + 暗色文字低对比(2026-09-02 用户反馈)。
          background: '#eef2f7',
          color: 'var(--text-primary, #1f2937)',
          display: 'flex',
          flexDirection: 'column',
          height: '68vh',
        }}
      >
        {createdId && (
          <Alert
            type="success"
            showIcon
            message={`任务 ${createdId} 已创建,讨论纪要将归档到任务目录 docs/brainstorm.md`}
            style={{ borderRadius: 0 }}
            action={(
              <Button type="primary" size="small" disabled={busy || status === 'streaming'} onClick={() => void handleClose()}>
                完成并关闭
              </Button>
            )}
          />
        )}
        {resumeDraft && (
          <Alert
            type="info"
            showIcon
            message="检测到未完成的需求讨论"
            style={{ borderRadius: 0 }}
            action={(
              <Space>
                <Button size="small" onClick={() => resumeDraftSession(resumeDraft)}>继续</Button>
                <Button size="small" disabled={busy} onClick={() => void startFresh(resumeDraft)}>新开</Button>
              </Space>
            )}
          />
        )}
        {bootError && (
          <Alert
            type="error"
            showIcon
            message={bootError}
            style={{ borderRadius: 0 }}
            action={(
              <Button size="small" disabled={busy} onClick={() => void startFresh()}>重试</Button>
            )}
          />
        )}
        {intakeSid && sessionId === intakeSid ? (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <AgentConversation />
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Typography.Text type="secondary">
              {busy ? '正在准备需求讨论会话…' : resumeDraft ? '请选择继续未完成的讨论,或新开一轮。' : '准备中…'}
            </Typography.Text>
          </div>
        )}
      </div>
    </Modal>
  )
}
