import { useMemo, useState } from 'react'
import { Button, Popover } from 'antd'
import {
  ThunderboltOutlined,
  CaretDownOutlined,
  CheckOutlined,
} from '@ant-design/icons'

import { useAgentStore } from '../store/useAgentStore.js'
import { useAppStore } from '../store/useAppStore.js'

/**
 * Reasoning effort 选择按钮(ds-022 effort-picker follow-up)。
 *
 * Behavior:
 *   - 如果当前 session 的 selected model 在 `ModelEntry.reasoningLevels`
 *     里没有 levels 列表(或列表为空)→ button 不渲染(纯 non-reasoning
 *     model 不该 picker 干扰)。
 *   - 如果 current model 有 levels 但 session.reasoningEffort 是空 → 显示
 *     "自动",picker 顶层"自动"选项把 reasoningEffort 写空字符串。
 *   - picker 列表是 'auto' + 该 model 的 reasoningLevels 顺序,Enter / 点击
 *     commit → patchSessionReasoningEffort PATCH + 本地 store 同步。
 *
 * Provider 模型能力元数据来源:
 *   - `useAgentStore.availableModels[i].reasoningLevels` 来自 settings / provider
 *     profile;ProviderProfile 还没显式 export reasoningLevels(后续 d-024
 *     follow-up 在 anthropicProfile 自带声明)
 *   - 当前先 zustand store 含 `reasoningEffort` field(level 列表来自
 *     server-provided),不命中时按钮 hidden。
 *
 * 跟 ModelStatusButton 平级(Effort 只在 selectedModel 支持时显示),
 * 不嵌入 model picker —— 避免 model picker popover 状态机变复杂。
 */
type Props = {
  /**
   * 右侧分屏是否展开. 展开时按钮只显示当前 effort 缩写,折叠 "自动"。
   * 默认 false (保持向后兼容).
   */
  compact?: boolean
}

/** Short label for the picker rows. */
const EFFORT_LABELS: Record<string, string> = {
  '': '自动',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '极强',
  ultracode: '终极',
}

export default function EffortStatusButton({ compact = false }: Props = {}) {
  // 防御性:用 zustand 直接读 `sessionId` + `activeSessionId` 兜底(同
  // useConversationInfo 内部 effectiveSessionId 语义)。避开
  // useConversationInfo 的 useState 本地 runtime 因 v3 vite HMR 偶尔
  // 不重 mount 引发的 stale state bug。
  const sessionId = useAgentStore((s) => s.sessionId)
  // 移动端直接从 useAppStore.isMobile 读, 与 ModelStatusButton/TaskDock 同模式.
  // 窄屏状态栏只显示 effort 缩写, 去掉 "effort: " 前缀给 model / cwd 留横向空间.
  const isMobile = useAppStore((s) => s.isMobile)
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const effectiveSessionId = sessionId ?? activeSessionId ?? null
  const availableModels = useAgentStore((s) => s.availableModels)
  const sessions = useAgentStore((s) => s.sessions)
  const patchSessionReasoningEffort = useAgentStore(
    (s) => s.patchSessionReasoningEffort,
  )

  const [open, setOpen] = useState(false)

  const session = useMemo(
    () => sessions.find((s) => s.sessionId === effectiveSessionId),
    [sessions, effectiveSessionId],
  )

  const model = session?.model ?? null

  // 1. 找 selectedModel 在 availableModels 里的 entry,与 ModelStatusButton
  //    `isCurrentEntry` 行为完全镜像 — 兼容老 session(无 providerId) +
  //    cross-provider model 共享(zhiniao-M2.7 vs openplatform-M3 同名场景)。
  //    关键:用户跨 provider 切 model 后,精确匹配 miss,要 fallback 到
  //    model-only 兜底,否则 effort picker 永远不显示。
  const selectedEntry = useMemo(() => {
    if (!model) return null
    const sessProviderId = (session as { providerId?: string } | undefined)
      ?.providerId

    if (sessProviderId === undefined) {
      // 老 session 没 providerId — model-only 兜底
      return availableModels.find((m) => m.model === model) ?? null
    }

    // 有 providerId — 精确匹配优先
    const exact = availableModels.find(
      (m) => m.model === model && m.providerId === sessProviderId,
    )
    if (exact) return exact

    // 精确 miss:看 cross-provider 共享情况。多 provider 共享同 model 名时
    // 仍走精确,不能 fallback(避免歧义);单 provider 出现 miss 通常是用户
    // 跨 provider 切换后老 providerId 未清,fallback 让 picker 继续工作。
    const sameModelCount = availableModels.filter(
      (m) => m.model === model,
    ).length
    if (sameModelCount <= 1) {
      return availableModels.find((m) => m.model === model) ?? null
    }
    return null
  }, [availableModels, model, session])

  // 2. 该 model 支持的 effort levels(空 → 按钮 hide)
  const levels = selectedEntry?.reasoningLevels ?? []
  // ds-022 effort-picker debug:visible artifact 仅 dev 渲染。
  // 在生产构建 tree-shake 移除(vite 用 process.env.NODE_ENV 静态替换)。
  if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') {
    const w = window as unknown as { __zai_debug_effort?: unknown }
    w.__zai_debug_effort = {
      model,
      sessionId,
      availableModelsCount: availableModels.length,
      session_model: session?.model,
      session_providerId: (session as { providerId?: string } | undefined)?.providerId,
      entry_found: !!selectedEntry,
      levels,
    }
    // eslint-disable-next-line no-console
    console.warn('[EffortStatusButton debug]', JSON.stringify(w.__zai_debug_effort))
  }

  if (levels.length === 0) return null

  // 3. 当前 session 选定的 effort(空 = 自动)
  const currentEffort = (session as { reasoningEffort?: string } | undefined)
    ?.reasoningEffort
  const displayLabel = currentEffort && currentEffort.length > 0
    ? (EFFORT_LABELS[currentEffort] ?? currentEffort)
    : '自动'

  async function handleSelect(level: string) {
    if (!sessionId) return
    setOpen(false)
    // 空字符串 → "自动" → 后端把 '' 视同 clear,本地 set 也不写字段
    await patchSessionReasoningEffort(sessionId, level)
  }

  const buttonLabel = (compact || isMobile) ? displayLabel : `effort: ${displayLabel}`

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="bottom"
      content={
        <div style={{ minWidth: 140, padding: '4px 0' }}>
          {[
            { value: '', label: '自动', description: '使用模型默认 effort(由 vendor 决定)' },
            ...levels.map((lv) => ({
              value: lv,
              label: EFFORT_LABELS[lv] ?? lv,
              description: lv, // generic 描述 — 不同 vendor 语义不同
            })),
          ].map((opt) => {
            const isCurrent =
              (currentEffort ?? '') === opt.value
            return (
              <div
                key={opt.value || 'auto'}
                role="button"
                tabIndex={0}
                onClick={() => void handleSelect(opt.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    void handleSelect(opt.value)
                  }
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 12px',
                  cursor: 'pointer',
                  background: isCurrent
                    ? 'rgba(249, 115, 22, 0.12)'
                    : 'transparent',
                  color: isCurrent ? 'var(--accent-start)' : 'var(--ui-text-color)',
                }}
                data-effort-value={opt.value || 'auto'}
                data-effort-current={isCurrent ? 'true' : 'false'}
              >
                {isCurrent ? (
                  <CheckOutlined style={{ fontSize: 12 }} />
                ) : (
                  <span style={{ width: 12 }} />
                )}
                <span style={{ flex: 1 }}>{opt.label}</span>
              </div>
            )
          })}
        </div>
      }
    >
      <Button
        size="small"
        type="text"
        aria-label={`当前 effort: ${displayLabel},点击切换`}
        data-testid="effort-status-button"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          color: currentEffort ? 'var(--accent-start)' : 'inherit',
          fontFamily: 'inherit',
          fontSize: 12,
        }}
      >
        <ThunderboltOutlined />
        <span>{buttonLabel}</span>
        <CaretDownOutlined />
      </Button>
    </Popover>
  )
}
