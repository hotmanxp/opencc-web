import { useMemo, useRef, useState } from 'react'
import { Button, Popover } from 'antd'
import { useAgentStore } from '../store/useAgentStore.js'
import type { PermissionMode } from '@zn-ai/zai-agent-core/runtime'

// Canonical cycle order (matches OpenCC TUI shift+tab order).
const MODE_CYCLE: PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
]

// Display labels, icon, and color tints — match OpenCC TUI conventions.
// - `label`      : popover row text (e.g., "accept edits on")
// - `badgeLabel` : bottom-bar badge text suffix (e.g., "accept edits on")
// - `icon`       : "▶▶" for most modes, "▮▮" for plan mode
// - `color`      : per-mode tint; red is reserved for the two high-risk modes
//                  (bypassPermissions / dontAsk).
const MODE_META: Record<PermissionMode, {
  label: string
  badgeLabel: string
  icon: string
  color: string
}> = {
  default:           { label: 'default on',     badgeLabel: 'default on',     icon: '▶▶', color: 'rgba(255,255,255,0.65)' },
  acceptEdits:       { label: 'accept edits on', badgeLabel: 'accept edits on', icon: '▶▶', color: '#a78bfa' },
  plan:              { label: 'plan mode on',    badgeLabel: 'plan mode on',    icon: '▮▮', color: '#5eead4' },
  bypassPermissions: { label: 'bypass on',       badgeLabel: 'bypass on',       icon: '▶▶', color: '#f43f5e' },
  dontAsk:           { label: "don't ask on",    badgeLabel: "don't ask on",    icon: '▶▶', color: '#f43f5e' },
}

export const MODE_CYCLE_ORDER = MODE_CYCLE

export default function ModeStatusButton() {
  const sessions = useAgentStore((s) => s.sessions)
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const sessionId = useAgentStore((s) => s.sessionId)
  const patchSessionMode = useAgentStore((s) => s.patchSessionMode)

  const currentSessionId = sessionId ?? activeSessionId ?? null
  const currentSession = useMemo(
    () => sessions.find((s) => s.transcriptId === currentSessionId) ?? null,
    [sessions, currentSessionId],
  )
  const currentMode: PermissionMode = currentSession?.permissionMode ?? 'default'
  const meta = MODE_META[currentMode]

  const [selectedIndex, setSelectedIndex] = useState(() => {
    const idx = MODE_CYCLE.indexOf(currentMode)
    return idx === -1 ? 0 : idx
  })
  // Keep selectedIndex in sync with the actual current mode (e.g. when
  // a PATCH response lands and the store updates while the popover is open).
  const lastSeenModeRef = useRef(currentMode)
  if (lastSeenModeRef.current !== currentMode) {
    lastSeenModeRef.current = currentMode
    const idx = MODE_CYCLE.indexOf(currentMode)
    if (idx !== -1 && idx !== selectedIndex) setSelectedIndex(idx)
  }

  const pick = (mode: PermissionMode) => {
    if (mode === currentMode) return
    if (!currentSessionId) return
    void patchSessionMode(currentSessionId, mode)
  }

  const content = (
    <div
      data-testid="mode-picker-content"
      tabIndex={-1}
      style={{
        width: 280,
        background: '#1f1f1f',
        color: '#fff',
        borderRadius: 6,
        padding: 8,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 6,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.55)' }}>
          Select mode
        </span>
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>esc</span>
      </div>
      {MODE_CYCLE.map((m, i) => {
        const isCurrent = m === currentMode
        const isSelected = i === selectedIndex
        return (
          <div
            key={m}
            data-testid={`mode-row-${m}`}
            data-current={isCurrent ? 'true' : 'false'}
            data-selected={isSelected ? 'true' : 'false'}
            onClick={() => pick(m)}
            onMouseEnter={() => setSelectedIndex(i)}
            style={{
              padding: '5px 8px',
              borderRadius: 4,
              cursor: isCurrent ? 'default' : 'pointer',
              background: isSelected ? 'rgba(168, 139, 250, 0.15)' : 'transparent',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span style={{ color: '#a78bfa', fontSize: 12, width: 7, lineHeight: 1 }}>
              {isCurrent ? '●' : ''}
            </span>
            <span
              style={{
                fontSize: 13,
                color: MODE_META[m].color,
                fontWeight: isCurrent ? 600 : 400,
              }}
            >
              {MODE_META[m].label}
            </span>
          </div>
        )
      })}
      <div
        style={{
          fontSize: 11,
          color: 'rgba(255,255,255,0.30)',
          borderTop: '1px solid rgba(255,255,255,0.08)',
          paddingTop: 6,
          marginTop: 4,
        }}
      >
        click to select · shift+tab to cycle
      </div>
    </div>
  )

  return (
    <Popover
      content={content}
      trigger="click"
      placement="topRight"
      destroyTooltipOnHide
    >
      <Button
        type="text"
        size="small"
        data-testid="mode-status-button"
        title={`当前 mode: ${meta.label}\n点击切换`}
        style={{
          color: meta.color,
          opacity: 0.9,
          fontSize: 12,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          padding: '0 6px',
        }}
      >
        <span style={{ color: meta.color }}>{meta.icon} {meta.badgeLabel}</span>
        <span style={{ color: 'rgba(255,255,255,0.35)' }}> (shift+tab ↹)</span>
      </Button>
    </Popover>
  )
}