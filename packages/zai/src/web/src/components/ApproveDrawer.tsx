/**
 * ApproveDrawer — right-side drawer for the RequestApprove tool's user review.
 *
 * Mirrors TaskDrawer / QuestionCard patterns: dedicated UI state lives in
 * the global store (pendingApprove); the drawer reads + dispatches actions
 * via useAgentStore selectors.
 *
 * Layout:
 *   - Drawer header: title.
 *   - Body (flex-1, scroll): optional summary banner, file-source label,
 *     then <MarkdownText content /> for the resolved markdown body.
 *   - Footer: error banner + Reject/Approve buttons + comment textarea.
 *
 * Close = defer (per spec): closing the drawer keeps state in the store
 * so a subsequent reload re-renders the same drawer.
 */

import { Drawer, Button, Input, Popconfirm, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { MarkdownText } from './markdown/MarkdownText.jsx'
import { useAgentStore } from '../store/useAgentStore.js'

const { TextArea } = Input
const { Text } = Typography

const COMMENT_MAX = 2000

export default function ApproveDrawer(): JSX.Element {
  const pending = useAgentStore((s) => s.pendingApprove)
  const setComment = useAgentStore((s) => s.setApproveComment)
  const submitApprove = useAgentStore((s) => s.submitApprove)
  const open = pending !== null
  const title = pending?.title ?? ''
  const summary = pending?.summary
  const content = pending?.content ?? ''
  const displayPath = pending?.displayPath ?? null
  const status = pending?.status ?? 'pending'
  const errorMessage = pending?.errorMessage
  const pendingComment = pending?.comment ?? ''
  const commentEmpty = pendingComment.trim().length === 0
  const submitting = status === 'submitting'

  // Local mirror so typing in the textarea is instant. The store is the
  // source of truth; on remount (e.g., different pendingApprove slot),
  // we re-sync below.
  const [localComment, setLocalComment] = useState(pendingComment)
  useEffect(() => {
    setLocalComment(pendingComment)
  }, [pending?.toolUseId, pendingComment])

  const onCommentChange = (v: string) => {
    const truncated = v.length > COMMENT_MAX ? v.slice(0, COMMENT_MAX) : v
    setLocalComment(truncated)
    setComment(truncated)
  }

  return (
    <Drawer
      title={title}
      placement="right"
      width="min(720px, 50vw)"
      open={open}
      // destroyOnClose=false so comment survives a temporary close.
      destroyOnClose={false}
      maskClosable={!submitting}
      keyboard={!submitting}
      // Close does NOT auto-reject. State preserved in store.
      onClose={() => { /* no-op */ }}
      data-testid="approve-drawer"
      footer={
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <div style={{ flex: 1 }}>
            {status === 'error' && errorMessage && (
              <Text type="danger" style={{ fontSize: 12 }}>
                {errorMessage}
              </Text>
            )}
          </div>
          {commentEmpty ? (
            <Popconfirm
              title="Reject without a comment?"
              description="The AI won't know what to fix."
              okText="Reject anyway"
              cancelText="Cancel"
              onConfirm={() => {
                void submitApprove('rejected')
              }}
            >
              <Button danger disabled={!pending || submitting}>
                Reject
              </Button>
            </Popconfirm>
          ) : (
            <Button
              danger
              disabled={!pending || submitting}
              onClick={() => {
                void submitApprove('rejected')
              }}
            >
              Reject
            </Button>
          )}
          <Button
            type="primary"
            disabled={!pending || submitting}
            loading={submitting}
            onClick={() => {
              void submitApprove('approved')
            }}
          >
            Approve
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {summary && (
          <div
            style={{
              marginBottom: 12,
              padding: 12,
              background: 'rgba(0,0,0,0.04)',
              borderRadius: 4,
            }}
          >
            <Text type="secondary" style={{ fontSize: 13 }}>
              {summary}
            </Text>
          </div>
        )}
        {displayPath && (
          <div
            style={{
              marginBottom: 8,
              fontSize: 11,
              color: '#8c8c8c',
              fontFamily: 'ui-monospace, monospace',
            }}
          >
            Loaded from {displayPath}
          </div>
        )}
        <div style={{ flex: 1, overflow: 'auto', padding: '12px 0' }}>
          {content ? (
            <MarkdownText text={content} />
          ) : (
            <Text type="secondary">No content.</Text>
          )}
        </div>
        <div
          style={{
            marginTop: 16,
            borderTop: '1px solid #f0f0f0',
            paddingTop: 16,
          }}
        >
          <Text strong style={{ display: 'block', marginBottom: 6 }}>
            Comment (optional on Approve, required on Reject)
          </Text>
          <TextArea
            value={localComment}
            maxLength={COMMENT_MAX}
            onChange={(e) => onCommentChange(e.target.value)}
            placeholder="Optional on Approve. Required on Reject — leave feedback for the AI."
            rows={4}
            data-testid="approve-drawer-comment"
          />
          <Text type="secondary" style={{ fontSize: 11 }}>
            {localComment.length}/{COMMENT_MAX}
          </Text>
        </div>
      </div>
    </Drawer>
  )
}
