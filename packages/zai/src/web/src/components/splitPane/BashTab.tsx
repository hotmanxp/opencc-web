import { useEffect, useMemo, useRef, useState } from 'react'
import { AutoComplete, Input } from 'antd'
import { useBashRepl } from '../../hooks/useBashRepl.js'
import type { ReplEvent } from '../../../shared/repl.js'
import { AnsiText } from '../toolRenderers/ansi.js'

interface BashTabProps {
  sessionId: string | null
  cwd: string | null
}

type ExitLike = { code: number | null; signal: string | null }

function fmtExitColor(ev: ExitLike): string {
  if (ev.signal) return 'var(--text-dim-45)'
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
  const { events, busy, exec, abort, topCommands } = useBashRepl(sessionId, cwd)
  const [input, setInput] = useState('')
  const outputRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [events])

  async function handleSubmit(command?: string) {
    const cmd = (command ?? input).trim()
    if (!cmd || !sessionId) return
    setInput('')
    await exec(cmd)
  }

  // AutoComplete options:把 topCommands 渲染成 { value, label }。
  // 用本地 state(input)做 prefix 前端过滤 — 避免每次按键都打 server。
  // plan §3.4 / 风险 5。
  const autoOptions = useMemo(() => {
    const prefix = input.trim()
    const filtered = prefix
      ? topCommands.filter((e) => e.command.startsWith(prefix))
      : topCommands
    return filtered.map((e) => ({
      value: e.command,
      // label 显示命令 + 频次,让用户一眼看出高频命令
      label: (
        <div className="flex justify-between gap-3">
          <span className="font-mono">{e.command}</span>
          <span className="text-[11px]" style={{ color: 'var(--text-dim-45)' }}>×{e.count}</span>
        </div>
      ),
    }))
  }, [topCommands, input])

  return (
    <div className="flex flex-col h-full">
      <div
        className="flex items-center justify-between py-1.5 px-3 text-xs"
        style={{
          borderBottom: '1px solid var(--border-light)',
          color: 'var(--text-dim-55)',
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
        className="flex-1 min-h-0 overflow-auto p-3 text-xs"
        style={{
          maxHeight: 'calc(100vh - 150px)',
          fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
          lineHeight: 1.55,
          color: 'var(--text-dim-85)',
        }}
      >
        {events.length === 0 && (
          <div style={{ color: 'var(--ui-text-dim)' }}>
            在下方输入 bash 命令，按 Enter 执行
          </div>
        )}
        {coalesceEvents(events).map((row, i) => {
          if (row.kind === 'stream') {
            // stderr 行：未着色的纯文本继承红色；AnsiText 渲染的带色 span 用内联样式覆盖。
            return (
              <div
                key={`${row.execId}-${row.streamKind}-${i}`}
                className="whitespace-pre-wrap"
                style={row.streamKind === 'stderr' ? { color: '#ef4444' } : undefined}
              >
                <AnsiText text={row.text} />
              </div>
            )
          }
          if (row.kind === 'error') {
            return (
              <div key={`${row.execId}-err-${i}`} className="font-semibold" style={{ color: '#ef4444' }}>
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
        className="flex gap-2 p-2"
        style={{ borderTop: '1px solid var(--border-light)' }}
      >
        <AutoComplete
          className="flex-1"
          options={autoOptions}
          value={input}
          disabled={busy}
          // 仅聚焦时展开(plan §3.4 / 风险 3)
          openOnFocus
          // 输入时实时过滤(本地,不打 server)
          onSearch={(text) => setInput(text)}
          // 点选下拉项 → 直接 exec(value),清空 input。
          // AntD AutoComplete 会同时把 value 写到 input;handleSubmit 这里显式传 value 即可。
          onSelect={(value) => {
            void handleSubmit(value)
          }}
          onChange={(value) => setInput(value)}
          // 自定义 popup 渲染 — 不传 defaultActiveFirstOption,避免 Enter 误选第一条
          popupMatchSelectWidth={360}
          data-testid="bash-autocomplete"
        >
          <Input
            placeholder="输入 bash 命令，按 Enter 执行（Shift+Enter 换行）"
            onPressEnter={(e) => {
              if (e.shiftKey) return
              e.preventDefault()
              void handleSubmit()
            }}
            data-testid="bash-input"
          />
        </AutoComplete>
        {busy && (
          <button
            type="button"
            onClick={() => void abort()}
            data-testid="bash-abort"
            className="px-3 rounded-md bg-transparent text-[13px] cursor-pointer"
            style={{
              border: '1px solid #ff4d4f',
              color: '#ff4d4f',
            }}
          >
            终止
          </button>
        )}
      </div>
    </div>
  )
}