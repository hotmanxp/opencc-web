import { useEffect, useRef, useState } from 'react'
import { Input } from 'antd'
import { useBashRepl } from '../../hooks/useBashRepl.js'
import type { ReplEvent } from '../../../shared/repl.js'
import { AnsiText } from '../toolRenderers/ansi.js'

interface BashTabProps {
  sessionId: string | null
  cwd: string | null
}

type ExitLike = { code: number | null; signal: string | null }

function fmtExitColor(ev: ExitLike): string {
  if (ev.signal) return 'rgba(255,255,255,0.45)'
  if (ev.code === 0) return '#52c41a'
  return '#f59e0b'
}

function fmtExitLabel(ev: ExitLike): string {
  if (ev.signal) return `── ${ev.signal} ──`
  return `── exit ${ev.code} ──`
}

// 渲染行：把同一 execId 同 kind(stdout/stderr) 的相邻 SSE chunk 合并成一行,
// 避免 ANSI 转义序列被切到两个 chunk 中间导致解析错乱 / 跨 chunk 颜色丢失。
type Row =
  | { kind: 'stream'; streamKind: 'stdout' | 'stderr'; execId: string; text: string }
  | { kind: 'error'; execId: string; message: string }
  | { kind: 'exit'; execId: string; code: number | null; signal: string | null }

function coalesceEvents(events: ReplEvent[]): Row[] {
  const rows: Row[] = []
  for (const ev of events) {
    if (ev.kind === 'stdout' || ev.kind === 'stderr') {
      const last = rows[rows.length - 1]
      if (last && last.kind === 'stream' && last.execId === ev.execId && last.streamKind === ev.kind) {
        last.text += ev.chunk
      } else {
        rows.push({ kind: 'stream', streamKind: ev.kind, execId: ev.execId, text: ev.chunk })
      }
    } else if (ev.kind === 'error') {
      rows.push({ kind: 'error', execId: ev.execId, message: ev.message })
    } else if (ev.kind === 'exit') {
      rows.push({ kind: 'exit', execId: ev.execId, code: ev.code, signal: ev.signal })
    }
  }
  return rows
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
          overflowY: 'auto',
          maxHeight: 'calc(100vh - 150px)',
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
        {coalesceEvents(events).map((row, i) => {
          if (row.kind === 'stream') {
            // stderr 行：未着色的纯文本继承红色；AnsiText 渲染的带色 span 用内联样式覆盖。
            return (
              <div
                key={`${row.execId}-${row.streamKind}-${i}`}
                style={{
                  whiteSpace: 'pre-wrap',
                  ...(row.streamKind === 'stderr' ? { color: '#ef4444' } : null),
                }}
              >
                <AnsiText text={row.text} />
              </div>
            )
          }
          if (row.kind === 'error') {
            return (
              <div key={`${row.execId}-err-${i}`} style={{ color: '#ef4444', fontWeight: 600 }}>
                ✗ {row.message}
              </div>
            )
          }
          if (row.kind === 'exit') {
            return (
              <div key={`${row.execId}-exit-${i}`} style={{ color: fmtExitColor(row) }}>
                {fmtExitLabel(row)}
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