import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Input, Popover, Tag, Tooltip } from 'antd'
import { CaretDownOutlined, CheckOutlined, EyeOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { useConversationInfo } from '../hooks/useConversationInfo.js'
import { useAgentStore } from '../store/useAgentStore.js'
import { useAppStore } from '../store/useAppStore.js'
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
 * Each row shows ● marker when (entry.model, entry.providerId) matches
 * the session's current (model, providerId) tuple — comparing on model
 * alone is ambiguous when the same model name appears on multiple
 * provider profiles. Rows also get a violet-tint background when the
 * keyboard-selectedIndex matches.
 *
 * Keyboard: ArrowUp/Down move selectedIndex in flatList (Recent first,
 * then each group's entries in order); Enter calls patchSessionModel;
 * Esc bubbles to antd Popover default close.
 */
/**
 * Canonical (providerId, model) tuple key for a ModelEntry.
 *
 * Two ModelEntries are the same picker row only when both fields match.
 * Alias / label / description / baseUrl are presentation, not identity.
 * Missing providerId (legacy / user-defined entries) collapses to "" —
 * collisions there are an existing limitation noted in ModelEntry.providerId.
 */
function entryTupleKey(entry: ModelEntry): string {
  return `${entry.providerId ?? ''}::${entry.model}`
}

/**
 * Is this row the session's currently-active selection? Compares on
 * (providerId, model) tuple — `model` alone is ambiguous when the
 * same model name appears on multiple provider profiles.
 *
 * Returns false when the session has no providerId recorded AND there
 * are multiple providers with the same model name — we genuinely
 * cannot know which one is "current" in that case, so rendering a
 * marker on any row (or worse, on every row) is misleading. The user
 * can still pick any row; once they do, the session gets a providerId
 * and strict matching kicks in.
 */
function isCurrentEntry(
  entry: ModelEntry,
  currentModel: string | undefined,
  currentProviderId: string | undefined,
  hasAmbiguousName: boolean,
): boolean {
  if (!currentModel) return false
  if (entry.model !== currentModel) return false
  if (currentProviderId !== undefined) {
    return entry.providerId === currentProviderId
  }
  // Legacy session without providerId.
  if (hasAmbiguousName) {
    // Same model name on multiple providers — we don't know which one
    // the session is actually using, so mark none of them.
    return false
  }
  // Unique model name → safe to mark by model alone.
  return true
}

type Props = {
  /**
   * 右侧分屏是否展开. 展开时按钮只显示模型名 (隐藏括号里的 provider 描述) ,
   * 给窄屏幕 / 分屏态腾出横向空间. 默认 false (保持向后兼容, 即完整渲染).
   */
  compact?: boolean
}

export default function ModelStatusButton({ compact = false }: Props = {}) {
  const { model: currentModel, sessionId } = useConversationInfo()
  const availableModels = useAgentStore((s) => s.availableModels)
  const sessions = useAgentStore((s) => s.sessions)
  const patchSessionModel = useAgentStore((s) => s.patchSessionModel)
  // 移动端直接从 useAppStore.isMobile 读, 与 ModeStatusButton 同模式.
  const isMobile = useAppStore((s) => s.isMobile)

  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<any>(null)

  // Derived: provider label for the badge = "model-name(provider-name)".
  // Looks up the current model in availableModels to find its
  // `description` (set to the profile name by agentSettings.buildAvailableModels
  // for both user models and builtin entries) — e.g.
  // "MiniMax-M3 (Open Platform (Nova))".
  //
  // zai patch: when the same model name appears in multiple provider
  // groups (e.g. `MiniMax-M3` on both Open Platform and ZhiNiao), we
  // prefer the entry whose `providerId` matches the one the user
  // picked for this session. Falls back to first-match by model name
  // when providerId is absent (legacy sessions without the field).
  //
  // compact=true (分屏态) 或移动端时只返回模型名, 不带括号 provider,
  // 把宽度留给其他状态栏元素. hover title 仍保留完整文案, 鼠标 hover
  // (桌面端) 或展开 picker 仍能拿到 provider 信息.
  const currentProviderId = useMemo<string | undefined>(() => {
    const sess = sessionId ? sessions.find((s) => s.sessionId === sessionId) : undefined
    return sess?.providerId
  }, [sessionId, sessions])
  const badgeText = useMemo<string | null>(() => {
    if (!currentModel) return null
    if (compact || isMobile) return currentModel
    const exact = availableModels.find(
      (m) => m.model === currentModel && m.providerId === currentProviderId,
    )
    const entry = exact ?? availableModels.find((m) => m.model === currentModel)
    if (!entry || !entry.description) return currentModel
    return `${currentModel} (${entry.description})`
  }, [currentModel, currentProviderId, availableModels, compact, isMobile])

  // Derived: recent models from sessions, recency-weighted, deduped, max 5.
  // zai patch: dedup key is (providerId, model) instead of model alone —
  // the same model name can appear in multiple provider profiles and the
  // picker must treat each (providerId, model) tuple as a distinct row.
  const recentModels = useMemo<ModelEntry[]>(() => {
    const seen = new Set<string>()
    const out: ModelEntry[] = []
    const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
    for (const s of sorted) {
      if (!s.model || s.model === 'unknown') continue
      const key = `${s.providerId ?? ''}::${s.model}`
      if (seen.has(key)) continue
      const entry = availableModels.find(
        (m) => m.model === s.model && m.providerId === s.providerId,
      )
      // Fallback: legacy sessions without providerId — match by model name
      // only when no providerId is recorded on the session.
      const fallback = entry ?? (s.providerId
        ? undefined
        : availableModels.find((m) => m.model === s.model))
      if (!fallback) continue
      seen.add(key)
      out.push(fallback)
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

  // True when `currentModel` exists under more than one (providerId, model)
  // tuple in `availableModels`. Used by isCurrentEntry to decide whether to
  // fall back to a model-only match for legacy sessions that have no
  // providerId recorded — only safe when the model name is unique across
  // providers.
  const hasAmbiguousCurrentName = useMemo(() => {
    if (!currentModel) return false
    let count = 0
    for (const e of availableModels) {
      if (e.model === currentModel) {
        count++
        if (count > 1) return true
      }
    }
    return false
  }, [currentModel, availableModels])

  const showRecent = !searchQuery.trim() && recentModels.length > 0

  // Set of (providerId, model) tuples that already appear in the Recent
  // section. Used to gate the keyboard-selected highlight / ref on
  // provider-group rows so that the same tuple rendered in both sections
  // does NOT get the selected-row visual marker twice. The Recent row
  // owns the canonical selected-row identity for keyboard navigation.
  // zai patch: key is the (providerId, model) tuple — using model name
  // alone would let a Recent row "consume" highlights for every other
  // provider's copy of the same model.
  const recentTupleSet = useMemo<Set<string>>(
    () => new Set(recentModels.map(entryTupleKey)),
    [recentModels],
  )

  // Flat list: Recent first (if visible), then each group in order.
  // Deduplicate entries that already appear in Recent so that ArrowDown
  // navigation has no gaps and indexOf returns stable positions.
  // zai patch: dedup key is (providerId, model), not model — the same
  // model name on two provider profiles must remain two selectable rows.
  const flatList = useMemo<ModelEntry[]>(() => {
    const seen = new Set<string>()
    const out: ModelEntry[] = []
    const push = (entry: ModelEntry) => {
      const key = entryTupleKey(entry)
      if (seen.has(key)) return
      seen.add(key)
      out.push(entry)
    }
    if (showRecent) for (const e of recentModels) push(e)
    for (const [, items] of groups) for (const e of items) push(e)
    return out
  }, [recentModels, groups, showRecent])

  // Pick the initial keyboard-highlight row on popover mount. The picker
  // is rendered inside an antd Popover with destroyTooltipOnHide → the
  // component fully unmounts on close and remounts on open, so the
  // lazy initializer runs fresh each session and `useState(() => …)`
  // is the natural place to compute the start index.
  //
  // zai patch: jump to whichever row matches the session's current
  // (model, providerId) tuple — Enter calls patchSessionModel using
  // selectedIndex, so mis-aligned defaults silently move the session to
  // the wrong provider when several profiles share a model name. Falls
  // back to flatList[0] when the current model isn't in the list (e.g.
  // session.model='unknown' / settings not yet loaded) or when the
  // session has no providerId and the model name is ambiguous across
  // providers — the row's "●" marker is the source of truth for
  // "current" in that legacy case, the keyboard highlight just needs a
  // sensible start.
  const [selectedIndex, setSelectedIndex] = useState<number>(() => {
    const target = flatList.findIndex(
      (e) =>
        e.model === currentModel
        && (currentProviderId === undefined
          ? true
          : e.providerId === currentProviderId),
    )
    return target >= 0 ? target : 0
  })
  const selectedRowRef = useRef<HTMLDivElement | null>(null)

  // Auto-scroll selected row into view.
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  // Clamp selectedIndex when flatList shape changes (search/Recent
  // toggle). The lazy initializer already pins the start position to
  // the session's current row, so we only need to react to mid-life
  // shape changes here.
  useEffect(() => {
    if (flatList.length === 0) {
      setSelectedIndex(0)
    } else if (selectedIndex >= flatList.length) {
      setSelectedIndex(flatList.length - 1)
    }
  }, [flatList, selectedIndex])

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
      // zai patch: also pass providerId so the server-side matcher can
      // route to the exact provider the user picked. The (model,
      // providerId) tuple is the canonical identity for a picker row;
      // comparing on model alone is not enough when several provider
      // groups host the same model name.
      if (
        entry
        && (entry.model !== currentModel || entry.providerId !== currentProviderId)
        && sessionId
      ) {
        void patchSessionModel(sessionId, {
          model: entry.model,
          providerId: entry.providerId,
        })
      }
    }
    // Esc: let antd Popover default handle (close)
  }

  const pickEntry = (entry: ModelEntry) => {
    if (entry.model === currentModel && entry.providerId === currentProviderId) return
    if (!sessionId) return
    void patchSessionModel(sessionId, {
      model: entry.model,
      providerId: entry.providerId,
    })
  }

  const content = (
    <div
      data-testid="model-picker-content"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{
        width: 360,
        background: 'var(--bg-popup)',
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
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-dim-55)' }}>
          Select model
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-dim-65)' }}>esc</span>
      </div>

      {availableModels.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-dim-45)', padding: '12px 4px' }}>
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
              border: '1px solid var(--border-mid)',
              borderRadius: 0,
              background: 'transparent',
            }}
          />

          {filteredModels.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-dim-45)', textAlign: 'center', padding: '12px 0' }}>
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
                    key={`recent-${entryTupleKey(m)}`}
                    entry={m}
                    isCurrent={isCurrentEntry(m, currentModel, currentProviderId, hasAmbiguousCurrentName)}
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
                // If the same (providerId, model) tuple already rendered
                // in Recent, that row owns the keyboard-selected identity;
                // suppress duplicate highlight + ref on this duplicate.
                // zai patch: compare on tuple key, not model name alone —
                // same model on a different provider is a different row.
                const ownsSelected =
                  flatIdx === selectedIndex && !(showRecent && recentTupleSet.has(entryTupleKey(m)))
                return (
                  <Row
                    key={`group-${title}-${entryTupleKey(m)}`}
                    entry={m}
                    isCurrent={isCurrentEntry(m, currentModel, currentProviderId, hasAmbiguousCurrentName)}
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
              color: 'var(--text-dim-30)',
              borderTop: '1px solid var(--border-light)',
              paddingTop: 6,
              marginTop: 4,
              display: 'flex',
              gap: 12,
            }}
          >
            <span>↑↓ Navigate</span>
            <span>⏎ Select</span>
            <span style={{ color: 'var(--text-dim-65)' }}>esc Close</span>
          </div>
        </>
      )}
    </div>
  )

  return (
    <Popover
      content={<div onClick={(e) => e.stopPropagation()}>{content}</div>}
      trigger="click"
      placement={isMobile ? 'bottom' : 'topLeft'}
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
          // 移动端走 ConfigStatusBar: antd small Button 默认 padding 0 7px
          // 会在 caret 右侧留出一大块空白. 收紧到 0 2px, 把间距交给外层
          // ConfigStatusBar 的 gap 统一管控, 否则底栏 '· main · MiniMax-M3 ·'
          // 在窄屏里被撑爆.
          padding: isMobile ? '0 2px' : undefined,
        }}
      >
        {badgeText ?? '未知'}
        <CaretDownOutlined style={{ fontSize: 10, opacity: 0.6, marginLeft: -8 }} />
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
        <span style={{ fontSize: 11, color: 'var(--text-dim-40)', paddingLeft: 13 }}>
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
        color: 'var(--text-dim-45)',
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
