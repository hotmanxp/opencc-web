import { useState } from 'react'
import { Button, Popconfirm, Tag, Typography } from 'antd'
import { useAgentStoreOrCtx } from '../store/useAgentStore.js'

const { Text, Paragraph } = Typography

/**
 * PermissionConfirmCard — inline card for the vendor `behavior:'ask'`
 * permission flow. Rendered next to the message stream when the headless
 * permission bridge surfaces a prompt.permission SSE event (e.g.
 * ExitPlanMode / content-specific ask rules / safety-check paths).
 *
 * The user allows or denies the tool call; the answer is POSTed to
 * /api/agent/permission-response which resolves the registry entry the
 * tool loop is blocked on. Allow → the tool runs; deny → the model
 * receives a rejection.
 */
export default function PermissionConfirmCard(): JSX.Element | null {
  const pending = useAgentStoreOrCtx((s) => s.pendingPermission)
  const submit = useAgentStoreOrCtx((s) => s.submitPermissionResponse)
  const [localReason, setLocalReason] = useState('')

  if (!pending) return null

  const { toolName, description, message, input, status, errorMessage } = pending
  const submitting = status === 'submitting'

  const commandLine = extractCommandLine(input)

  return (
    <div
      className="question-card-scope permission-confirm-card m-3 mx-6 py-3 px-[14px] bg-[var(--bg-card-ansi)] border-t-[3px] border-t-[#f59e0b] rounded-md"
    >
      <div className="mb-[10px] flex items-center gap-2">
        <Tag style={{ marginRight: 0, background: '#f59e0b', borderColor: '#f59e0b', color: '#fff' }}>
          {toolName || 'Permission'}
        </Tag>
        <Text strong style={{ color: 'var(--text-primary)' }}>请求执行权限</Text>
      </div>

      {status === 'error' && errorMessage && (
        <div
          className="mb-[10px] py-[6px] px-[10px] bg-[var(--bg-body)] border border-[var(--error)] rounded"
        >
          <Text type="danger" className="text-xs">{errorMessage}</Text>
        </div>
      )}

      {message && (
        <Paragraph className="text-[var(--text-secondary)] mb-2 text-[13px]">
          {message}
        </Paragraph>
      )}
      {description && description !== message && (
        <Paragraph className="text-[var(--text-secondary)] mb-2 text-[13px]">
          {description}
        </Paragraph>
      )}
      {commandLine && (
        <div
          className="my-2 py-2 px-[10px] bg-[var(--bg-faint-04)] border border-[var(--border-mid)] rounded text-[#1f1f1f] text-xs font-[ui-monospace,SFMono-Regular,Menlo,monospace] whitespace-pre-wrap break-all"
        >
          {commandLine}
        </div>
      )}

      <div className="mt-1">
        <textarea
          aria-label="拒绝理由"
          value={localReason}
          onChange={(e) => setLocalReason(e.target.value.slice(0, 2000))}
          placeholder="拒绝理由（可选）"
          rows={2}
          className="w-full resize-y bg-[var(--bg-faint-04)] border border-[var(--border-mid)] rounded text-[#1f1f1f] py-[6px] px-2 text-xs"
        />
      </div>

      <div className="mt-3 flex gap-2 justify-end">
        <Popconfirm
          title="确认拒绝?"
          okText="拒绝"
          cancelText="取消"
          onConfirm={() => void submit('deny', localReason.trim() || undefined)}
        >
          <Button danger disabled={submitting}>
            拒绝
          </Button>
        </Popconfirm>
        <Button
          type="primary"
          loading={submitting}
          onClick={() => void submit('allow')}
          data-testid="permission-allow"
        >
          允许
        </Button>
      </div>
    </div>
  )
}

/**
 * 从 tool input 中提取 command 字符串。多数工具 (Bash / FileEdit /
 * FileWrite 等) 的 input 是带 `command` 或 `file_path` 的对象, 直接展示
 * command/file_path 文案比展示整段 JSON 元数据更直观; 既无 `command`
 * 也无 `file_path` 时返回空串, 调用方据此跳过该 block.
 */
function extractCommandLine(input: unknown): string {
  if (input == null) return ''
  if (typeof input === 'string') return input
  if (typeof input !== 'object') return String(input)
  const obj = input as Record<string, unknown>
  for (const key of ['command', 'file_path']) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim()) return v
  }
  return ''
}