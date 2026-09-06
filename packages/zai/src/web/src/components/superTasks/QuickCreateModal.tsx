import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Drawer,
  Modal,
  Space,
  Tag,
  message,
} from 'antd'
import { ThunderboltOutlined, CheckCircleOutlined } from '@ant-design/icons'
import { api } from '../../lib/api'
import { useSuperTaskStore } from '../../store/useSuperTaskStore'
import {
  createAgentSession, deleteAgentSession, pickLastSelectedModel,
} from '../../lib/agentSessionApi'
import {
  AgentStoreContext,
  createAgentStore,
  type AgentMessage,
  type AgentStoreApi,
  useAgentStore,
} from '../../store/useAgentStore'
import { subscribeServerEvents, type StreamHandle } from '../../lib/eventSource'
import { applyBatchTo } from '../../store/useEventStream'
import AgentConversation from '../../pages/AgentConversation'
import DrawerPullHandle from './DrawerPullHandle'
import { LIGHT_PAGE_VARS } from './lightThemeVars'

/**
 * 「设计方案」marker(2026-09-05,tf-vy72blq6):intake researcher (lite) 在出方案
 * 后输出一行 `## DESIGN_READY`(独立行),前端用这个 regex 在 intakeMessages 里
 * 扫描,命中后把「确认建任务」按钮 enable —— 没看到 marker 之前用户不能点确认,
 * 防止 agent 在「我还在研究 / 还在问」状态被强制拉去 SuperTasksCreate。
 *
 * 匹配规则:`^## DESIGN_READY$`(行首,忽略前后空白,大小写不敏感)。
 * 反斜杠转义 + /m 多行 + /i 大小写忽略,允许 `## DESIGN_READY` 前后有换行或空格。
 */
const DESIGN_READY_RE = /^[\s>]*(?:##\s*)?DESIGN_READY[\s]*$/im

/**
 * QuickCreateModal — 「快速创建」弹窗(zai patch 2026-09-05,tf-vy72blq6;
 * 2026-09-06,tf-92b3cxad 改为纯对话式 intake)。
 *
 * 形态:弹窗打开**直接进入 chat mode**,无前置表单态。AgentConversation 内嵌
 * AgentInputBox 接管所有输入流(描述、cwd 调整、priority 调整、dependsOn、
 * 图片附件上传 —— 全部走 AgentInputBox 的标准上传器)。系统默认值
 * (priority=P2 / cwd=<实例 cwd> / agent=opencc / dependsOn=[])在 task-intake-quick
 * 第一段 systemPrompt 里告诉 intake researcher,用户在对话里说改即生效。
 *
 * 流程骨架:
 *   1. 弹窗打开 useEffect 立即调
 *      `createAgentSession({ mainAgent: 'task-intake-quick', cwd: defaultCwd, ...model })`
 *      → 拿 sid → setActiveSessionId + intakeStore.setCurrentSession(sid) →
 *      setChatMode(true)。
 *   2. AgentConversation + AgentInputBox 接管:用户在 chat 输入框打字 → 点提交
 *      → 走 `/agent/prompt` → intake researcher (lite) 在 cwd 做研究、提问、
 *      给出方案(以 `## DESIGN_READY` 单行 marker 收尾)。
 *   3. 用户在 chat 里回答 / 追加上下文;agent 反复澄清,最多 3 轮。
 *   4. agent 出方案 → 「确认建任务」按钮 enabled → 用户点击 → 触发第二次
 *      `/agent/prompt` 发「确认」→ agent 在那一轮调 SuperTasksCreate(mode: "quick")
 *      → 服务端落盘 + SSE `task_factory.created` → modal 切换到完成条 + 「完成」按钮。
 *   5. 「取消」按钮随时可点:删除 intake 会话 + 关闭 modal,无任务创建。
 *   6. 「完成」按钮 → 删除 intake 会话 + clearLastCreated + 关闭 modal。
 *
 * 「设计方案」识别:agent 在每条 assistant.text 消息末尾输出 `## DESIGN_READY`
 * 单独一行 marker 时,前端把 designReady 翻成 true,「确认建任务」按钮 enable。
 * Marker 缺失 → 用户只能「取消」,不能直接确认(避免提前调 SuperTasksCreate)。
 *
 * intake 文档 gate:quick 模式只校验 docs/spec.md(由后端 createPoolTask 写好),
 * 不调 checkSuperTaskIntakeDocs(与 NewSuperTaskModal 的 full intake 三件套
 * 不同)。agent 输出 intake-gate 报错时(后端 spec.md 缺失),agent自己用
 * Write 补全,前端不需要做任何事。
 *
 * 与 NewSuperTaskModal 的根本差异:
 *  - intake 主 agent 是 task-intake-quick(intake researcher lite,1-3 轮),
 *    不是 task-intake(完整 brainstorming,3-7 轮);
 *  - AgentConversation 嵌进 Modal 但 Modal 容器仍是 640px 居中 / drawer /
 *    fullscreen(由 prop 决定),chat mode 渲染紧凑;
 *  - intake 文档 gate 不调 checkSuperTaskIntakeDocs(quick 任务后端只校验 spec.md);
 *  - 2026-09-06 改造:无前置表单态,所有输入走 AgentInputBox(描述 / 附件 / cwd /
 *    priority / dependsOn 等)对话式提交;QuickCreateModal 只负责「建 session +
 *    切 chat mode + 提供确认建任务 / 取消 / 完成 三个 modal 级动作」。
 *
 * `fullscreen` prop(2026-09-04):参考 `NewSuperTaskModal.fullscreen` —— 仅影响
 * Modal 容器尺寸(width / top / 圆角 / 内层高度);chat mode 渲染与 SSE /
 * created 信号逻辑一律不变。桌面 SuperTaskPanel 调用点不传 → 行为 100%
 * 兼容(仍 640px 居中,16px body padding)。
 *
 * `mobileAsDrawer` prop(2026-09-04,跟随 tf-cy9x9kjh):`true` 时把 `<Modal>`
 * 容器换成 `<Drawer placement="bottom" height="90%">`,顶部带 24px 拖把可下拉
 * 关闭;chat mode / SSE / created 信号逻辑零改动。`fullscreen` 与
 * `mobileAsDrawer` 同时为 true 时 `mobileAsDrawer` 优先(drawer 自带 90%
 * 容器尺寸,`fullscreen` 在 mobile 上不再被采用)。桌面调用点不传 → 走
 * 640px 居中 Modal。
 */
export default function QuickCreateModal({
  open,
  onClose,
  fullscreen = false,
  /**
   * 移动端抽屉式(2026-09-04,跟随 tf-cy9x9kjh):`true` 时把 `<Modal>` 容器
   * 换成 `<Drawer placement="bottom" height="90%">`,顶部带 24px 拖把可下拉
   * 关闭;chat mode / SSE / created 信号逻辑零改动。`fullscreen` 与
   * `mobileAsDrawer` 同时为 true 时 `mobileAsDrawer` 优先(drawer 自带 90%
   * 容器尺寸,`fullscreen` 在 mobile 上不再被采用)。桌面调用点不传 → 走
   * 640px 居中 Modal。
   */
  mobileAsDrawer = false,
}: {
  open: boolean
  onClose: () => void
  fullscreen?: boolean
  mobileAsDrawer?: boolean
}): JSX.Element {
  const lastCreatedTaskId = useSuperTaskStore((s) => s.lastCreatedTaskId)
  const clearLastCreated = useSuperTaskStore((s) => s.clearLastCreated)

  // 默认 cwd = 当前实例 cwd。createAgentSession 用它当 mainAgent 的 cwd 入参;
  // intake researcher 在后续 SuperTasksCreate 调用时如果在对话里被改 cwd,
  // 用新 cwd(用户在 chat 里说「在 xxx 项目」即生效)。
  const defaultCwd = useMemo(() => {
    try { return useAgentStore.getState().cwd ?? '' } catch { return '' }
  }, [])

  // 任务已创建 → 显示完成条;打开弹窗时通过 baseline ref 屏蔽历史 created 信号。
  const createdBaselineRef = useRef<string | null>(null)
  const createdTaskId =
    lastCreatedTaskId && lastCreatedTaskId !== createdBaselineRef.current
      ? lastCreatedTaskId
      : null
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  // chat mode(zai patch 2026-09-05,tf-vy72blq6;2026-09-06 改造):
  // 弹窗打开即 chat mode,无前置表单态。AgentConversation + AgentInputBox 接管
  // 所有输入;intake researcher 在 chat 里读到用户首句话 + 系统默认值,然后
  // 出方案(`## DESIGN_READY`)→ 用户点「确认建任务」→ agent 调
  // SuperTasksCreate → task_factory.created SSE → 完成条。
  const [chatMode, setChatMode] = useState(true)
  // intake-scoped AgentStore:每个 modal 生命周期一份独立 store,通过
  // AgentStoreContext 注入子树 —— 与 NewSuperTaskModal 完全相同的隔离模式,
  // 避免 intake 的 SSE / 输入污染全局 useAgentStore(调度器 Layout)。
  // useMemo 而非 useState 是为了避开 happy-dom 严格模式双调 initialValue
  // 时 useState 的 setter 语义陷阱(zustand create() 在双调下会创建两个
  // store,后续 useState setState 会把引用切到第一个 store 造成
  // "Should not already be working" 渲染崩溃)。
  const intakeStore = useMemo<AgentStoreApi>(() => createAgentStore(), [])
  const intakeMessages = intakeStore((s) => s.messages)
  const intakeSessionId = intakeStore((s) => s.sessionId)
  const intakeStatus = intakeStore((s) => s.status)
  const streamHandleRef = useRef<StreamHandle | null>(null)
  // 「确认建任务」按钮发送中的局部 busy(intake researcher 在那一轮调
  // SuperTasksCreate,等服务端 SSE task_factory.created 才能切完成条)。
  const [confirming, setConfirming] = useState(false)
  // 「取消」按钮的局部 busy(关 stream + 删 session + 关闭 modal)。
  const [cancelling, setCancelling] = useState(false)
  // createAgentSession 失败时(网络/API):红条 + 不切 chat mode,等用户决定。
  const [error, setError] = useState<string | null>(null)
  // 「设计方案」识别(2026-09-05,tf-vy72blq6):扫描 intakeMessages 的 assistant
  // 文本,匹配独立一行的 `## DESIGN_READY` marker。命中后 designReady=true,
  // 「确认建任务」按钮 enable;翻成 true 后不再回退(用户已看到方案,后续
  // agent 消息不应让它 disabled)。
  const designReady = useMemo(() => {
    for (let i = intakeMessages.length - 1; i >= 0; i--) {
      const m = intakeMessages[i]
      if (m && (m as { type?: string }).type === 'assistant.text') {
        const text = String((m as { text?: string }).text ?? '')
        if (DESIGN_READY_RE.test(text)) return true
      }
    }
    return false
  }, [intakeMessages])

  // 关掉已挂的 EventSource。sid 切换 / Modal 卸载 / chat mode 关闭都走它,
  // 避免重复订阅或句柄泄漏。设计同 NewSuperTaskModal.closeIntakeStream。
  function closeIntakeStream(): void {
    streamHandleRef.current?.close()
    streamHandleRef.current = null
  }

  // chat mode 开启时挂 EventSource 把 SSE 帧路由到 intakeStore。Modal 卸载或
  // chatMode 关闭时 useEffect 清理函数自动 close。
  useEffect(() => {
    if (!chatMode || !intakeSessionId) {
      closeIntakeStream()
      return
    }
    closeIntakeStream()
    const handle = subscribeServerEvents(
      intakeSessionId,
      (event) => applyBatchTo(intakeStore, [event]),
    )
    streamHandleRef.current = handle
    return () => {
      handle.close()
      streamHandleRef.current = null
    }
  }, [chatMode, intakeSessionId, intakeStore])

  // 打开时:重置 created baseline(防止上一轮的 created 信号误触发本轮),
  // 并立即进入 chat mode(2026-09-06 改造:无前置表单态)。
  useEffect(() => {
    if (!open) return
    createdBaselineRef.current = useSuperTaskStore.getState().lastCreatedTaskId
    setActiveSessionId(null)
    setChatMode(true)
    setConfirming(false)
    setCancelling(false)
    setError(null)
  }, [open])

  // 打开后立即建 intake session(2026-09-06 改造):
  // - open=true + chatMode=true(由上面 useEffect 置) + 还没建过 session
  //   → createAgentSession({ mainAgent: 'task-intake-quick', cwd: defaultCwd, ...model })
  // - 拿到 sid 后 setActiveSessionId + intakeStore.setCurrentSession(sid)
  // - 失败 setError:createAgentSession 失败时仍切 chat mode,但 intakeStore
  //   sessionId 为空 → AgentConversation 内 AgentInputBox 提交时会自己抛错,
  //   modal 这边用红条兜底。
  useEffect(() => {
    if (!open || !chatMode || activeSessionId) return
    let cancelled = false
    void (async () => {
      try {
        const sid = await createAgentSession({
          mainAgent: 'task-intake-quick',
          cwd: defaultCwd || undefined,
          ...pickLastSelectedModel(useAgentStore.getState().sessions),
        })
        if (cancelled) return
        setActiveSessionId(sid)
        intakeStore.getState().setCurrentSession(sid)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : '建 intake session 失败')
      }
    })()
    return () => { cancelled = true }
  }, [open, chatMode, activeSessionId, defaultCwd, intakeStore])

  /**
   * 「确认建任务」按钮(tfa-vy72blq6):designReady=true 时 enable;点击后向
   * intake session 发「确认」消息,intake researcher (lite) 在那一轮调
   * SuperTasksCreate(mode: "quick")。成功后会触发 task_factory.created SSE,
   * createdTaskId 检测自动把 modal 切到完成条;失败则在 intake store 里显示
   * agent 报错,用户可继续追问或点取消。
   */
  async function handleConfirm(): Promise<void> {
    const sid = intakeStore.getState().sessionId
    if (!sid) return
    if (!designReady) {
      message.warning('intake researcher 还未出方案,无法确认建任务')
      return
    }
    setConfirming(true)
    setError(null)
    try {
      const text = '确认建任务'
      const resp = await api.post<{ sessionId: string; queued?: boolean }>('/agent/prompt', {
        prompt: text, sessionId: sid,
      }, { headers: { 'X-Session-Id': sid } })
      if (!resp?.sessionId) {
        throw new Error('confirm prompt failed: empty sessionId')
      }
      // 非 queued 路径(本地快速回包,服务端还没排到 SSE):乐观本地上一条 user.text
      // 防止 SSE 推回的 user 消息重复展示。queued=true 时让 SSE 自己推。
      if (resp.queued !== true) {
        intakeStore.setState((s) => ({
          status: 'streaming' as const,
          messages: [
            ...s.messages,
            {
              eventId: `user-${Date.now()}-confirm`,
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
      // 不立即关 chat mode —— 等 task_factory.created SSE 触发 createdTaskId
      // 检测,modal 自然切到完成条。期间 chat 仍可继续交流(用户可能改主意)。
    } catch (err) {
      setError(err instanceof Error ? err.message : '确认建任务失败')
    } finally {
      setConfirming(false)
    }
  }

  /**
   * 「取消」按钮(tfa-vy72blq6):任何 chat 阶段都能点,关闭 modal + 删除 intake
   * 会话,无任务创建。打开新弹窗时 reset useEffect 会清空 chatMode,这里只
   * 负责清理本轮的资源(stream / session)再调 onClose。
   */
  async function handleCancel(): Promise<void> {
    setCancelling(true)
    try {
      closeIntakeStream()
      const sid = intakeStore.getState().sessionId
      if (sid) {
        await deleteAgentSession(sid).catch(() => { /* best-effort */ })
      }
      setActiveSessionId(null)
      setChatMode(false)
    } finally {
      setCancelling(false)
      onClose()
    }
  }

  async function handleDone(): Promise<void> {
    setConfirming(true)
    try {
      // quick 模式任务已由后端落盘 task.yaml + process.md + 最小 docs/spec.md,
      // 不需要额外的 intake 文档校验或纪要归档。关掉临时会话即可。
      closeIntakeStream()
      const sid = intakeStore.getState().sessionId
      if (sid) {
        await deleteAgentSession(sid).catch(() => { /* best-effort */ })
      } else if (activeSessionId) {
        await deleteAgentSession(activeSessionId).catch(() => { /* best-effort */ })
      }
      clearLastCreated()
    } finally {
      setConfirming(false)
      setActiveSessionId(null)
      setChatMode(false)
      onClose()
    }
  }

  // mobileAsDrawer 优先于 fullscreen —— drawer body 自带 90% 容器尺寸,
  // 内层用 100% 撑满 drawer body;fullscreen 仅用于桌面 fullscreen Modal。
  // chat mode 走独立内层样式(填满高度 + flex column),允许 AgentConversation
  // 占满剩余空间。
  const innerStyle = mobileAsDrawer
    ? { height: '100%', overflow: 'hidden' as const, display: 'flex', flexDirection: 'column' as const }
    : fullscreen
      ? { height: '100dvh', overflow: 'hidden' as const, display: 'flex', flexDirection: 'column' as const }
      : { height: '70vh', overflow: 'hidden' as const, display: 'flex', flexDirection: 'column' as const }

  /**
   * chat mode 渲染块(tfa-vy72blq6;2026-09-06 改造为唯一渲染态):
   * 顶部状态栏(intake researcher 角色提示 + DESIGN_READY tag + 「取消」/
   * 「确认建任务」按钮)+ AgentConversation。设计要点:
   *  - intakeStore 通过 AgentStoreContext 注入子树,SSE 路由与全局 useAgentStore
   *    隔离(同 NewSuperTaskModal 模式);
   *  - 「确认建任务」按钮在 designReady=false 时 disabled,message.warning 兜底;
   *  - intakeStatus='streaming' 时也允许点确认(用户在 agent 还在打字时已经看到
   *    方案了),只对「取消」做双重 busy 防护。
   */
  const chatBodyContent = (
    <div
      data-testid="quick-chat-mode"
      style={{
        ...LIGHT_PAGE_VARS,
        // chat mode 用亮色背景(同 NewSuperTaskModal):AgentConversation 内部
        // 的 var(--bg-body) 解析拿不到 portal 内的 CSS 变量,这里直接喂一个
        // 浅色 var 兜底,避免暗色主题下黑底 + 暗色文字低对比。
        background: '#eef2f7',
        color: 'var(--text-primary, #1f2937)',
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        data-testid="quick-chat-toolbar"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '8px 12px',
          borderBottom: '1px solid var(--border-color, #e5e7eb)',
          flexShrink: 0,
        }}
      >
        <Space size={8} wrap>
          <ThunderboltOutlined style={{ color: '#fa8c16' }} />
          <span style={{ fontWeight: 500 }}>intake researcher (lite)</span>
          {designReady ? (
            <Tag icon={<CheckCircleOutlined />} color="success" data-testid="quick-chat-design-ready">
              方案已就绪
            </Tag>
          ) : (
            <Tag data-testid="quick-chat-design-pending">研究中 / 等待方案</Tag>
          )}
          {intakeStatus === 'streaming' && <Tag color="processing">AI 思考中</Tag>}
        </Space>
        <Space size={8}>
          <Button
            danger
            size="small"
            disabled={cancelling || confirming}
            data-testid="quick-chat-cancel-button"
            onClick={() => void handleCancel()}
          >
            取消
          </Button>
          <Button
            type="primary"
            size="small"
            icon={<CheckCircleOutlined />}
            loading={confirming}
            disabled={!designReady || confirming || cancelling}
            data-testid="quick-chat-confirm-button"
            onClick={() => void handleConfirm()}
          >
            确认建任务
          </Button>
        </Space>
      </div>
      {error && (
        <Alert
          type="error"
          showIcon
          message={error}
          style={{ borderRadius: 0, flexShrink: 0 }}
          closable
          onClose={() => setError(null)}
        />
      )}
      <AgentStoreContext.Provider value={intakeStore}>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <AgentConversation hideShareAndPlugin />
        </div>
      </AgentStoreContext.Provider>
    </div>
  )

  const bodyContent = (
    <div style={innerStyle}>
      {createdTaskId ? (
        <Alert
          type="success"
          showIcon
          message={`任务 ${createdTaskId} 已创建(quick 模式 · intake researcher lite)`}
          description="任务目录只生成 task.yaml + process.md + intake researcher 写入的厚 spec.md(无 planning doc);验证走轻量路径(build + lint + 关键文件 diff 的 code review)。"
          action={(
            <Button type="primary" size="small" disabled={confirming} onClick={() => void handleDone()}>
              完成
            </Button>
          )}
        />
      ) : chatMode ? (
        chatBodyContent
      ) : (
        // 2026-09-06 改造:不再有前置表单态;这条分支理论上只在极短窗口
        // (打开 useEffect 已 setChatMode(true),但 React 还未渲染时)被命中。
        // 留作防御性兜底,避免 chatMode=false 时空白。
        <div data-testid="quick-loading" style={{ padding: 24, color: 'var(--text-tertiary, #999)' }}>
          正在准备对话窗口…
        </div>
      )}
    </div>
  )

  // Drawer 顶部 X 关闭按钮会触发 onClose;created 状态下走 handleDone,
  // 其余直接 onClose(Modal / Drawer 行为对齐)。
  const handleContainerClose = (): void => {
    if (!createdTaskId) onClose()
  }

  if (mobileAsDrawer) {
    return (
      <Drawer
        open={open}
        onClose={handleContainerClose}
        placement="bottom"
        height="90%"
        destroyOnHidden={false}
        keyboard
        title={(
          <div>
            <DrawerPullHandle testId="quick-drawer-handle" onClose={handleContainerClose} />
            <Space style={{ display: 'flex', paddingBottom: 8 }}>
              <ThunderboltOutlined style={{ color: '#fa8c16' }} />
              <span>快速创建任务</span>
            </Space>
          </div>
        )}
        styles={{ body: { padding: 0 } }}
        data-testid="quick-mobile-drawer"
      >
        {bodyContent}
      </Drawer>
    )
  }

  return (
    <Modal
      open={open}
      onCancel={handleContainerClose}
      footer={null}
      width={fullscreen ? '100vw' : 640}
      style={fullscreen ? { top: 0, maxWidth: '100vw', margin: 0, paddingBottom: 0 } : undefined}
      destroyOnHidden
      title={(
        <Space>
          <ThunderboltOutlined style={{ color: '#fa8c16' }} />
          <span>快速创建任务</span>
        </Space>
      )}
      styles={{
        body: { padding: 0 },
        ...(fullscreen ? { content: { borderRadius: 0, padding: 0 } } : {}),
      }}
    >
      {bodyContent}
    </Modal>
  )
}
