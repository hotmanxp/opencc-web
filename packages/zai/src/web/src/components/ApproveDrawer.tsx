/**
 * ApproveDrawer — right-side drawer for the RequestApprove tool's user review.
 *
 * Mirrors TaskDrawer / QuestionCard patterns: dedicated UI state lives in
 * the global store (pendingApprove); the drawer reads + dispatches actions
 * via useAgentStore selectors.
 *
 * Layout:
 *   - Drawer header: title.
 *   - Body (flex-1, scroll): optional summary banner, filePath label, then
 *     <MarkdownText content /> once the file fetch lands.
 *   - Footer: error banner + Reject/Approve buttons + comment textarea.
 *
 * Document fetching: when prompt.approve lands, the store sets
 * fetchStatus='loading' and the drawer mounts. A useEffect fires
 * `fetch /api/agent/approve/file?toolUseId=...&sessionId=...` and
 * dispatches setApproveFetchResult on settle. Status transitions:
 *   loading → ready | error. On error the footer still works so the user
 *   can approve / reject even if the file is unreadable.
 *
 * Close = defer (per spec): closing the drawer keeps state in the store
 * so a subsequent reload re-renders the same drawer.
 */

import { Drawer, Button, Input, Popconfirm, Typography, Spin } from 'antd'
import { useEffect, useState } from 'react'
import { MarkdownText } from './markdown/MarkdownText.jsx'
import { useAgentStore } from '../store/useAgentStore.js'

const { TextArea } = Input
const { Text } = Typography

const COMMENT_MAX = 2000

export default function ApproveDrawer(): JSX.Element {
  const pending = useAgentStore((s) => s.pendingApprove)
  const setComment = useAgentStore((s) => s.setApproveComment)
  const setFetchResult = useAgentStore((s) => s.setApproveFetchResult)
  const submitApprove = useAgentStore((s) => s.submitApprove)
  const open = pending !== null
  const title = pending?.title ?? ''
  const summary = pending?.summary
  const content = pending?.content ?? ''
  const filePath = pending?.filePath ?? ''
  const fetchStatus = pending?.fetchStatus ?? 'idle'
  const fetchError = pending?.fetchError
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

  // Fetch the document body once the drawer mounts on a new pendingApprove.
  // We pull the path server-side, keyed by toolUseId — the server checks
  // the in-memory ApproveRegistry for the filePath (which itself was
  // validated at tool-input time). The route enforces sid-mismatch.
  useEffect(() => {
    if (!pending) return
    if (pending.fetchStatus !== 'loading') return
    const toolUseId = pending.toolUseId
    const sessionId = pending.sessionId
    const ctrl = new AbortController()
    let cancelled = false
    void (async () => {
      try {
        const token = localStorage.getItem('zai-token') ?? ''
        const params = new URLSearchParams({ toolUseId })
        if (sessionId) params.set('sessionId', sessionId)
        const res = await fetch(`/api/agent/approve/file?${params.toString()}`, {
          headers: {
            'X-Zai-Token': token,
            ...(sessionId ? { 'X-Session-Id': sessionId } : {}),
          },
          signal: ctrl.signal,
        })
        let detail = `HTTP ${res.status}`
        if (!res.ok) {
          // Tool is no longer pending (server already resolved / timeout /
          // sid mismatch / file too large / binary). Surface the reason
          // so the user knows why they can't review inline.
          try {
            const errBody = (await res.json()) as { error?: string }
            detail = errBody.error ?? detail
          } catch {
            // keep HTTP status fallback
          }
          if (!cancelled) setFetchResult(toolUseId, { ok: false, error: detail })
          return
        }
        const data = (await res.json()) as { content?: string }
        if (!cancelled) {
          setFetchResult(toolUseId, { ok: true, content: data.content ?? '' })
        }
      } catch (e) {
        if (!cancelled) {
          setFetchResult(toolUseId, {
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          })
        }
      }
    })()
    return () => {
      cancelled = true
      ctrl.abort()
    }
  }, [pending?.toolUseId, pending?.fetchStatus, setFetchResult])

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
        {filePath && (
          <div
            style={{
              marginBottom: 8,
              fontSize: 11,
              color: '#8c8c8c',
              fontFamily: 'ui-monospace, monospace',
            }}
          >
            Loaded from {filePath}
          </div>
        )}
        <div style={{ flex: 1, overflow: 'auto', padding: '12px 0' }}>
          {fetchStatus === 'loading' ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                gap: 8,
              }}
            >
              <Spin />
              <Text type="secondary">Loading document...</Text>
            </div>
          ) : fetchStatus === 'error' ? (
            <div
              style={{
                padding: 16,
                border: '1px solid #ffccc7',
                borderRadius: 4,
                background: '#fff2f0',
              }}
            >
              <Text type="danger" strong>
                Could not load document: {fetchError ?? 'unknown error'}
              </Text>
              <div style={{ height: 8 }} />
              <Text type="secondary" style={{ fontSize: 12 }}>
                Approve / reject still works below — the AI gets your decision without the body.
              </Text>
            </div>
          ) : content ? (
            <MarkdownText text={content} />
          ) : (
            <Text type="secondary">Document is empty.</Text>
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
