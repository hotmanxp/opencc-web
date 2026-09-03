import { Alert, Button, Modal, Space, Typography } from 'antd'
import { useEffect, useMemo, useRef, useState } from 'react'
import AgentConversation from '../../pages/AgentConversation'
import {
  AgentStoreContext,
  createAgentStore,
  type AgentMessage,
  type AgentStoreApi,
} from '../../store/useAgentStore'
import { useSuperTaskStore } from '../../store/useSuperTaskStore'
import {
  createAgentSession, deleteAgentSession, pickLastSelectedModel,
} from '../../lib/agentSessionApi'
import { checkSuperTaskIntakeDocs, fetchFactorySettings } from '../../lib/superTaskApi'
import { api } from '../../lib/api'
import { subscribeServerEvents, type StreamHandle } from '../../lib/eventSource'
import { applyBatchTo } from '../../store/useEventStream'
import { useAgentStore } from '../../store/useAgentStore'
import { LIGHT_PAGE_VARS } from './lightThemeVars'

const INTAKE_SESSION_KEY = 'zai-intake-session'
const INTAKE_MAIN_AGENT = 'task-intake'

/**
 * NewSuperTaskModal — 新建任务对话窗口(2026-09-02 隔离修复)。
 *
 * 之前实现是把全局 useAgentStore.sessionId 切到 intake 会话,导致主管
 * Layout 上的 `<AgentConversation>` 也跟着展示 intake 对话 —— 这是用户
 * 报告的"主管与创建 Modal 输出相同内容"的根因。
 *
 * 当前实现改用 **独立的 intake agentStore**(走 createAgentStore() factory)
 * 通过 `<AgentStoreContext.Provider>` 注入 Modal 内的 AgentConversation
 * 子树,Modal 自己挂 `/api/event?sid={intakeSid}` 的 EventSource,intake
 * 会话的 SSE 帧按 sid 路由到 `applyBatchTo(intakeStore, ...)` —— 主管
 * Layout 完全无感。
 *
 * 生命周期:
 *  - 打开:若 localStorage 记有未完成 draft sid(且仍在 sessions 列表)→
 *    先出「继续讨论 / 新开(删旧)」选择;否则直接新建 intake 会话。
 *  - 期间:intake store 切到 intake sid(SSE/输入/ask 卡全部作用于该会话),
 *    全局 useAgentStore.sessionId 保持不动(主管对话不被污染)。
 *  - created 信号:弹窗打开后出现新的 task_factory.created(SSE →
 *    superTaskStore.lastCreatedTaskId)→ 顶部完成条 + 「完成并关闭」。
 *  - 关闭:任务已创建 → 删除 intake 会话(纪要已归档任务目录);未创建 →
 *    保留 draft(供下次恢复继续聊)。
 *
 * Modal 卸载时 useMemo 创建的 intake store 引用随 GC 自然回收(没有模块级
 * 单例副作用),定时器/订阅 跟随 store 内部 closure 关闭,无泄漏。
 */
export default function NewSuperTaskModal({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}): JSX.Element {
  // intake-scoped 独立 store 实例。每个 Modal 打开周期一份,关闭后随 useMemo
  // 清理掉引用。createAgentStore 是从 useAgentStore.ts 导出的 factory —— 完全
  // 独立的 zustand store,reducer 与全局 useAgentStore 同源但状态完全隔离。
  const intakeStore = useMemo<AgentStoreApi>(() => createAgentStore(), [])
  const [intakeSid, setIntakeSid] = useState<string | null>(null)
  const [resumeDraft, setResumeDraft] = useState<string | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // intake 文档 gate(2026-09-03):关闭校验失败时记录缺失文档清单,弹窗保持
  // 打开并展示 warning + 「强制关闭」;补齐后再点「完成并关闭」重新过 gate。
  const [docGateMissing, setDocGateMissing] = useState<string[] | null>(null)
  const createdBaselineRef = useRef<string | null>(null)
  const streamHandleRef = useRef<StreamHandle | null>(null)
  const lastCreatedTaskId = useSuperTaskStore((s) => s.lastCreatedTaskId)

  // 读取 intake store 内的 sessionId/status,只在 Modal 内生效。
  const sessionId = intakeStore((s) => s.sessionId)
  const status = intakeStore((s) => s.status)

  const createdId =
    lastCreatedTaskId && lastCreatedTaskId !== createdBaselineRef.current
      ? lastCreatedTaskId
      : null

  // 关掉已挂的 EventSource。sid 切换 / Modal 卸载 / intake sid 被删都走它,
  // 避免重复订阅或句柄泄漏。
  function closeIntakeStream(): void {
    streamHandleRef.current?.close()
    streamHandleRef.current = null
  }

  // intake sid 改变时挂上自己的 EventSource;事件走 applyBatchTo(intakeStore, ...)
  // 写入 intake store,不会触及全局 useAgentStore(主管 Layout 完全无感)。
  // 注意:onState 回调有意保持空 —— 链接状态指示器只服务于全局顶栏 / Modal
  // 内的 status 都是 intake store 内部状态,无需推 useAppStore。
  useEffect(() => {
    if (!intakeSid) {
      closeIntakeStream()
      return
    }
    closeIntakeStream()
    const handle = subscribeServerEvents(
      intakeSid,
      (event) => applyBatchTo(intakeStore, [event]),
    )
    streamHandleRef.current = handle
    return () => {
      handle.close()
      streamHandleRef.current = null
    }
  }, [intakeSid, intakeStore])

  async function startFresh(deleteDraft?: string | null): Promise<void> {
    setBusy(true)
    setBootError(null)
    try {
      if (deleteDraft) await deleteAgentSession(deleteDraft)
      // model/providerId 继承走全局 useAgentStore 的 sessions 列表 —— 只读,
      // 不动全局 sessionId。intake store 自己的 sessions 字段此时为空,
      // 这里直接喂给它即可。
      const globalSessions = useAgentStore.getState().sessions
      // 工厂设置 docsDir(tf-pnsl5m5e):非空时作为需求讨论会话的逻辑 cwd
      // (后端写 CwdStore);读取失败 / 未配置 → 维持现状(实例 cwd)。
      let intakeCwd: string | undefined
      try {
        const settings = await fetchFactorySettings()
        if (settings.docsDir) intakeCwd = settings.docsDir
      } catch {
        // no-op — docsDir 未配置或服务暂不可达,按现状建会话
      }
      const sid = await createAgentSession({
        mainAgent: INTAKE_MAIN_AGENT,
        ...(intakeCwd ? { cwd: intakeCwd } : {}),
        ...pickLastSelectedModel(globalSessions),
      })
      try { window.localStorage.setItem(INTAKE_SESSION_KEY, sid) } catch { /* quota */ }
      // 关键:切的是 intake store 的 sessionId,不是全局 useAgentStore。
      intakeStore.getState().setCurrentSession(sid)
      setIntakeSid(sid)
      setResumeDraft(null)
    } catch (err) {
      setBootError(err instanceof Error ? err.message : '创建需求讨论会话失败')
    } finally {
      setBusy(false)
    }
  }

  function resumeDraftSession(sid: string): void {
    // 同样只切 intake store。
    intakeStore.getState().setCurrentSession(sid)
    setIntakeSid(sid)
    setResumeDraft(null)
  }

  // 打开:无需记录"原主管 sid" —— 全局 useAgentStore.sessionId 在 Modal 期间
  // 完全不变,关闭也不需要恢复。created 信号仍用 baseline ref 防止重渲染
  // 时的重复触发。
  useEffect(() => {
    if (!open) return
    createdBaselineRef.current = useSuperTaskStore.getState().lastCreatedTaskId
    // draft 检测在全局 sessions 列表里做(全局 sidebar 才是 sessions 真源)。
    const globalSessions = useAgentStore.getState().sessions
    let draft: string | null = null
    try { draft = window.localStorage.getItem(INTAKE_SESSION_KEY) } catch { /* disabled */ }
    if (draft && globalSessions.some((x) => x.sessionId === draft)) {
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

  // 关闭:不再需要 setCurrentSession 恢复(全局 sid 本来就没动);只清理
  // intake 资源 —— intake store 本身随 Modal 卸载被 useMemo 回收;intake
  // 会话视 created 决定删/留。
  //
  // intake 文档 gate(2026-09-03):任务已创建且非强制关闭时,先校验
  // docs/spec.md / docs/plan.md / docs/brainstorm.md 是否已填实质内容;
  // 缺失 → 拦截关闭,把缺失清单作为消息回流 intake 会话引导 AI 补全。
  // 校验接口异常时 fail open(放行关闭),避免服务端故障把用户困在弹窗里。
  async function handleClose(force = false): Promise<void> {
    const sid = intakeSid
    const done = Boolean(createdId)
    if (done && sid && !force) {
      setBusy(true)
      let check: Awaited<ReturnType<typeof checkSuperTaskIntakeDocs>> | null = null
      try {
        check = await checkSuperTaskIntakeDocs(createdId as string)
      } catch (err) {
        console.warn('[NewSuperTaskModal] intake-check failed; fail open:', err)
      } finally {
        setBusy(false)
      }
      if (check && !check.ok) {
        setDocGateMissing(check.missing)
        await notifyIntakeGateMissing(sid, createdId as string, check.missing)
        return
      }
      setDocGateMissing(null)
    }
    setBusy(true)
    try {
      if (sid) {
        if (done) {
          await deleteAgentSession(sid)
          try { window.localStorage.removeItem(INTAKE_SESSION_KEY) } catch { /* disabled */ }
          useSuperTaskStore.getState().clearLastCreated()
        }
      }
      closeIntakeStream()
    } finally {
      setIntakeSid(null)
      setResumeDraft(null)
      setBootError(null)
      setDocGateMissing(null)
      setBusy(false)
      onClose()
    }
  }

  // 把缺失文档清单回流到 intake 会话:走 /agent/prompt(服务端同 session
  // 串行,streaming 中自动 queued),并像 useSubmitPrompt 一样做乐观本地
  // 上屏(queued 分支交给 AgentInputBox 的 queue watcher,避免重复)。
  async function notifyIntakeGateMissing(sid: string, taskId: string, missing: string[]): Promise<void> {
    const text = [
      `[intake-gate] Document check failed for task ${taskId}.`,
      `The following required docs are missing or still contain only skeleton placeholders: ${missing.join(', ')}.`,
      'Per the intake workflow, complete them NOW in the task storage directory with Write/Edit:',
      'docs/spec.md / docs/plan.md with the discussed content (replace the skeleton placeholders),',
      'and docs/brainstorm.md with the discussion minutes (goal, acceptance criteria, key decisions',
      'with rationale, scope boundaries, confirmed priority + dependsOn). After filling them in,',
      'briefly report what was added — the user will then close this modal again.',
    ].join(' ')
    try {
      const resp = await api.post<{ sessionId: string; queued?: boolean }>('/agent/prompt', {
        prompt: text,
        sessionId: sid,
      }, { headers: { 'X-Session-Id': sid } })
      if (resp.queued !== true) {
        intakeStore.setState((s) => ({
          status: 'streaming' as const,
          messages: [
            ...s.messages,
            {
              eventId: `user-${Date.now()}-gate`,
              sessionId: '',
              ts: Date.now(),
              turnIndex: 0,
              type: 'user.text' as const,
              text,
              isRenderedPrompt: false,
              attachments: [],
            } as AgentMessage,
          ],
          sendSeq: s.sendSeq + 1,
        }))
      }
    } catch (err) {
      console.warn('[NewSuperTaskModal] failed to inject intake-gate feedback:', err)
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
        {docGateMissing && (
          <Alert
            type="warning"
            showIcon
            data-testid="intake-gate-warning"
            message={`文档校验未通过:缺少 ${docGateMissing.join('、')}`}
            description="已向对话中的 AI 发送补全要求,请等它补齐后再点「完成并关闭」;确需跳过可用「强制关闭」。"
            style={{ borderRadius: 0 }}
            action={(
              <Button size="small" danger disabled={busy} onClick={() => void handleClose(true)}>
                强制关闭
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
          <AgentStoreContext.Provider value={intakeStore}>
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              {/* intake/supervisor 临时对话不需要「分享到 LAN」与「插件管理」
                  入口 — 主管讨论是单设备内对齐意图的过程,挂上反而干扰。 */}
              <AgentConversation hideShareAndPlugin />
            </div>
          </AgentStoreContext.Provider>
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