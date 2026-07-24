import { useEffect, useRef, useState } from 'react'
import { Input } from 'antd'
import { useBashRepl } from '../../hooks/useBashRepl.js'
import type { ReplEvent } from '../../../shared/repl.js'

interface BashTabProps {
  sessionId: string | null
  cwd: string | null
}

function fmtExitColor(ev: Extract<ReplEvent, { kind: 'exit' }>): string {
  if (ev.signal) return 'rgba(255,255,255,0.45)'
  if (ev.code === 0) return '#52c41a'
  return '#f59e0b'
}

function fmtExitLabel(ev: Extract<ReplEvent, { kind: 'exit' }>): string {
  if (ev.signal) return `── ${ev.signal} ──`
  return `── exit ${ev.code} ──`
}

export function BashTab({ sessionId, cwd }: BashTabProps) {
  const { events, busy, exec, abort } = useBashRepl(sessionId, cwd)
  const [input, setInput] = useState('')
  const outputRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [events])

  async function handleSubmit() {
    const cmd = input.trim()
    if (!cmd || !sessionId) return
    setInput('')
    await exec(cmd)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 12px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          fontSize: 12,
          color: 'rgba(255,255,255,0.55)',
        }}
      >
        <span>
          Bash · <span data-testid="bash-cwd">{cwd ?? '(无 cwd)'}</span>
        </span>
        <span style={{ color: busy ? '#a78bfa' : '#52c41a' }}>
          {busy ? '● running' : '● idle'}
        </span>
      </div>

      <div
        ref={outputRef}
        data-testid="bash-output"
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          padding: 12,
          fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
          fontSize: 12,
          lineHeight: 1.55,
          color: 'rgba(255,255,255,0.85)',
          background: '#0a0a0f',
        }}
      >
        {events.length === 0 && (
          <div style={{ color: 'rgba(255,255,255,0.35)' }}>
            在下方输入 bash 命令，按 Enter 执行
          </div>
        )}
        {events.map((ev, i) => {
          if (ev.kind === 'stdout') {
            return (
              <div key={`${ev.execId}-${i}`} style={{ whiteSpace: 'pre-wrap' }}>
                {ev.chunk}
              </div>
            )
          }
          if (ev.kind === 'stderr') {
            return (
              <div key={`${ev.execId}-${i}`} style={{ whiteSpace: 'pre-wrap', color: '#ef4444' }}>
                {ev.chunk}
              </div>
            )
          }
          if (ev.kind === 'error') {
            return (
              <div key={`${ev.execId}-${i}`} style={{ color: '#ef4444', fontWeight: 600 }}>
                ✗ {ev.message}
              </div>
            )
          }
          if (ev.kind === 'exit') {
            return (
              <div key={`${ev.execId}-${i}`} style={{ color: fmtExitColor(ev) }}>
                {fmtExitLabel(ev)}
              </div>
            )
          }
          return null
        })}
      </div>

      <div
        style={{
          display: 'flex',
          gap: 8,
          padding: 8,
          borderTop: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <Input
          placeholder="输入 bash 命令，按 Enter 执行（Shift+Enter 换行）"
          value={input}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onPressEnter={(e) => {
            if (e.shiftKey) return
            e.preventDefault()
            void handleSubmit()
          }}
          data-testid="bash-input"
        />
        {busy && (
          <button
            type="button"
            onClick={() => void abort()}
            data-testid="bash-abort"
            style={{
              padding: '0 12px',
              border: '1px solid #ff4d4f',
              borderRadius: 6,
              background: 'transparent',
              color: '#ff4d4f',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            终止
          </button>
        )}
      </div>
    </div>
  )
}