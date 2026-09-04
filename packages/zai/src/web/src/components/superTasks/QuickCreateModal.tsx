import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  message,
} from 'antd'
import { ThunderboltOutlined } from '@ant-design/icons'
import { api } from '../../lib/api'
import { useSuperTaskStore } from '../../store/useSuperTaskStore'
import {
  createAgentSession, deleteAgentSession, pickLastSelectedModel,
} from '../../lib/agentSessionApi'
import { useAgentStore } from '../../store/useAgentStore'

/** 优先级单选(zai patch 2026-09-02)。 */
type QuickPriority = 'P0' | 'P1' | 'P2' | 'P3'
const QUICK_PRIORITIES: QuickPriority[] = ['P0', 'P1', 'P2', 'P3']
const DEFAULT_QUICK_PRIORITY: QuickPriority = 'P2'

/** 子 agent 选择 —— 与 spawn-agent provider 名单对齐(2026-09-03)。 */
const QUICK_AGENT_OPTIONS = [
  { value: 'opencc', label: 'opencc(默认)' },
  { value: 'dsh', label: 'dsh' },
  { value: 'opencode', label: 'opencode' },
] as const

/**
 * QuickCreateModal — 「快速创建」弹窗(zai patch 2026-09-04,quick-intake)。
 *
 * 与 NewSuperTaskModal(完整 intake 讨论窗口)并列 —— 表单驱动,无 conversation:
 *   1. 用户填 title / description / priority / cwd / agent / dependsOn 必填/可选字段;
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
 *  - 不复用 intake store(根本没有 intake 会话,直接 create → 一次性发 prompt → 关闭)。
 *
 * `fullscreen` prop(2026-09-04):参考 `NewSuperTaskModal.fullscreen` —— 仅影响
 *  Modal 容器尺寸(width / top / 圆角 / 内层高度);表单 / 提交 / SSE /
 * created 信号逻辑一律不变。桌面 SuperTaskPanel 调用点不传 → 行为 100%
 * 兼容(仍 640px 居中,16px body padding)。
 */
export default function QuickCreateModal({
  open,
  onClose,
  fullscreen = false,
}: {
  open: boolean
  onClose: () => void
  fullscreen?: boolean
}): JSX.Element {
  const lastCreatedTaskId = useSuperTaskStore((s) => s.lastCreatedTaskId)
  const clearLastCreated = useSuperTaskStore((s) => s.clearLastCreated)
  const finishedTasks = useSuperTaskStore((s) => s.buckets.finished)

  // 默认 cwd = 当前实例 cwd。提交时如果用户清空,回退到 process.cwd 字符串
  // (后端 createPoolTask 自己也会回退 process.cwd(),这里仅作 UI 提示)。
  const defaultCwd = useMemo(() => {
    try { return useAgentStore.getState().cwd ?? '' } catch { return '' }
  }, [])

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<QuickPriority>(DEFAULT_QUICK_PRIORITY)
  const [cwd, setCwd] = useState(defaultCwd)
  const [agent, setAgent] = useState<string>('opencc')
  const [dependsOn, setDependsOn] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
    setTitle('')
    setDescription('')
    setPriority(DEFAULT_QUICK_PRIORITY)
    setCwd(defaultCwd)
    setAgent('opencc')
    setDependsOn([])
    setError(null)
    setActiveSessionId(null)
  }, [open, defaultCwd])

  async function handleSubmit(): Promise<void> {
    const t = title.trim()
    const d = description.trim()
    if (!t || !d) return // 必填校验(UI 上按钮已 disabled,这里双保险)
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
      const prompt = buildQuickPrompt({
        title: t, description: d, priority,
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

  const canSubmit = title.trim().length > 0 && description.trim().length > 0 && !submitting

  return (
    <Modal
      open={open}
      onCancel={() => {
        if (!createdTaskId) onClose()
      }}
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
      <div style={fullscreen ? { height: '100dvh', overflow: 'auto', padding: 16 } : { padding: 16 }}>
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
            label="标题(必填)"
            required
            help="一句话写清要改什么 / 修什么 / 调什么。"
          >
            <Input
              data-testid="quick-title-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如:把按钮文案「提交」改为「完成」"
              maxLength={120}
              autoFocus
            />
          </Form.Item>
          <Form.Item
            label="描述(必填)"
            required
            help="详细说明需求 / 复现步骤 / 验收标准;quick 模式不写 plan.md / brainstorm.md。"
          >
            <Input.TextArea
              data-testid="quick-description-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="例如:打开 /m-super-tasks → 点「+ 新建」按钮 → 当前显示「提交」,改为「完成」。接受人:PM。"
              rows={4}
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
            <Input
              data-testid="quick-cwd-input"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder={defaultCwd || '/absolute/path/to/repo'}
            />
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
