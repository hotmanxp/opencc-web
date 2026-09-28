import { useEffect, useMemo, useRef, useState } from 'react'
import { Input, Popover, Tooltip, Tag } from 'antd'
import { CheckIcon, ChevronDownIcon, EyeIcon, WrenchIcon } from 'lucide-react';
import { useAgentStoreOrCtx } from '../store/useAgentStore.js'
import { useConversationInfo } from '../hooks/useConversationInfo.js'
import type { ModelEntry, ModelCapabilities } from '../../../shared/settings.js'
import { ZAI_DEFAULT_EFFORT_LEVEL, type EffortLevel } from '../../../shared/types.js'

/**
 * zai patch (2026-09-28): 档位按模型解析, 不写死 —— MiniMax-M3.1-Flash-Preview
 * 是五档(low/medium/high/xhigh/max, 默认 max), GLM on Z.AI 只收 low/high/max,
 * 其余多为三档。写死四档既少给了五档模型, 又会给 GLM 塞一个必然 400 的 medium。
 *
 * 真相在服务端: `routes/agentSettings.ts` 用 core 的
 * `getReasoningEffortLevelsForModel` 把 `capabilities.effortLevels` /
 * `capabilities.defaultEffortLevel` 挂到每个 ModelEntry 上随 `/api/agent/settings`
 * 下发。这里刻意**不**从 '@zn-ai/zn-agent-core' 取值 —— 那会把整个 vendor
 * bundle(含可选原生依赖)拖进浏览器构建。
 *
 * 'off' 排第一 —— 它是「不下发 reasoning 字段」的显式选择, adaptive
 * thinking 模型拒收显式 none(见 shared/types.ts 的 EffortLevel 注释)。
 */
const DEFAULT_EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high']

const EFFORT_LEVELS_FOR = (
  capabilities: ModelCapabilities | undefined,
): readonly EffortLevel[] => {
  const declared = capabilities?.effortLevels
  return ['off', ...(declared?.length ? declared : DEFAULT_EFFORT_LEVELS)]
}

/**
 * Canonical (providerId, model) tuple key for a ModelEntry.
 *
 * Two ModelEntries are the same picker row only when both fields match.
 * Alias / label / description / baseUrl are presentation, not identity.
 * Missing providerId (legacy / user-defined entries) collapses to "" —
 * collisions there are an existing limitation noted in ModelEntry.providerId.
 *
 * Extracted from ModelStatusButton so ModelPickerToolbarButton (status-row
 * trigger) and ModelStatusButton (ConfigStatusBar trigger) share one
 * implementation of picker identity / dedup / grouping logic.
 */
export function entryTupleKey(entry: ModelEntry): string {
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
export function isCurrentEntry(
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

/**
 * 共享的 model picker 弹层面板。
 *
 * 2026-09-12 起从 ModelStatusButton 抽出,使 ConfigStatusBar 内 / AgentInputBox
 * 状态行右端两处触发器共享一份 picker 渲染逻辑(搜索 / Recent / Provider 分组 /
 * 键盘导航 / 能力徽章 / current 高亮)。
 *
 * 内部 store 走 useAgentStoreOrCtx —— 这同时是 2026-09-12 的修复: 旧
 * ModelStatusButton 硬编码 useAgentStore(全局单例), 在 NewSuperTaskModal 的
 * intake store 场景下读不到正确 session, 用户无法在该 modal 内切换模型。
 * 改走 ctx 路由后, 无论 panel 被哪个组件触发, 都取当前上下文的 store。
 */
export default function ModelPickerPanel() {
  const { model: currentModel, sessionId } = useConversationInfo()
  const availableModels = useAgentStoreOrCtx((s) => s.availableModels)
  const sessions = useAgentStoreOrCtx((s) => s.sessions)
  const patchSessionModel = useAgentStoreOrCtx((s) => s.patchSessionModel)
  const patchSessionEffort = useAgentStoreOrCtx((s) => s.patchSessionEffort)

  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<any>(null)

  // Derived: provider label for the current session.
  const currentProviderId = useMemo<string | undefined>(() => {
    const sess = sessionId ? sessions.find((s) => s.sessionId === sessionId) : undefined
    return sess?.providerId
  }, [sessionId, sessions])

  // 当前会话模型对应的那条 ModelEntry(优先 providerId 精确匹配)。
  //
  // capability 是「模型」的属性, 不是「哪个 profile 提供它」的属性, 所以
  // 精确匹配命中的一条可能没有 capabilities —— 用户自建 profile 常常不带
  // (实测 provider_1790414326756 就给 MiniMax-M3 标了 supportsReasoning,
  // 却漏了同 profile 下的 MiniMax-M3.1-Flash-Preview), 而内置目录那份是齐的。
  // 同一个模型名因此在 availableModels 里有好几条, 能力要从「任意一条声明了
  // true / 有档位」的那条取, 否则控件会凭空消失。
  const currentEntry = useMemo<ModelEntry | undefined>(() => {
    if (!currentModel) return undefined
    const sameName = availableModels.filter((m) => m.model === currentModel)
    const exact = currentProviderId
      ? sameName.find((m) => m.providerId === currentProviderId)
      : undefined
    const withReasoning = [...(exact ? [exact] : []), ...sameName].find(
      (m) => m.capabilities?.supportsReasoning === true,
    )
    return withReasoning ?? exact ?? sameName[0]
  }, [currentModel, currentProviderId, availableModels])

  // 只给「声明支持推理」的模型显示强度控件 —— 对不支持的模型下发
  // reasoning.effort 会被拒 (MiniMax 2013), 让用户去调一个必然失败的
  // 档位没有意义。
  const currentSupportsReasoning = currentEntry?.capabilities?.supportsReasoning === true

  // 展示用的档位集合 + 选中的档位。
  //
  // 会话里存的 effort 未必属于当前模型支持的档位 —— 换模型时不会重写
  // transcript.meta.effort, 典型场景是 medium → 切到只收 low/high/max 的
  // GLM。此时若直接拿存储值去比对, 按钮全不亮, 用户看不出当前是什么。
  // 所以展示层做一次钳制: 存储值不在集合内就退回服务端兜底档。
  // 只影响高亮, 不回写 store —— 真正发出去的是 modelCaller 白名单校验后的值。
  const { effortLevels, currentEffort } = useMemo(() => {
    const levels = EFFORT_LEVELS_FOR(currentEntry?.capabilities)
    const sess = sessionId ? sessions.find((s) => s.sessionId === sessionId) : undefined
    const stored = sess?.effort
    if (stored && levels.includes(stored)) return { effortLevels: levels, currentEffort: stored }
    // 会话没设过 → 高亮服务端兜底档,与 modelCaller 实际下发的值一致。
    // 这里刻意不用 capabilities.defaultEffortLevel:那描述的是厂商自己的
    // 默认(MiniMax-M3.1-Flash-Preview 声明 max),不是 zai 选去下发的值,
    // 拿它高亮会显示「Max」而线上跑的是 high。
    if (levels.includes(ZAI_DEFAULT_EFFORT_LEVEL)) {
      return { effortLevels: levels, currentEffort: ZAI_DEFAULT_EFFORT_LEVEL }
    }
    return { effortLevels: levels, currentEffort: 'off' as EffortLevel }
  }, [currentEntry, sessionId, sessions])

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
  const recentTupleSet = useMemo<Set<string>>(
    () => new Set(recentModels.map(entryTupleKey)),
    [recentModels],
  )

  // Flat list: Recent first (if visible), then each group in order.
  // Deduplicate entries that already appear in Recent so that ArrowDown
  // navigation has no gaps and indexOf returns stable positions.
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
  // toggle).
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

  return (
    <div
      data-testid="model-picker-content"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="w-[360px] bg-[var(--bg-popup)] rounded-md p-2 max-h-[480px] overflow-y-auto"
    >
      <div
        className="flex justify-between items-center mb-1.5"
      >
        <span className="text-xs font-semibold text-[var(--text-dim-55)]">
          Select model
        </span>
        <span className="text-[11px] text-[var(--text-dim-65)]">esc</span>
      </div>

      {availableModels.length === 0 ? (
        <div className="text-xs text-[var(--text-dim-45)] py-3 px-1">
          ~/.zai/settings.json 未配置 models[]
        </div>
      ) : (
        <>
          {/* zai patch (2026-09-28): 强度控件放在顶部而不是模型列表末尾。
              放末尾时它要滚过 Recent + 全部分组才看得到, 而这是模型名旁边
              唯一的调参入口 —— 打开弹框第一眼就该看见当前档位。 */}
          {currentSupportsReasoning && sessionId && (
            <div className="mb-2">
              <div className="text-[10px] font-semibold text-[var(--text-dim-55)] uppercase tracking-wider mb-1.5">
                Reasoning effort
              </div>
              <div className="flex gap-1">
                {effortLevels.map((level) => {
                  const active = level === currentEffort
                  return (
                    <button
                      key={level}
                      type="button"
                      onClick={() => {
                        if (level === currentEffort) return
                        void patchSessionEffort(sessionId, level)
                      }}
                      className={
                        active
                          ? 'flex-1 text-[11px] py-1 rounded-[3px] border border-[#a78bfa] text-[#a78bfa] bg-[#a78bfa]/10'
                          : 'flex-1 text-[11px] py-1 rounded-[3px] border border-[var(--border-mid)] text-[var(--text-dim-45)] hover:text-[var(--text-dim-65)] hover:border-[var(--border-strong)]'
                      }
                    >
                      {level}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          <Input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search"
            autoFocus
            allowClear
            size="small"
            variant="borderless"
            className="!mb-2 !border !border-solid !border-[var(--border-mid)] !rounded-none !bg-transparent"
          />

          {filteredModels.length === 0 && (
            <div className="text-xs text-[var(--text-dim-45)] text-center py-3">
              无匹配模型
            </div>
          )}

          {showRecent && (
            <div className="mb-2">
              <div className="text-[10px] font-semibold text-[#a78bfa] uppercase tracking-wider p-1">
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
            <div key={title} className="mb-1.5">
              <div className="text-[10px] font-semibold text-[#a78bfa] uppercase tracking-wider p-1">
                {title}
              </div>
              {items.map((m) => {
                const flatIdx = flatList.indexOf(m)
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
            className="text-[11px] text-[var(--text-dim-30)] border-t border-[var(--border-light)] pt-1.5 mt-1 flex gap-3"
          >
            <span>↑↓ Navigate</span>
            <span>⏎ Select</span>
            <span className="text-[var(--text-dim-65)]">esc Close</span>
          </div>
        </>
      )}
    </div>
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
        cursor: isCurrent ? 'default' : 'pointer',
        background: isSelected ? 'rgba(168, 139, 250, 0.15)' : 'transparent',
      }}
      className="px-2 py-1.5 rounded flex flex-col gap-px"
    >
      <div className="flex justify-between items-center gap-1.5">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          {isCurrent ? (
            <span className="text-[#a78bfa] text-xs leading-none">●</span>
          ) : (
            <span className="w-[7px]" />
          )}
          <span
            className={
              isCurrent
                ? 'text-[13px] font-semibold whitespace-nowrap overflow-hidden text-ellipsis'
                : 'text-[13px] font-normal whitespace-nowrap overflow-hidden text-ellipsis'
            }
          >
            {entry.label ?? entry.alias}
          </span>
        </div>
        {isCurrent && <CheckIcon className="!text-[#a78bfa] !text-[11px]" />}
      </div>
      {entry.description && (
        <span className="text-[11px] text-[var(--text-dim-40)] pl-3.5">
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
      className="flex gap-1 pl-3.5 text-[10px] text-[var(--text-dim-45)] flex-wrap"
    >
      {capabilities.supportsVision && (
        <Tooltip title="支持图片多模态">
          <Tag color="purple" className="!m-0 !text-[10px] !leading-[14px] !py-0 !px-1">
            <EyeIcon /> Vision
          </Tag>
        </Tooltip>
      )}
      {capabilities.supportsFunctionCalling && (
        <Tooltip title="支持工具调用">
          <Tag color="cyan" className="!m-0 !text-[10px] !leading-[14px] !py-0 !px-1">
            <WrenchIcon /> Tools
          </Tag>
        </Tooltip>
      )}
      {ctx ? (
        <span className="pl-0.5">
          上下文 {ctx >= 1_000_000 ? `${(ctx / 1_000_000).toFixed(ctx % 1_000_000 === 0 ? 0 : 1)}M` : `${Math.round(ctx / 1000)}K`}
        </span>
      ) : null}
      {out ? (
        <span className="pl-0.5">
          · 输出 {out >= 1_000_000 ? `${(out / 1_000_000).toFixed(out % 1_000_000 === 0 ? 0 : 1)}M` : `${Math.round(out / 1000)}K`}
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

/**
 * 紧凑型 model badge 文本(供 ModelStatusButton 与 ModelPickerToolbarButton
 * 复用)。返回当前 session 的 model 显示名(可能带 provider 描述)。
 *
 * compact=true (ConfigStatusBar 的 split-pane 分屏态) 或 isMobile 时仅返回
 * 模型名, 不带括号 provider, 把宽度留给其他状态栏元素。hover title 由调用
 * 方自行包装 button.title 保留完整文案。
 */
export function useModelBadgeText(opts: { compact?: boolean; isMobile?: boolean } = {}): {
  text: string | null
  tooltipText: string | null
} {
  const { model: currentModel, sessionId } = useConversationInfo()
  const availableModels = useAgentStoreOrCtx((s) => s.availableModels)
  const sessions = useAgentStoreOrCtx((s) => s.sessions)
  const { compact = false, isMobile = false } = opts

  const currentProviderId = useMemo<string | undefined>(() => {
    const sess = sessionId ? sessions.find((s) => s.sessionId === sessionId) : undefined
    return sess?.providerId
  }, [sessionId, sessions])

  return useMemo(() => {
    if (!currentModel) return { text: null, tooltipText: null }
    const fullText = (() => {
      const exact = availableModels.find(
        (m) => m.model === currentModel && m.providerId === currentProviderId,
      )
      const entry = exact ?? availableModels.find((m) => m.model === currentModel)
      if (!entry || !entry.description) return currentModel
      return `${currentModel} (${entry.description})`
    })()
    const compactText = compact || isMobile ? currentModel : fullText
    return { text: compactText, tooltipText: fullText }
  }, [currentModel, currentProviderId, availableModels, compact, isMobile])
}
