import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Input, Popover, Tag, Tooltip } from 'antd'
import { CheckOutlined, EyeOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { useConversationInfo } from '../hooks/useConversationInfo.js'
import { useAgentStore } from '../store/useAgentStore.js'
import type { ModelEntry, ModelCapabilities } from '../../../shared/settings.js'

/**
 * OpenCC TUI-style model picker.
 *
 * Replaces the flat-list ModelStatusButton. Layout (top to bottom):
 *   1. "Select model" header with esc hint
 *   2. Search <Input> (autoFocus)
 *   3. Recent section (only when no search query AND recentModels > 0)
 *   4. Provider groups sorted by title
 *
 * Each row shows ● marker when entry.model === currentModel, plus
 * violet-tint background when keyboard-selectedIndex matches.
 *
 * Keyboard: ArrowUp/Down move selectedIndex in flatList (Recent first,
 * then each group's entries in order); Enter calls patchSessionModel;
 * Esc bubbles to antd Popover default close.
 */
export default function ModelStatusButton() {
  const { model: currentModel, sessionId } = useConversationInfo()
  const availableModels = useAgentStore((s) => s.availableModels)
  const sessions = useAgentStore((s) => s.sessions)
  const patchSessionModel = useAgentStore((s) => s.patchSessionModel)

  const [searchQuery, setSearchQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const selectedRowRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<any>(null)

  // Derived: provider label for the badge = "model-name(provider-name)".
  // Looks up the current model in availableModels to find its
  // `description` (set to the profile name by agentSettings.buildAvailableModels
  // for both user models and builtin entries) — e.g.
  // "MiniMax-M3 (Open Platform (Nova))".
  const badgeText = useMemo<string | null>(() => {
    if (!currentModel) return null
    const entry = availableModels.find((m) => m.model === currentModel)
    if (!entry || !entry.description) return currentModel
    return `${currentModel} (${entry.description})`
  }, [currentModel, availableModels])

  // Derived: recent models from sessions, recency-weighted, deduped, max 5.
  const recentModels = useMemo<ModelEntry[]>(() => {
    const seen = new Set<string>()
    const out: ModelEntry[] = []
    const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
    for (const s of sorted) {
      if (!s.model || s.model === 'unknown') continue
      if (seen.has(s.model)) continue
      const entry = availableModels.find((m) => m.model === s.model)
      if (!entry) continue
      seen.add(s.model)
      out.push(entry)
      if (out.length >= 5) break
    }
    return out
  }, [sessions, availableModels])

  // Derived: search-filtered models.
  const filteredModels = useMemo<ModelEntry[]>(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return availableModels
    return availableModels.filter((m) =>
      m.model.toLowerCase().includes(q) ||
      m.alias.toLowerCase().includes(q) ||
      (m.label ?? '').toLowerCase().includes(q) ||
      (m.description ?? '').toLowerCase().includes(q) ||
      extractHost(m.baseUrl).toLowerCase().includes(q),
    )
  }, [availableModels, searchQuery])

  // Derived: provider-grouped entries.
  const groups = useMemo<Array<[string, ModelEntry[]]>>(() => {
    const m = new Map<string, ModelEntry[]>()
    for (const e of filteredModels) {
      const title = formatProviderTitle(e)
      const list = m.get(title) ?? []
      list.push(e)
      m.set(title, list)
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [filteredModels])

  const showRecent = !searchQuery.trim() && recentModels.length > 0

  // Set of model IDs that already appear in the Recent section. Used to
  // gate the keyboard-selected highlight / ref on provider-group rows so
  // that the same model rendered in both sections does NOT get the
  // selected-row visual marker twice. The Recent row owns the canonical
  // selected-row identity for keyboard navigation.
  const recentModelSet = useMemo<Set<string>>(
    () => new Set(recentModels.map((m) => m.model)),
    [recentModels],
  )

  // Flat list: Recent first (if visible), then each group in order.
  // Deduplicate entries that already appear in Recent so that ArrowDown
  // navigation has no gaps and indexOf returns stable positions.
  const flatList = useMemo<ModelEntry[]>(() => {
    const seen = new Set<string>()
    const out: ModelEntry[] = []
    const push = (entry: ModelEntry) => {
      if (seen.has(entry.model)) return
      seen.add(entry.model)
      out.push(entry)
    }
    if (showRecent) for (const e of recentModels) push(e)
    for (const [, items] of groups) for (const e of items) push(e)
    return out
  }, [recentModels, groups, showRecent])

  // Clamp selectedIndex when flatList shape changes (search/Recent toggle).
  useEffect(() => {
    if (flatList.length === 0) {
      setSelectedIndex(0)
    } else if (selectedIndex >= flatList.length) {
      setSelectedIndex(flatList.length - 1)
    }
  }, [flatList, selectedIndex])

  // Auto-scroll selected row into view.
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  // Reset search + selectedIndex on popover mount (covers re-open case
  // since destroyTooltipOnHide resets component state on remount).
  // No explicit reset needed — initial state already ('', 0).

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, Math.max(0, flatList.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const entry = flatList[selectedIndex]
      if (entry && entry.model !== currentModel && sessionId) {
        void patchSessionModel(sessionId, entry.model)
      }
    }
    // Esc: let antd Popover default handle (close)
  }

  const pickEntry = (entry: ModelEntry) => {
    if (entry.model === currentModel) return
    if (!sessionId) return
    void patchSessionModel(sessionId, entry.model)
  }

  const content = (
    <div
      data-testid="model-picker-content"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{
        width: 360,
        background: '#1f1f1f',
        color: '#fff',
        borderRadius: 6,
        padding: 8,
        maxHeight: 480,
        overflowY: 'auto',
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
          Select model
        </span>
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>esc</span>
      </div>

      {availableModels.length === 0 ? (
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', padding: '12px 4px' }}>
          ~/.zai/settings.json 未配置 models[]
        </div>
      ) : (
        <>
          <Input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search"
            autoFocus
            allowClear
            size="small"
            variant="borderless"
            style={{
              marginBottom: 8,
              border: '1px solid rgba(255,255,255,0.18)',
              borderRadius: 0,
              background: 'transparent',
            }}
          />

          {filteredModels.length === 0 && (
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', textAlign: 'center', padding: '12px 0' }}>
              无匹配模型
            </div>
          )}

          {showRecent && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: 0.5, padding: '4px 4px' }}>
                Recent
              </div>
              {recentModels.map((m) => {
                const flatIdx = flatList.indexOf(m)
                return (
                  <Row
                    key={`recent-${m.alias}`}
                    entry={m}
                    isCurrent={m.model === currentModel}
                    isSelected={flatIdx === selectedIndex}
                    onClick={() => pickEntry(m)}
                    rowRef={flatIdx === selectedIndex ? selectedRowRef : undefined}
                  />
                )
              })}
            </div>
          )}

          {groups.map(([title, items]) => (
            <div key={title} style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: 0.5, padding: '4px 4px' }}>
                {title}
              </div>
              {items.map((m) => {
                const flatIdx = flatList.indexOf(m)
                // If the same model already rendered in Recent, that row
                // owns the keyboard-selected identity; suppress duplicate
                // highlight + ref on this provider-group duplicate.
                const ownsSelected =
                  flatIdx === selectedIndex && !(showRecent && recentModelSet.has(m.model))
                return (
                  <Row
                    key={`group-${title}-${m.alias}`}
                    entry={m}
                    isCurrent={m.model === currentModel}
                    isSelected={ownsSelected}
                    onClick={() => pickEntry(m)}
                    rowRef={ownsSelected ? selectedRowRef : undefined}
                  />
                )
              })}
            </div>
          ))}

          <div
            style={{
              fontSize: 11,
              color: 'rgba(255,255,255,0.30)',
              borderTop: '1px solid rgba(255,255,255,0.08)',
              paddingTop: 6,
              marginTop: 4,
              display: 'flex',
              gap: 12,
            }}
          >
            <span>↑↓ Navigate</span>
            <span>⏎ Select</span>
            <span style={{ color: 'rgba(255,255,255,0.65)' }}>esc Close</span>
          </div>
        </>
      )}
    </div>
  )

  return (
    <Popover
      content={<div onClick={(e) => e.stopPropagation()}>{content}</div>}
      trigger="click"
      placement="topRight"
      destroyTooltipOnHide
    >
      <Button
        type="text"
        size="small"
        title={`当前模型: ${badgeText ?? '未知'}\n点击切换`}
        style={{
          color: 'inherit',
          opacity: currentModel ? 0.9 : 0.6,
          fontSize: 12,
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        }}
      >
        {badgeText ?? '未知'}
      </Button>
    </Popover>
  )
}

interface RowProps {
  entry: ModelEntry
  isCurrent: boolean
  isSelected: boolean
  onClick: () => void
  rowRef?: React.MutableRefObject<HTMLDivElement | null>
}

function Row({ entry, isCurrent, isSelected, onClick, rowRef }: RowProps) {
  return (
    <div
      ref={rowRef ?? undefined}
      onClick={onClick}
      data-testid={`model-row-${entry.alias}`}
      data-selected={isSelected ? 'true' : 'false'}
      data-current={isCurrent ? 'true' : 'false'}
      style={{
        padding: '5px 8px',
        borderRadius: 4,
        cursor: isCurrent ? 'default' : 'pointer',
        background: isSelected ? 'rgba(168, 139, 250, 0.15)' : 'transparent',
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
          {isCurrent ? (
            <span style={{ color: '#a78bfa', fontSize: 12, lineHeight: 1 }}>●</span>
          ) : (
            <span style={{ width: 7 }} />
          )}
          <span
            style={{
              fontSize: 13,
              color: '#fff',
              fontWeight: isCurrent ? 600 : 400,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {entry.label ?? entry.alias}
          </span>
        </div>
        {isCurrent && <CheckOutlined style={{ color: '#a78bfa', fontSize: 11 }} />}
      </div>
      {entry.description && (
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.40)', paddingLeft: 13 }}>
          {entry.description}
        </span>
      )}
      <CapabilityBadges capabilities={entry.capabilities} />
    </div>
  )
}

/**
 * Tiny capability chip strip rendered beneath each picker row. Kept
 * intentionally compact: only vision + function-calling icons get
 * individual chips; context/output is summarised as text to avoid
 * crowding the row.
 */
function CapabilityBadges({ capabilities }: { capabilities?: ModelCapabilities }) {
  if (!capabilities) return null
  const ctx = capabilities.contextWindow
  const out = capabilities.maxOutputTokens
  const hasAny =
    capabilities.supportsVision ||
    capabilities.supportsFunctionCalling ||
    capabilities.supportsReasoning ||
    ctx ||
    out
  if (!hasAny) return null
  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        paddingLeft: 13,
        fontSize: 10,
        color: 'rgba(255,255,255,0.45)',
        flexWrap: 'wrap',
      }}
    >
      {capabilities.supportsVision && (
        <Tooltip title="支持图片多模态">
          <Tag color="purple" style={{ margin: 0, fontSize: 10, lineHeight: '14px', padding: '0 4px' }}>
            <EyeOutlined /> Vision
          </Tag>
        </Tooltip>
      )}
      {capabilities.supportsFunctionCalling && (
        <Tooltip title="支持工具调用">
          <Tag color="cyan" style={{ margin: 0, fontSize: 10, lineHeight: '14px', padding: '0 4px' }}>
            <ThunderboltOutlined /> Tools
          </Tag>
        </Tooltip>
      )}
      {ctx ? (
        <span style={{ paddingLeft: 2 }}>
          上下文 {ctx >= 1_000_000 ? `${(ctx / 1_000_000).toFixed(ctx % 1_000_000 === 0 ? 0 : 1)}M` : `${Math.round(ctx / 1_000)}K`}
        </span>
      ) : null}
      {out ? (
        <span style={{ paddingLeft: 2 }}>
          · 输出 {out >= 1_000_000 ? `${(out / 1_000_000).toFixed(out % 1_000_000 === 0 ? 0 : 1)}M` : `${Math.round(out / 1_000)}K`}
        </span>
      ) : null}
    </div>
  )
}

function formatProviderTitle(entry: ModelEntry): string {
  // Group by the profile name set on ModelEntry.description (set by
  // agentSettings.buildAvailableModels when projecting providerProfiles
  // and the builtin catalog). Falls back to "<host>" when the entry
  // has no description (legacy settings.json models).
  return entry.description ?? extractHost(entry.baseUrl)
}

function extractHost(baseUrl: string | undefined): string {
  if (!baseUrl) return 'default'
  try {
    return new URL(baseUrl).host
  } catch {
    return 'default'
  }
}
