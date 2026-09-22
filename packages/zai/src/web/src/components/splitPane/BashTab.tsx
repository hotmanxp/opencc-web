import { useState } from 'react'
import { Button, Dropdown, Input, Spin } from 'antd'
import { PlusIcon, TerminalIcon, XIcon } from 'lucide-react'
import type { WebTerminalInfo } from '../../../../shared/terminal.js'
import { useTerminalTabs } from '../../hooks/useTerminalTabs.js'
import { TerminalView } from './TerminalView.js'

/**
 * 分屏 Bash 面板 = 多终端 tab 宿主。
 *
 * 2026-09-22 起从「输入框 + 输出流」的 REPL 换成持久 PTY 终端（xterm.js）：
 * shell 状态（export / alias / 函数）与 CWD 跨命令保持，真 TTY 支持 vim/htop
 * 这类全屏程序。命令历史 / 移动端快捷 Bash 仍走 /api/bash-repl（见 spec 的
 * Non-goals）。参考实现：deepseek-harness 侧栏终端（terminal-browser +
 * ui-sidebar-terminal）。
 */

interface BashTabProps {
  sessionId: string | null
  cwd: string | null
}

function statusLabel(info: WebTerminalInfo | null): string {
  if (!info) return ''
  if (info.state === 'running') return '● running'
  if (info.state === 'failed') return '● failed'
  return `● exited (exit ${info.exitCode ?? '—'})`
}

function statusColor(info: WebTerminalInfo | null): string {
  if (!info) return 'var(--text-dim-45)'
  if (info.state === 'running') return '#52c41a'
  if (info.state === 'failed') return '#ef4444'
  return 'var(--text-dim-55)'
}

export function BashTab({ sessionId, cwd }: BashTabProps) {
  const tabs = useTerminalTabs(sessionId, cwd)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  const active = tabs.terminals.find((t) => t.id === tabs.activeId) ?? null
  const busy = !tabs.ready

  function startRename(info: WebTerminalInfo): void {
    setRenamingId(info.id)
    setRenameDraft(info.title)
  }

  async function commitRename(): Promise<void> {
    const id = renamingId
    const title = renameDraft
    setRenamingId(null)
    if (id) await tabs.rename(id, title)
  }

  function renderNewButton(): React.ReactNode {
    const label = (
      <button
        type="button"
        data-testid="terminal-new"
        title="新建终端"
        aria-label="新建终端"
        className="flex h-6 w-6 cursor-pointer items-center justify-center rounded border-0 bg-transparent"
        style={{ color: 'var(--text-dim-55)' }}
        onClick={tabs.shells.length > 1 ? undefined : () => void tabs.create()}
      >
        <PlusIcon size={14} />
      </button>
    )
    // 本机装了多个 shell 才给选择菜单；只有一个时直接新建，少一次点击。
    if (tabs.shells.length <= 1) return label
    return (
      <Dropdown
        trigger={['click']}
        menu={{
          items: tabs.shells.map((shell) => ({
            key: shell.path,
            label: shell.name,
            onClick: () => void tabs.create(shell.path),
          })),
        }}
      >
        {label}
      </Dropdown>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div
        className="flex items-center gap-1 px-2 py-1 text-xs"
        style={{ borderBottom: '1px solid var(--border-light)' }}
        data-testid="terminal-tabstrip"
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.terminals.map((info) => {
            const isActive = info.id === tabs.activeId
            return (
              <div
                key={info.id}
                role="tab"
                aria-selected={isActive}
                data-testid={`terminal-chip-${info.id}`}
                className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded px-2 py-1"
                style={{
                  background: isActive ? 'var(--bg-card-hover)' : 'transparent',
                  color: isActive ? 'var(--text-primary)' : 'var(--text-dim-55)',
                }}
                onClick={() => tabs.setActive(info.id)}
                onDoubleClick={() => startRename(info)}
                title={`${info.shell.path}${info.state === 'running' ? '' : ' (已退出)'} — 双击改名`}
              >
                <TerminalIcon size={12} />
                {renamingId === info.id ? (
                  <Input
                    size="small"
                    autoFocus
                    value={renameDraft}
                    data-testid="terminal-rename-input"
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onPressEnter={() => void commitRename()}
                    onBlur={() => void commitRename()}
                    style={{ width: 96 }}
                  />
                ) : (
                  <span className="max-w-[120px] truncate">{info.title}</span>
                )}
                {info.state !== 'running' && (
                  <span style={{ color: 'var(--text-dim-45)' }}>·</span>
                )}
                <button
                  type="button"
                  data-testid={`terminal-chip-close-${info.id}`}
                  title="关闭终端（会结束该 shell 进程）"
                  aria-label={`关闭 ${info.title}`}
                  className="flex h-4 w-4 cursor-pointer items-center justify-center rounded border-0 bg-transparent p-0"
                  style={{ color: 'var(--text-dim-45)' }}
                  onClick={(e) => {
                    e.stopPropagation()
                    void tabs.close(info.id)
                  }}
                >
                  <XIcon size={11} />
                </button>
              </div>
            )
          })}
          {renderNewButton()}
        </div>

        <div className="flex shrink-0 items-center gap-3 pl-2 pr-1">
          <span style={{ color: 'var(--text-dim-55)' }}>
            <span data-testid="bash-cwd">{cwd ?? '(无 cwd)'}</span>
          </span>
          {active && (
            <span data-testid="terminal-status" style={{ color: statusColor(active) }}>
              {statusLabel(active)}
            </span>
          )}
        </div>
      </div>

      <div className="relative min-h-0 flex-1" data-testid="terminal-body">
        {!sessionId && (
          <div className="p-3 text-xs" style={{ color: 'var(--ui-text-dim)' }}>
            先选择一个会话，再打开终端
          </div>
        )}

        {sessionId && tabs.environment && !tabs.environment.available && (
          <div className="p-3 text-xs" data-testid="terminal-unavailable">
            <div style={{ color: 'var(--error)' }}>
              终端不可用：{tabs.environment.unavailableReason ?? 'node-pty 未就绪'}
            </div>
            {tabs.environment.hint && (
              <div className="mt-1" style={{ color: 'var(--text-dim-55)' }}>
                {tabs.environment.hint}
              </div>
            )}
          </div>
        )}

        {sessionId && tabs.error && (
          <div className="p-3 text-xs" data-testid="terminal-error">
            <div style={{ color: 'var(--error)' }}>{tabs.error}</div>
            {tabs.errorHint && (
              <div className="mt-1" style={{ color: 'var(--text-dim-55)' }}>
                {tabs.errorHint}
              </div>
            )}
            <Button size="small" className="mt-2" onClick={tabs.retry} data-testid="terminal-retry">
              重试
            </Button>
          </div>
        )}

        {sessionId && busy && !tabs.error && (
          <div className="flex h-full items-center justify-center">
            <Spin size="small" />
          </div>
        )}

        {sessionId && tabs.ready && !tabs.error && tabs.terminals.length === 0 && (
          <div
            className="flex h-full flex-col items-center justify-center gap-2 text-xs"
            style={{ color: 'var(--text-dim-55)' }}
            data-testid="terminal-empty"
          >
            <span>还没有终端</span>
            <Button size="small" onClick={() => void tabs.create()}>
              新建终端
            </Button>
          </div>
        )}

        {sessionId &&
          tabs.terminals.map((info) => (
            <div key={info.id} className={info.id === tabs.activeId ? 'h-full' : 'hidden'}>
              <TerminalView
                sessionId={sessionId}
                info={info}
                visible={info.id === tabs.activeId}
                maxCols={tabs.environment?.maxCols ?? 500}
                maxRows={tabs.environment?.maxRows ?? 200}
                scrollback={tabs.environment?.scrollback ?? 1000}
                onInfo={tabs.applyInfo}
              />
            </div>
          ))}
      </div>
    </div>
  )
}