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
  message,
} from 'antd'
import { ThunderboltOutlined, FolderOpenOutlined, PictureOutlined } from '@ant-design/icons'
import { api } from '../../lib/api'
import { useSuperTaskStore } from '../../store/useSuperTaskStore'
import {
  createAgentSession, deleteAgentSession, pickLastSelectedModel,
} from '../../lib/agentSessionApi'
import { useAgentStore } from '../../store/useAgentStore'
import { readImageAsBase64, ImageReadError } from '../../lib/imageReader'
import DirectoryPicker from '../common/DirectoryPicker.js'
import QuickAttachmentStrip, { type QuickAttachment } from './QuickAttachmentStrip.js'
import DrawerPullHandle from './DrawerPullHandle'

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
 * QuickCreateModal — 「快速创建」弹窗(zai patch 2026-09-04,quick-intake;
 * tf-429i39sy 2026-09-05 去掉 title 输入,只保留 description)。
 *
 * 与 NewSuperTaskModal(完整 intake 讨论窗口)并列 —— 表单驱动,无 conversation:
 *   1. 用户填 description(必填)+ priority / cwd / agent / dependsOn 可选字段;
 *      **没有 title 输入框**(2026-09-05 去掉) —— 后端 SuperTasksCreate 仍然要
 *      求 title 字段必有值,因此提交时由 client 从 description 第一行截取
 *      「标题」(`deriveTitleFromDescription`),作为 task.yaml 的 title 用;
 *   2. 提交时把表单内容打包成第一轮 prompt,创建 task-intake-quick 主 agent 会话
 *      (与 NewSuperTaskModal 走同样的 createAgentSession API,只是 mainAgent 不同);
 *   3. 监听 task_factory.created SSE → 显示完成条 + 「完成」按钮 → 关闭;
 *   4. intake 文档 gate 自动适配:quick 模式只校验 docs/spec.md,所以这里**不**
 *      调 checkSuperTaskIntakeDocs(quick 任务后端 intake gate 不会失败,后端
 *      在 createPoolTask 时已写好最小 spec.md;模型无法补脑写出 plan.md /
 *      brainstorm.md,也不会被 gate 拦截)。
 *
 * 与 NewSuperTaskModal 的根本差异:
 *  - 无 AgentConversation 子树(无对话 UI) —— 用纯表单拿数据;
 *  - 不挂 EventSource(SSE 通过 useSuperTaskStore.lastCreatedTaskId 收);
 *  - 不复用 intake store(根本没有 intake 会话,直接 create → 一次性发 prompt → 关闭);
 *  - 没有 title 输入项(quick 模式刻意去掉 —— 用户填描述就够了)。
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
      const globalSessions = useAgentStore.getState().sessions
      const finalCwd = cwd.trim() || defaultCwd || undefined
      const sid = await createAgentSession({
        mainAgent: 'task-intake-quick',
        ...(finalCwd ? { cwd: finalCwd } : {}),
        ...pickLastSelectedModel(globalSessions),
      })
      setActiveSessionId(sid)
      // 喂第一轮 prompt —— 把表单内容结构化交给 task-intake-quick。
      // title 从 description 第一行截取(后端 SuperTasksCreate 仍要求 title
      // 非空,task.yaml 的 title 顶层字段必须有内容)。
      const title = deriveTitleFromDescription(d)
      const prompt = buildQuickPrompt({
        title, description: d, priority,
        cwd: finalCwd ?? '', agent, dependsOn,
      })
      const resp = await api.post<{ sessionId: string; queued?: boolean }>('/agent/prompt', {
        prompt, sessionId: sid,
      }, { headers: { 'X-Session-Id': sid } })
      if (!resp?.sessionId) {
        throw new Error('submit prompt failed: empty sessionId')
      }
      // 成功提交 → 等 task_factory.created SSE → 显示完成条。
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建任务失败')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDone(): Promise<void> {
    setSubmitting(true)
    try {
      // quick 模式任务已由后端落盘 task.yaml + process.md + 最小 docs/spec.md,
      // 不需要额外的 intake 文档校验或纪要归档。关掉临时会话即可。
      if (activeSessionId) {
        await deleteAgentSession(activeSessionId).catch(() => { /* best-effort */ })
      }
      clearLastCreated()
    } finally {
      setSubmitting(false)
      setActiveSessionId(null)
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
  const innerStyle = mobileAsDrawer
    ? { height: '100%', overflow: 'auto' as const, padding: 16 }
    : fullscreen
      ? { height: '100dvh', overflow: 'auto' as const, padding: 16 }
      : { padding: 16 }

  const bodyContent = (
    <div style={innerStyle}>
      {createdTaskId ? (
        <Alert
          type="success"
          showIcon
          message={`任务 ${createdTaskId} 已创建(quick 模式 · 跳过 brainstorming)`}
          description="任务目录只生成 task.yaml + process.md + 最小 docs/spec.md;验证走轻量路径(build + lint + 关键文件 diff 的 code review)。"
          action={(
            <Button type="primary" size="small" disabled={submitting} onClick={() => void handleDone()}>
              完成
            </Button>
          )}
        />
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
 */
function buildQuickPrompt(input: {
  title: string; description: string; priority: QuickPriority
  cwd: string; agent: string; dependsOn: string[]
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
    '',
    'Pass mode: "quick" when calling SuperTasksCreate. Do NOT generate a planning doc or meeting minutes — quick mode keeps the directory lean by design.',
  ]
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
