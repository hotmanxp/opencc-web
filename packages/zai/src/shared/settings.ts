/**
 * Per-model capability metadata — mirrors ModelCapabilities in
 * shared/types.ts but flattened onto the alias-table entry that the
 * picker UI consumes. Kept separate so ModelEntry stays self-contained
 * (settings.json consumers don't have to thread ProviderProfile).
 */
export interface ModelCapabilities {
  contextWindow?: number
  maxOutputTokens?: number
  supportsVision?: boolean
  supportsFunctionCalling?: boolean
  supportsReasoning?: boolean
  supportsJsonMode?: boolean
  supportsStreaming?: boolean
}

/**
 * Alias-table entry powering the model picker UI.
 *
 * - `alias`: short identifier shown in the UI ("M3", "haiku").
 * - `model`: full model ID sent to the upstream API ("MiniMax-M3",
 *   "MiniMax-M2.7-highspeed"). This is the value stored in
 *   transcript.meta.model after a picker selection.
 * - `label` / `description`: optional UI presentation fields.
 * - `capabilities`: optional per-model capabilities (context window,
 *   vision, tool calling, …). Populated when the entry is sourced
 *   from a ProviderProfile that ships a `capabilities` map; otherwise
 *   undefined and the UI hides capability badges.
 */
export interface ModelEntry {
  alias: string
  model: string
  label?: string
  description?: string
  /** Upstream OpenAI-compatible base URL; falls back to OpenAI default when omitted. */
  baseUrl?: string
  capabilities?: ModelCapabilities
}

/**
 * Output style for the web UI transcript.
 *
 *  - 'default'  → expanded transcript (legacy behavior, no collapse).
 *  - 'compact'  → messages render as collapsed bubbles by default; the
 *                 toolbar's manual collapse/expand button toggles a
 *                 transient override that resets when the user reloads.
 *  - 'verbose'  → reserved for future use (today: same as 'default').
 */
export type OutputStyle = 'default' | 'compact' | 'verbose'

/**
 * 用户主题偏好. 'auto' / 'high-contrast' 由 useEffectiveTheme() 解析为跟随系统
 * prefers-color-scheme,见 packages/zai/src/web/src/hooks/useEffectiveTheme.ts.
 *
 * 持久化到 ~/.zai/settings.json(settings.theme),见 docs/superpowers/specs/
 * 2026-07-27-zai-theme-persistence-design.md.
 */
export type Theme = 'auto' | 'dark' | 'light' | 'high-contrast'

/** Shape of ~/.zai/settings.json. */
export interface ZaiSettings {
  env?: Record<string, string>
  /** Global default (resolution chain layer 4). */
  model?: string
  /** Alias table powering the picker UI. */
  models?: ModelEntry[]
  /** Default permission mode surfaced in the Settings drawer. */
  defaultMode?: string
  /** Web transcript output style — see OutputStyle. */
  outputStyle?: OutputStyle
  /**
   * Web UI 主题偏好 — see Theme. 持久化到 ~/.zai/settings.json.
   * 缺失 / 未知值由 resolveTheme() 折叠为 'auto'.
   */
  theme?: Theme
  /**
   * 主对话区最大渲染消息条数. 超过时 UI 折叠早期消息,顶部浮按钮一键还原.
   * 默认 20. clamp [1, 1000].
   */
  maxVisibleMessages?: number
}

/**
 * Tier-3 fallback settings seeded into ~/.zai/settings.json on first boot
 * when neither ~/.zai nor ~/.claude settings exist. Minimal but valid —
 * mirrors the "empty but present" shape callers already defend against,
 * so resolveOutputStyle / env lookups behave identically to the legacy
 * "file missing → {}" path.
 */
export const BUILTIN_DEFAULT_SETTINGS: ZaiSettings = {
  env: {},
  defaultMode: 'default',
  outputStyle: 'default',
  maxVisibleMessages: 20,
}