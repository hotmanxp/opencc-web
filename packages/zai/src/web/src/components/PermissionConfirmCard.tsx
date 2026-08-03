import { useState } from 'react'
import { Button, Popconfirm, Tag, Typography } from 'antd'
import { useAgentStore } from '../store/useAgentStore.js'

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
  const pending = useAgentStore((s) => s.pendingPermission)
  const submit = useAgentStore((s) => s.submitPermissionResponse)
  const [localReason, setLocalReason] = useState('')

  if (!pending) return null

  const { toolName, description, message, input, status, errorMessage } = pending
  const submitting = status === 'submitting'

  const inputPreview = formatInputPreview(input)

  return (
    <div
      className="question-card-scope"
      style={{
        margin: '12px 24px',
        padding: '12px 14px',
        background: 'var(--bg-card-ansi)',
        borderTop: '3px solid #f59e0b',
        borderRadius: 6,
      }}
    >
      <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Tag style={{ marginRight: 0, background: '#f59e0b', borderColor: '#f59e0b', color: '#fff' }}>
          {toolName || 'Permission'}
        </Tag>
        <Text strong style={{ color: 'var(--text-primary)' }}>请求执行权限</Text>
      </div>

      {status === 'error' && errorMessage && (
        <div
          style={{
            marginBottom: 10,
            padding: '6px 10px',
            background: 'var(--bg-body)',
            border: '1px solid var(--error)',
            borderRadius: 4,
          }}
        >
          <Text type="danger" style={{ fontSize: 12 }}>{errorMessage}</Text>
        </div>
      )}

      {message && (
        <Paragraph style={{ color: 'var(--text-secondary)', marginBottom: 8, fontSize: 13 }}>
          {message}
        </Paragraph>
      )}
      {description && description !== message && (
        <Paragraph style={{ color: 'var(--text-secondary)', marginBottom: 8, fontSize: 13 }}>
          {description}
        </Paragraph>
      )}
      {inputPreview && (
        <pre
          style={{
            margin: '8px 0',
            padding: '8px 10px',
            maxHeight: 180,
            overflow: 'auto',
            background: 'var(--bg-body)',
            border: '1px solid var(--border-light)',
            borderRadius: 4,
            color: 'var(--text-dim-75)',
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {inputPreview}
        </pre>
      )}

      <div style={{ marginTop: 4 }}>
        <textarea
          value={localReason}
          onChange={(e) => setLocalReason(e.target.value.slice(0, 2000))}
          placeholder="拒绝理由（可选）"
          rows={2}
          style={{
            width: '100%',
            resize: 'vertical',
            background: 'var(--bg-body)',
            border: '1px solid var(--border-mid)',
            borderRadius: 4,
            color: 'var(--text-primary)',
            padding: '6px 8px',
            fontSize: 12,
          }}
        />
      </div>

      <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
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

function formatInputPreview(input: unknown): string {
  if (input == null) return ''
  if (typeof input === 'string') return input
  try {
    const text = JSON.stringify(input, null, 2)
    return text.length > 4000 ? `${text.slice(0, 4000)}…` : text
  } catch {
    return String(input)
  }
}
