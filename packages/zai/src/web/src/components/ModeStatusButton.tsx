import { useMemo, useRef, useState } from 'react'
import { Button, Popover } from 'antd'
import {
  CodeOutlined,
  FileTextOutlined,
  QuestionCircleOutlined,
  SelectOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
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

// Popover body text — title + description rendered in the two-line row.
// Distinct from MODE_META.label which is used by the trigger badge.
interface ModeBody {
  title: string
  description: string
}

const MODE_BODY: Record<PermissionMode, ModeBody> = {
  default: {
    title: 'default',
    description: 'Claude will ask for approval before each edit',
  },
  acceptEdits: {
    title: 'accept edits',
    description: 'Claude will edit your selected text or the whole file',
  },
  plan: {
    title: 'plan',
    description: 'Claude will explore the code and present a plan before editing',
  },
  bypassPermissions: {
    title: 'bypass permissions',
    description: 'Claude will approve all actions without asking',
  },
  dontAsk: {
    title: "don't ask",
    description: 'Claude will not pause to ask any questions',
  },
}

export const MODE_CYCLE_ORDER = MODE_CYCLE

function IconFor({ mode }: { mode: PermissionMode }) {
  switch (mode) {
    case 'default': return <SelectOutlined />
    case 'acceptEdits': return <CodeOutlined />
    case 'plan': return <FileTextOutlined />
    case 'bypassPermissions': return <ThunderboltOutlined />
    case 'dontAsk': return <QuestionCircleOutlined />
  }
}

// Reusable kbd-style span for the header keycap hint.
const KBD_BASE: React.CSSProperties = {
  padding: '2px 6px',
  fontSize: 11,
  background: 'rgba(255,255,255,0.08)',
  border: '1px solid rgba(255,255,255,0.18)',
  borderRadius: 4,
  color: 'rgba(255,255,255,0.85)',
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  lineHeight: 1.2,
  minWidth: 18,
  textAlign: 'center',
}

interface RowProps {
  mode: PermissionMode
  isCurrent: boolean
  isSelected: boolean
  onClick: () => void
  onMouseEnter: () => void
}

function Row({ mode, isCurrent, isSelected, onClick, onMouseEnter }: RowProps) {
  const tint = MODE_META[mode].color
  const body = MODE_BODY[mode]
  return (
    <div
      data-testid={`mode-row-${mode}`}
      data-current={isCurrent ? 'true' : 'false'}
      data-selected={isSelected ? 'true' : 'false'}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 10px',
        borderRadius: 6,
        cursor: isCurrent ? 'default' : 'pointer',
        background: isSelected ? 'rgba(168,139,250,0.10)' : 'transparent',
        border: isSelected
          ? '1px solid rgba(168,139,250,0.35)'
          : '1px solid transparent',
        marginBottom: 2,
      }}
    >
      {/* Current-mode ● marker — kept verbatim from the original implementation. */}
      <span
        style={{
          width: 8,
          color: '#a78bfa',
          fontSize: 12,
          textAlign: 'center',
          visibility: isCurrent ? 'visible' : 'hidden',
        }}
      >
        ●
      </span>

      {/* Icon block. */}
      <span
        style={{
          width: 32,
          height: 32,
          borderRadius: 6,
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.08)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: tint,
          fontSize: 16,
          flexShrink: 0,
        }}
      >
        <IconFor mode={mode} />
      </span>

      {/* Two-line text. */}
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
        <span
          style={{
            fontSize: 13,
            fontWeight: isCurrent ? 600 : 500,
            color: '#fff',
            lineHeight: 1.3,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {body.title}
        </span>
        <span
          style={{
            fontSize: 11,
            color: 'rgba(255,255,255,0.55)',
            lineHeight: 1.3,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {body.description}
        </span>
      </div>
    </div>
  )
}

export default function ModeStatusButton({ compact = false }: { compact?: boolean } = {}) {
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
        width: 380,
        background: '#1f1f1f',
        color: '#fff',
        borderRadius: 10,
        padding: 10,
      }}
    >
      {/* Header: "Modes" title + keycap hint */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        <span
          data-testid="mode-picker-title"
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'rgba(255,255,255,0.85)',
          }}
        >
          Modes
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={KBD_BASE}>⇧</span>
          <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11 }}>+</span>
          <span style={KBD_BASE}>tab</span>
        </span>
      </div>

      {/* Mode rows */}
      {MODE_CYCLE.map((m, i) => (
        <Row
          key={m}
          mode={m}
          isCurrent={m === currentMode}
          isSelected={i === selectedIndex}
          onClick={() => pick(m)}
          onMouseEnter={() => setSelectedIndex(i)}
        />
      ))}

      {/* Footer — unchanged text + styling */}
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
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          padding: '0 6px',
        }}
      >
        <span style={{ color: meta.color }}>{meta.icon} {meta.badgeLabel}</span>
        {/* compact(右侧分屏展开)模式下省掉 shift+tab 提示,腾出横向空间.
            title 仍保留完整文案,鼠标 hover 仍能拿到快捷键说明. */}
        {!compact && (
          <span style={{ color: 'rgba(255,255,255,0.35)' }}> (shift+tab ↹)</span>
        )}
      </Button>
    </Popover>
  )
}