import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Drawer,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Tag,
  message,
} from 'antd'
import { ThunderboltOutlined, FolderOpenOutlined, PictureOutlined, CheckCircleOutlined } from '@ant-design/icons'
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
import { readImageAsBase64, ImageReadError } from '../../lib/imageReader'
import { subscribeServerEvents, type StreamHandle } from '../../lib/eventSource'
import { applyBatchTo } from '../../store/useEventStream'
import AgentConversation from '../../pages/AgentConversation'
import DirectoryPicker from '../common/DirectoryPicker.js'
import QuickAttachmentStrip, { type QuickAttachment } from './QuickAttachmentStrip.js'
import DrawerPullHandle from './DrawerPullHandle'
import { LIGHT_PAGE_VARS } from './lightThemeVars'

/** 优先级单选(zai patch 2026-09-02)。 */
type QuickPriority = 'P0' | 'P1' | 'P2' | 'P3'
const QUICK_PRIORITIES: QuickPriority[] = ['P0', 'P1', 'P2', 'P3']
const DEFAULT_QUICK_PRIORITY: QuickPriority = 'P2'

/** 单次快速创建最多附加 8 张图片(超过截断 + message.warning)。 */
const MAX_IMAGES_PER_QUICK = 8

// crypto.randomUUID() 在 insecure context 下抛异常 (HTTP 非 localhost).
// happy-dom / LAN 模式下访问 zai 的场景 (192.168.x.x) 走 HTTP. 这里兜底到
// 时间戳+随机数,仅用于本地 React key 用,不参与任何 cryptographic 用途。
// 与 AgentInputBox.tsx:75-84 行为一致,不复用 — 那边没 export。
function genLocalId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    /* ignore */
  }
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 子 agent 选择 —— 与 spawn-agent provider 名单对齐(2026-09-03)。 */
const QUICK_AGENT_OPTIONS = [
  { value: 'opencc', label: 'opencc(默认)' },
  { value: 'dsh', label: 'dsh' },
  { value: 'opencode', label: 'opencode' },
] as const

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
 * QuickCreateModal — 「快速创建」弹窗(zai patch 2026-09-05,tf-vy72blq6)。
 *
 * 形态分两段:
 *   - 表单态(默认):用户填 description(必填)+ priority / cwd / agent /
 *     dependsOn 可选字段;**没有 title 输入框**(2026-09-05,tf-429i39sy 去掉)——
 *     后端 SuperTasksCreate 仍要求 title 字段必有值,提交时由 client 从
 *     description 第一行截取「标题」(`deriveTitleFromDescription`)作为
 *     task.yaml 的 title 用。
 *   - 对话态(提交后):表单字段打包成第一轮 prompt,创建 task-intake-quick 主
 *     agent 会话;modal 不关闭,切到 chat mode。复用 intake-scoped AgentStore +
 *     EventSource(SSE) + AgentConversation 子组件 —— 复用 NewSuperTaskModal
 *     的模式,但用 quick 专用的 intake researcher (lite) 主 agent,弧长 1-3 轮。
 *
 * 流程骨架:
 *   1. 用户填表单 + (可选)上传图片附件
 *   2. 提交 → /api/fs/upload 上传图片 → createAgentSession(mainAgent: task-intake-quick)
 *      → 把表单字段打成结构化 prompt(含 attachments bullet-list)发 /agent/prompt
 *      → intake researcher 在 cwd 里做研究、提问、给出方案(方案以 `## DESIGN_READY`
 *      单行 marker 收尾)
 *   3. 用户在 chat 里回答 / 追加上下文;agent 反复澄清,最多 3 轮
 *   4. agent 出方案 → 「确认建任务」按钮 enabled → 用户点击 → 触发第二次
 *      /agent/prompt 发「确认」→ agent 在那一轮调 SuperTasksCreate(mode: "quick")
 *      → 服务端落盘 + SSE `task_factory.created` → modal 切换到完成条 + 「完成」按钮
 *   5. 「取消」按钮随时可点:删除 intake 会话 + 关闭 modal,无任务创建
 *   6. 「完成」按钮 → 删除 intake 会话 + clearLastCreated + 关闭 modal
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
 *  - intake 文档 gate 不调 checkSuperTaskIntakeDocs(quick 任务后端只校验 spec.md)。
 *
 * `fullscreen` prop(2026-09-04):参考 `NewSuperTaskModal.fullscreen` —— 仅影响
 *  Modal 容器尺寸(width / top / 圆角 / 内层高度);表单 / 提交 / SSE /
 * created 信号逻辑一律不变。桌面 SuperTaskPanel 调用点不传 → 行为 100%
 * 兼容(仍 640px 居中,16px body padding)。
 *
 * `mobileAsDrawer` prop(2026-09-04,跟随 tf-cy9x9kjh):`true` 时把 `<Modal>`
 * 容器换成 `<Drawer placement="bottom" height="90%">`,顶部带 24px 拖把可下拉
 * 关闭;表单 / 提交 / SSE / created 信号逻辑零改动。`fullscreen` 与
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
   * 关闭;表单 / 提交 / SSE / created 信号逻辑零改动。`fullscreen` 与
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
  const finishedTasks = useSuperTaskStore((s) => s.buckets.finished)

  // 默认 cwd = 当前实例 cwd。提交时如果用户清空,回退到 process.cwd 字符串
  // (后端 createPoolTask 自己也会回退 process.cwd(),这里仅作 UI 提示)。
  const defaultCwd = useMemo(() => {
    try { return useAgentStore.getState().cwd ?? '' } catch { return '' }
  }, [])

  // tf-429i39sy 2026-09-05:去掉 title 输入项 —— 后端 SuperTasksCreate 仍要求
  // title 字段(task.yaml 的 title 顶层字段必须有内容),由 `deriveTitleFromDescription`
  // 从 description 第一行截取最多 50 字作为 title,提交时塞给 task-intake-quick。
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<QuickPriority>(DEFAULT_QUICK_PRIORITY)
  const [cwd, setCwd] = useState(defaultCwd)
  const [agent, setAgent] = useState<string>('opencc')
  const [dependsOn, setDependsOn] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // cwd picker 状态(tf-ch7u2cyt 2026-09-05):cw d 字段右侧「选择目录」按钮打开
  // 共享 DirectoryPicker Modal;选中 → onSelect 回填 cwd + 关闭 picker。
  const [cwdPickerOpen, setCwdPickerOpen] = useState(false)
  // 图片附件状态(tf-ch7u2cyt 2026-09-05):用户选 / 黏贴图后进入 reading → ready,
  // 提交流程用 ready 项调用 /api/fs/upload 拿 absPath。
  const [attachments, setAttachments] = useState<QuickAttachment[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  // 任务已创建 → 显示完成条;打开弹窗时通过 baseline ref 屏蔽历史 created 信号。
  const createdBaselineRef = useRef<string | null>(null)
  const createdTaskId =
    lastCreatedTaskId && lastCreatedTaskId !== createdBaselineRef.current
      ? lastCreatedTaskId
      : null
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  // chat mode(zai patch 2026-09-05,tf-vy72blq6):提交表单后切到对话态,在 modal
  // 内嵌 AgentConversation 显示 intake researcher 的研究 / 提问 / 方案输出;
  // modal 不关闭,直到用户「取消」(无任务)或「确认建任务」(agent 调
  // SuperTasksCreate → task_factory.created SSE → 完成条)。
  const [chatMode, setChatMode] = useState(false)
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

  // 打开时:重置表单 + 记录 created baseline(防止上一轮的 created 信号误触发本轮)。
  useEffect(() => {
    if (!open) return
    createdBaselineRef.current = useSuperTaskStore.getState().lastCreatedTaskId
    setDescription('')
    setPriority(DEFAULT_QUICK_PRIORITY)
    setCwd(defaultCwd)
    setAgent('opencc')
    setDependsOn([])
    setError(null)
    setActiveSessionId(null)
    setChatMode(false)
    setConfirming(false)
    setCancelling(false)
    setCwdPickerOpen(false)
    setAttachments((prev) => {
      // 重置前 revoke 旧缩略图,避免 blob URL 内存泄漏(用户重新打开弹窗时无残留)
      prev.forEach((a) => URL.revokeObjectURL(a.thumbnailUrl))
      return []
    })
  }, [open, defaultCwd])

  // 组件卸载时清理所有 blob URL(走完整重置路径之外的兜底,
  // 例如父级直接 unmount QuickCreateModal 而非切回 open=false 时)。
  useEffect(() => {
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      attachments.forEach((a) => URL.revokeObjectURL(a.thumbnailUrl))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleSubmit(): Promise<void> {
    const d = description.trim()
    if (!d) return // 必填校验(UI 上按钮已 disabled,这里双保险)
    setSubmitting(true)
    setError(null)
    try {
      // 先并发上传所有 ready 图片(失败项用 allSettled 收集,继续后续步骤)
      const readyAtts = attachments.filter((a) => a.status === 'ready')
      const uploadResults = await Promise.allSettled(
        readyAtts.map((att) => uploadImage(att)),
      )
      const readyPaths: string[] = []
      let failedCount = 0
      for (const r of uploadResults) {
        if (r.status === 'fulfilled') {
          readyPaths.push(r.value)
        } else {
          failedCount += 1
        }
      }
      // 全部失败:阻断,不调 /agent/prompt
      if (readyAtts.length > 0 && readyPaths.length === 0) {
        throw new Error(`所有图片上传失败(共 ${readyAtts.length} 张),请重试或移除`)
      }
      const globalSessions = useAgentStore.getState().sessions
      const finalCwd = cwd.trim() || defaultCwd || undefined
      const sid = await createAgentSession({
        mainAgent: 'task-intake-quick',
        ...(finalCwd ? { cwd: finalCwd } : {}),
        ...pickLastSelectedModel(globalSessions),
      })
      setActiveSessionId(sid)
      // 关键(tfa-vy72blq6):把 intake session 切到独立 intakeStore,modal 内的
      // AgentConversation 通过 AgentStoreContext 读这个 store。Modal 关闭 /
      // unmount 时 intakeStore 引用随 useState GC,无需手动销毁。
      intakeStore.getState().setCurrentSession(sid)
      // 喂第一轮 prompt —— 把表单内容结构化交给 task-intake-quick。
      // title 从 description 第一行截取(后端 SuperTasksCreate 仍要求 title
      // 非空,task.yaml 的 title 顶层字段必须有内容)。
      const title = deriveTitleFromDescription(d)
      const prompt = buildQuickPrompt({
        title, description: d, priority,
        cwd: finalCwd ?? '', agent, dependsOn,
        attachments: readyPaths,
      })
      const resp = await api.post<{ sessionId: string; queued?: boolean }>('/agent/prompt', {
        prompt, sessionId: sid,
      }, { headers: { 'X-Session-Id': sid } })
      if (!resp?.sessionId) {
        throw new Error('submit prompt failed: empty sessionId')
      }
      // 成功后清空附件(thumbnailUrl blob URL 随 strip 卸载 GC,无需主动 revoke)
      setAttachments([])
      if (failedCount > 0) {
        // 部分失败:message.warning 告知,但不阻断后续流程
        message.warning(`${failedCount} 张图片上传失败,未包含在附件清单中`)
      }
      // 切到 chat mode(tfa-vy72blq6):modal 不关闭,改渲染 AgentConversation +
      // 「确认建任务」/「取消」按钮。intake researcher 的研究/提问/方案输出
      // 都会进 intakeMessages。等 task_factory.created SSE → 显示完成条 →
      // 「完成」按钮(handleDone),或用户主动「取消」(handleCancel)。
      setChatMode(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建任务失败')
    } finally {
      setSubmitting(false)
    }
  }

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
    setSubmitting(true)
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
      setSubmitting(false)
      setActiveSessionId(null)
      setChatMode(false)
      onClose()
    }
  }

  // 图片附件 helpers(tf-ch7u2cyt 2026-09-05):
  // - addImages 接收 File[],slice(0, MAX) + 8 上限截断 + message.warning
  //   + 并发 readImageAsBase64(10MB / jpeg+png+gif+webp 校验)
  //   + status: 'reading' → 'ready' | 'error'
  // - removeAttachment 删除单条并 revokeObjectURL 缩略图
  // - handlePaste 拦截 image/* 黏贴,非图走默认
  // - handleFilePick 监听隐藏 input[accept=image/*, multiple]
  async function addImages(files: File[]): Promise<void> {
    if (files.length > MAX_IMAGES_PER_QUICK) {
      message.warning(`最多 ${MAX_IMAGES_PER_QUICK} 张图片,已截断`)
    }
    const accepted = files.slice(0, MAX_IMAGES_PER_QUICK)
    const placeholders: QuickAttachment[] = accepted.map((f) => ({
      localId: genLocalId(),
      mime: f.type,
      size: f.size,
      filename: f.name || 'image.png',
      dataUrl: '',
      thumbnailUrl: URL.createObjectURL(f),
      status: 'reading',
    }))
    setAttachments((prev) => [...prev, ...placeholders])
    await Promise.all(
      placeholders.map(async (p, i) => {
        try {
          const r = await readImageAsBase64(accepted[i]!)
          setAttachments((prev) =>
            prev.map((a) =>
              a.localId === p.localId
                ? { ...a, dataUrl: r.dataUrl, status: 'ready' }
                : a,
            ),
          )
        } catch (e) {
          const msg =
            e instanceof ImageReadError
              ? e.message
              : e instanceof Error
                ? e.message
                : String(e)
          setAttachments((prev) =>
            prev.map((a) =>
              a.localId === p.localId
                ? { ...a, status: 'error', error: msg }
                : a,
            ),
          )
        }
      }),
    )
  }

  function removeAttachment(localId: string): void {
    setAttachments((prev) => {
      const att = prev.find((a) => a.localId === localId)
      if (att) URL.revokeObjectURL(att.thumbnailUrl)
      return prev.filter((a) => a.localId !== localId)
    })
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const files: File[] = []
    for (const item of e.clipboardData.items) {
      if (item.kind === 'file') {
        const f = item.getAsFile()
        if (f && f.type.startsWith('image/')) files.push(f)
      }
    }
    if (files.length === 0) return // 走 antd 默认文本粘贴
    e.preventDefault()
    void addImages(files)
  }

  function handleFilePick(e: React.ChangeEvent<HTMLInputElement>): void {
    const files = Array.from(e.target.files ?? [])
    if (files.length === 0) return
    void addImages(files)
    e.target.value = ''
  }

  // 单张图片上传到 ~/.zai/uploads/<name>(后端 /api/fs/upload 决定路径,
  // 2026-09-05 迁出 cwd-relative 改为用户级固定目录,跨实例 cwd 稳定)。
  // 走磁盘 + 路径引用,不依赖模型视觉能力,跨模型稳定。
  // absPath 由后端响应返回;失败抛错由 handleSubmit 的 allSettled 收集。
  async function uploadImage(att: QuickAttachment): Promise<string> {
    const data = att.dataUrl.replace(/^data:[^;]+;base64,/, '')
    const res = await fetch('/api/fs/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: att.filename, data }),
    })
    const body = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as { ok: boolean; error?: string; absPath?: string }
    if (!res.ok || !body.ok) {
      throw new Error(body.error ?? `HTTP ${res.status}`)
    }
    if (!body.absPath) throw new Error('上传响应缺少 absPath')
    return body.absPath
  }

  // tf-429i39sy 2026-09-05:canSubmit 只看 description,title 由 client 自动
  // 从 description 截取。
  // tf-ch7u2cyt 2026-09-05:加入图片附件状态校验 —— 还在 reading 阻断,
  // 有附件但全部失败也阻断(canSubmit === false → 按钮 disabled).
  const hasReading = attachments.some((a) => a.status === 'reading')
  const readyCount = attachments.filter((a) => a.status === 'ready').length
  const hasAnyAttachment = attachments.length > 0
  const canSubmit = description.trim().length > 0
    && !submitting
    && !hasReading
    && (!hasAnyAttachment || readyCount > 0)

  // mobileAsDrawer 优先于 fullscreen —— drawer body 自带 90% 容器尺寸,
  // 内层用 100% 撑满 drawer body;fullscreen 仅用于桌面 fullscreen Modal。
  // chat mode 走独立内层样式(填满高度 + flex column),允许 AgentConversation
  // 占满剩余空间;表单态保持原 padding-only。
  const innerStyle = mobileAsDrawer
    ? { height: '100%', overflow: 'hidden' as const, display: 'flex', flexDirection: 'column' as const }
    : fullscreen
      ? { height: '100dvh', overflow: 'hidden' as const, display: 'flex', flexDirection: 'column' as const }
      : chatMode
        ? { height: '70vh', overflow: 'hidden' as const, display: 'flex', flexDirection: 'column' as const }
        : { padding: 16 }

  /**
   * chat mode 渲染块(tfa-vy72blq6):顶部状态栏(intake researcher 角色提示
   * + DESIGN_READY tag + 「取消」/「确认建任务」按钮)+ AgentConversation。
   * 设计要点:
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
            disabled={cancelling || submitting}
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
            <Button type="primary" size="small" disabled={submitting} onClick={() => void handleDone()}>
              完成
            </Button>
          )}
        />
      ) : chatMode ? (
        chatBodyContent
      ) : (
        <Form layout="vertical">
          <Form.Item
            label="描述(必填)"
            required
            help="详细说明需求 / 复现步骤 / 验收标准;quick 模式不写 plan.md / brainstorm.md。第一行会被自动截为 task 标题。"
          >
            <Input.TextArea
              data-testid="quick-description-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="例如:把 /m-super-tasks 顶栏「+ 新建」按钮文案「提交」改为「完成」。验收:PM 验收。"
              rows={4}
              autoFocus
              onPaste={handlePaste}
            />
          </Form.Item>
          {/*
            图片附件区(tf-ch7u2cyt 2026-09-05):
            - 「添加图片」按钮触发隐藏 input[accept=image/*, multiple];
            - 「也可用 Ctrl+V 黏贴截图」由 description TextArea 的 onPaste 处理;
            - 缩略图条 QuickAttachmentStrip 渲染 reading/ready/error 三态。
          */}
          <Form.Item label="附件图片">
            <Space wrap>
                <Button
                  icon={<PictureOutlined />}
                  data-testid="quick-image-picker-trigger"
                  onClick={() => fileInputRef.current?.click()}
                >
                  添加图片
                </Button>
                <span style={{ color: 'var(--text-dim-45)', fontSize: 12 }}>
                  也可在描述框 Ctrl+V 黏贴截图
                </span>
              </Space>
              <QuickAttachmentStrip items={attachments} onRemove={removeAttachment} disabled={submitting} />
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: 'none' }}
                onChange={handleFilePick}
              />
          </Form.Item>
          <Form.Item label="优先级">
            <Radio.Group
              data-testid="quick-priority-radio"
              value={priority}
              onChange={(e) => setPriority(e.target.value as QuickPriority)}
              optionType="button"
              buttonStyle="solid"
            >
              {QUICK_PRIORITIES.map((p) => (
                <Radio.Button key={p} value={p} data-priority={p}>{p}</Radio.Button>
              ))}
            </Radio.Group>
          </Form.Item>
          <Form.Item
            label={(
              <Space>
                <span>工作目录</span>
                <Button
                  size="small"
                  type="link"
                  onClick={() => setCwd(defaultCwd)}
                  disabled={!defaultCwd}
                >
                  使用当前实例 cwd
                </Button>
              </Space>
            )}
          >
            <Space.Compact style={{ width: '100%' }}>
              <Input
                data-testid="quick-cwd-input"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder={defaultCwd || '/absolute/path/to/repo'}
                style={{ flex: 1, minWidth: 0 }}
              />
              <Button
                icon={<FolderOpenOutlined />}
                data-testid="quick-cwd-picker-trigger"
                onClick={() => setCwdPickerOpen(true)}
              >
                选择目录
              </Button>
            </Space.Compact>
          </Form.Item>
          <Form.Item label="执行子 agent">
            <Select
              data-testid="quick-agent-select"
              value={agent}
              onChange={setAgent}
              options={[...QUICK_AGENT_OPTIONS]}
              style={{ width: 220 }}
            />
          </Form.Item>
          <Form.Item
            label={(
              <Space>
                <span>依赖任务(多选)</span>
                <span style={{ color: 'var(--text-tertiary, #999)', fontSize: 12 }}>仅 finished 桶任务可选</span>
              </Space>
            )}
          >
            <Select
              data-testid="quick-depends-on-select"
              mode="multiple"
              value={dependsOn}
              onChange={(v: string[]) => setDependsOn(v)}
              placeholder="可不选;选中的 finished 任务必须 status=done 才允许派发"
              options={finishedTasks.map((t) => ({
                value: t.id,
                label: `${t.id} · ${t.title}`,
              }))}
              allowClear
              style={{ width: '100%' }}
              notFoundContent="暂无 finished 任务"
            />
          </Form.Item>
          {error && (
            <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button onClick={onClose} disabled={submitting}>取消</Button>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={submitting}
              disabled={!canSubmit}
              data-testid="quick-submit-button"
              onClick={() => void handleSubmit()}
            >
              快速创建
            </Button>
          </div>
        </Form>
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
      <>
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
        {/*
          cwd picker (tf-ch7u2cyt):Drawer 容器外另挂一个 Modal 形态的 picker。
          antd Drawer 不允许再内嵌一个 Modal(嵌套 Modal 弹层有时出栈有问题),
          放在 Drawer 外部作为 sibling 渲染即可。close 路径走父级 onSelect
          内 setCwdPickerOpen(false) + 同步 setCwd 写入表单。
        */}
        <DirectoryPicker
          open={cwdPickerOpen}
          initialPath={cwd.trim() || defaultCwd}
          onCancel={() => setCwdPickerOpen(false)}
          onSelect={(p) => {
            setCwd(p)
            setCwdPickerOpen(false)
          }}
        />
      </>
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
      <DirectoryPicker
        open={cwdPickerOpen}
        initialPath={cwd.trim() || defaultCwd}
        onCancel={() => setCwdPickerOpen(false)}
        onSelect={(p) => {
          setCwd(p)
          setCwdPickerOpen(false)
        }}
      />
    </Modal>
  )
}

/**
 * 把表单内容打包成 task-intake-quick 第一轮 prompt 的结构化文本。
 * 注意:不要嵌入 'brainstorming' / 'plan.md' / 'brainstorm.md' 字样
 * (task-intake-quick 的 systemPrompt 禁词;后端模型会拒绝)。
 *
 * 顺序约束(tf-ch7u2cyt 2026-09-05):`attachments:` 段必须在 `Pass mode: "quick"`
 * 行之前插入,确保模型先看到附件清单再被告知 quick 模式约束(从磁盘读图由
 * task-intake-quick 的 Read 工具负责,与 prompt 顺序无关,但视觉上让模型
 * 一次看完所有上下文更稳)。
 */
function buildQuickPrompt(input: {
  title: string; description: string; priority: QuickPriority
  cwd: string; agent: string; dependsOn: string[]
  attachments?: string[]
}): string {
  const lines: string[] = [
    `Create a quick task with the following fields:`,
    `- title: ${input.title}`,
    `- description: ${input.description}`,
    `- priority: ${input.priority}`,
    ...(input.cwd ? [`- cwd: ${input.cwd}`] : []),
    `- agent: ${input.agent}`,
    ...(input.dependsOn.length > 0
      ? [`- dependsOn: [${input.dependsOn.join(', ')}]`]
      : []),
  ]
  // attachments 段在 Pass mode 行之前插入
  if (input.attachments && input.attachments.length > 0) {
    lines.push('', 'attachments (absolute paths, Read these if you need to see them):')
    for (const p of input.attachments) {
      lines.push(`- ${p}`)
    }
  }
  lines.push(
    '',
    'Pass mode: "quick" when calling SuperTasksCreate. Do NOT generate a planning doc or meeting minutes — quick mode keeps the directory lean by design.',
  )
  return lines.join('\n')
}

/**
 * 从 description 截出 task.yaml 的 title —— tf-429i39sy 2026-09-05:QuickCreateModal
 * 去掉了 title 输入框,但 SuperTasksCreate 工具仍要求 title 字段(task.yaml 顶层
 * title 必有值),所以 client 端在提交时把 description 的第一行截取(去掉首尾空白、
 * 单行长度 50 字上限、超过 50 字用 ellipsis 收尾)直接当成 title 喂给后端。
 *
 * 实现要点:
 *  - 先 trim(去掉首尾空白 + 换行),再取首个换行前的内容(只截一行,多行描述不会把第二行塞进 title);
 *  - 限制在 50 字以内,超过则截断并加 '…';
 *  - 极端空 / 仅空白 → fallback 'quick task'(title 不能为空,后端 zod 校验过不去)。
 */
const QUICK_TITLE_MAX_LEN = 50
export function deriveTitleFromDescription(description: string): string {
  const trimmed = description.trim()
  if (!trimmed) return 'quick task'
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? trimmed
  if (firstLine.length <= QUICK_TITLE_MAX_LEN) return firstLine
  return `${firstLine.slice(0, QUICK_TITLE_MAX_LEN)}…`
}
