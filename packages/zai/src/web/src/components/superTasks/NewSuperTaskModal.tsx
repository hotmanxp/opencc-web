import { Modal, Input, Select, message } from 'antd'
import { useState } from 'react'
import { useAgentStore } from '../../store/useAgentStore'
import { useSuperTaskStore } from '../../store/useSuperTaskStore'
import { api } from '../../lib/api.generated'

const LAST_CWD_KEY = 'zai-last-task-cwd'

/**
 * NewSuperTaskModal — 新建任务弹窗。
 *
 * 用户输入: 标题(必填) + 工程目录 cwd(必填, 绝对路径) + 说明 + 执行 Agent。
 *
 * 流程: 把拼好的 prompt 通过 `POST /api/agent/prompt` 发给主管会话,
 * 由主管走 brainstorming skill 与用户讨论需求后调 SuperTasksCreate 落库。
 *
 * cwd 记忆: 弹窗打开时从 localStorage `zai-last-task-cwd` 读取上次值;
 * 发送成功后写回, 下次打开自动填。
 */
export default function NewSuperTaskModal({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}): JSX.Element {
  const [title, setTitle] = useState('')
  const [cwd, setCwd] = useState<string | undefined>(() => {
    if (typeof window === 'undefined') return undefined
    try { return window.localStorage.getItem(LAST_CWD_KEY) ?? undefined } catch { return undefined }
  })
  const [description, setDescription] = useState('')
  const [agent, setAgent] = useState<string | undefined>()
  const [sending, setSending] = useState(false)

  async function onSubmit(): Promise<void> {
    const trimmedTitle = title.trim()
    const trimmedCwd = (cwd ?? '').trim()
    if (!trimmedTitle) {
      message.warning('请填写任务标题')
      return
    }
    if (!trimmedCwd) {
      message.warning('请填写工程目录 cwd')
      return
    }
    const s = useAgentStore.getState()
    const sid = s.sessionId || s.activeSessionId
    if (!sid) {
      message.warning('主管会话尚未就绪，请稍候')
      return
    }
    setSending(true)
    try {
      const prompt = [
        '请帮我新建一个任务:',
        `- 标题: ${trimmedTitle}`,
        `- 工程目录 (cwd, 任务所在代码工程, 执行子 Agent 在此工作): ${trimmedCwd}`,
        description.trim() ? `- 说明: ${description.trim()}` : '',
        agent ? `- 执行 Agent: ${agent}` : '',
        '请先与我确认需求 (调用 brainstorming), 讨论清楚后调用 SuperTasksCreate (携带上述 cwd) 落库并告诉我任务 id。',
      ].filter(Boolean).join('\n')
      await api.agent.prompt.post({
        prompt,
        sessionId: sid,
      })
      try {
        if (trimmedCwd) window.localStorage.setItem(LAST_CWD_KEY, trimmedCwd)
      } catch { /* quota / disabled */ }
      message.success('已发给主管,等待确认需求…')
      setTitle('')
      setDescription('')
      onClose()
      void useSuperTaskStore.getState().load()
    } catch (err) {
      message.error(err instanceof Error ? err.message : '发送失败')
    } finally {
      setSending(false)
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={() => void onSubmit()}
      okText="发给主管"
      cancelText="取消"
      confirmLoading={sending}
      width={560}
      title="新建任务(与任务主管讨论)"
      destroyOnHidden
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="任务标题 (必填)"
          data-testid="new-task-title"
          onPressEnter={() => void onSubmit()}
          autoFocus
        />
        <Input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="工程目录 cwd, 绝对路径 (必填 — 任务所在代码项目)"
          data-testid="new-task-cwd"
        />
        <Input.TextArea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="任务目标 / 背景说明 (可选)"
          rows={4}
        />
        <Select
          style={{ width: '100%' }}
          allowClear
          placeholder="执行 Agent (默认 claude-code)"
          value={agent}
          onChange={setAgent}
          options={[
            { value: 'claude-code', label: 'claude-code (外部 CLI agent, 推荐)' },
            { value: 'dsh', label: 'dsh (DeepSeek Harness)' },
            { value: 'default', label: 'default (内置, SpawnAgent 不可用时回退)' },
          ]}
        />
        <div style={{ fontSize: 12, color: 'var(--text-secondary, #666)' }}>
          发送后主管 Agent 会与你确认需求 (brainstorming skill), 讨论清楚后调用
          SuperTasksCreate 落库到任务池。
        </div>
      </div>
    </Modal>
  )
}
