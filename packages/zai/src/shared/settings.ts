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
  /**
   * Identifier of the provider profile this entry came from. When
   * present, the server-side matcher prefers this provider for the
   * model over the first profile whose model list happens to contain
   * the same model name. Sourced from `ProviderProfile.id`; absent
   * for user-defined entries in `~/.zai/settings.json → models[]`
   * (which the server treats as "no preference, pick first match").
   */
  providerId?: string
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

/** Global working context selected from the zai settings drawer. */
export type WorkMode = 'code' | 'office' | 'general'

/**
 * 用户主题偏好. 'auto' / 'high-contrast' 由 useEffectiveTheme() 解析为跟随系统
 * prefers-color-scheme,见 packages/zai/src/web/src/hooks/useEffectiveTheme.ts.
 *
 * 持久化到 ~/.zai/settings.json(settings.theme),见 docs/superpowers/specs/
 * 2026-07-27-zai-theme-persistence-design.md.
 */
export type Theme = 'auto' | 'dark' | 'light' | 'high-contrast'

/**
 * Permission rules block in ~/.zai/settings.json — opencc convention.
 * `allow` / `deny` / `ask` are tool-permission rule lists; `defaultMode`
 * is the default permission mode new sessions boot into (read first by
 * `getDefaultMode()` via `permissions.defaultMode`).
 */
export interface ZaiPermissions {
  allow?: string[]
  deny?: string[]
  ask?: string[]
  defaultMode?: string
}

/** Shape of ~/.zai/settings.json. */
export interface ZaiSettings {
  env?: Record<string, string>
  /** Global default (resolution chain layer 4). */
  model?: string
  /** Alias table powering the picker UI. */
  models?: ModelEntry[]
  /** Default permission mode surfaced in the Settings drawer. */
  defaultMode?: string
  /** Permission rules + default mode (opencc convention). See ZaiPermissions. */
  permissions?: ZaiPermissions
  /** Web transcript output style — see OutputStyle. */
  outputStyle?: OutputStyle
  /** Global working context used to tailor future zai behavior. */
  workMode?: WorkMode
  /**
   * 主 Agent 选择(内置或 ~/.zai/main-agents/*.js 外置 agent 的 name)。
   * 缺失 / 未知名 → 'default'(系统默认,不改动任何插槽)。
   * 见 docs/superpowers/specs/2026-08-20-zai-main-agent-slots-design.md。
   */
  mainAgent?: string
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
  /**
   * 桌面端打开 Agent 页面时是否默认启动右侧分屏 (File / Git / Bash 面板).
   * 仅在 localStorage 中无显式覆盖时生效 — 用户手动 toggle 后的选择永远胜出,
   * 因此此设置只是"首次启动"的种子值,不会每次重置用户的偏好.
   * 缺失 / 非 boolean → false. 详见 SplitPane.tsx 的 first-run seed 逻辑.
   */
  defaultSplitScreen?: boolean
  /**
   * 是否启用动态工作流 (WorkflowTool — 多 agent 编排工具)。
   *
   * 默认 false — workflow 会一次性起几十个 sub-agent 烧大量 token,
   * 必须由用户在 SettingsDrawer 主动打开才暴露给 LLM。
   *
   * 关闭时:`process.env.OPENCC_ENABLE_WORKFLOWS` 不设 →
   * vendor `isWorkflowsDisabled()` 返回 true → `getAllBaseTools()`
   * 把 WorkflowTool 从工具池里过滤掉,LLM 完全看不到这个工具。
   * 开启时:server 端 PUT handler 同步写 `process.env.OPENCC_ENABLE_WORKFLOWS=1`,
   * 下次 `query()` 触发的 `getAllBaseTools()` 调用就会把 WorkflowTool
   * 重新纳入。中途切换不需要重启。
   *
   * 缺失 / 非 boolean → false。详见 `agentSettings.ts` 的 PUT route
   * 与 `openccInit.ts:enableOpenccConfigs()` 的 boot-time bridge。
   */
  enableDynamicWorkflow?: boolean
  /**
   * 是否启用 zai 自身版本自动升级检测。
   *
   * 默认 true — 启动时 `maybeAutoUpdate()`(services/updater.ts)在后台异步
   * 跑 `npm view @zn-ai/zai version`,对比当前 `package.json` 版本,
   * 有新版则静默 `npm install -g @zn-ai/zai@<version>`,完成后 SSE
   * 推送 `app.update.complete` 事件,前端 UpdateNotifier 弹窗提示「请重启」。
   *
   * 关闭时启动完全跳过该流程,无网络调用、无 npm 子进程、无事件。
   *
   * 缺失 / 非 boolean → true(`BUILTIN_DEFAULT_SETTINGS.autoUpdate = true`)。
   * 开发模式(`zai dev` 从 workspace 源起)走 ZAI_FROM_GLOBAL_INSTALL
   * 检测,直接跳过 — 避免每次 dev 启动都跟 npm registry 对比 source
   * 包版本。
   */
  autoUpdate?: boolean
  /**
   * Weixin (微信) 机器人后台 task 配置。
   * 详见 docs/superpowers/plans/2026-08-16-zai-weixin-bot-platform.md。
   * 缺失 / 非对象 → 不启用。
   * 注意:accountId/token 实际持久化到 `~/.zai/weixin/accounts/<accountId>.json`
   * (mode 0600),这里 token 字段只是 mirror,ZAI 启动时 `saveAccount` 会写。
   */
  weixinBot?: {
    enabled?: boolean
    accountId?: string
    token?: string
    baseUrl?: string
    cdnBaseUrl?: string
    dmPolicy?: 'open' | 'allowlist' | 'pairing' | 'disabled'
    groupPolicy?: 'open' | 'allowlist' | 'disabled'
    allowFrom?: string[]
    groupAllowFrom?: string[]
    textBatchDelaySeconds?: number
    textBatchSplitDelaySeconds?: number
    sendChunkDelaySeconds?: number
    sendChunkRetries?: number
    rateLimitCircuitThreshold?: number
    rateLimitCircuitOpenSeconds?: number
  }
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
  workMode: 'code',
  maxVisibleMessages: 20,
  // 默认开启 zai 自身版本自动升级 — 用户在 SettingsDrawer 关闭后
  // 会写入 settings.json,显式覆盖这个默认。
  autoUpdate: true,
}