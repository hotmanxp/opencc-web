import { Router, type IRouter, type Request, type Response } from 'express'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveModel } from '../lib/resolveModel.js'
import type { ModelEntry, OutputStyle, Theme, ZaiSettings } from '../../shared/settings.js'
import type { ProviderProfile } from '../../shared/types.js'
import { getDefaultMode } from '../services/permissionMode.js'
import { BUILTIN_PROVIDERS } from '../../shared/builtinProviders.js'
import { profilesToModelEntries } from '../../shared/profileProjection.js'
import {
  isValidAutoUpdate,
  isValidDefaultSplitScreen,
  isValidEnableDynamicWorkflow,
  isValidOutputStyle,
  isValidTheme,
  readZaiSettings,
  resolveAutoUpdate,
  resolveDefaultSplitScreen,
  resolveEnableDynamicWorkflow,
  resolveOutputStyle,
  resolveTheme,
  writeZaiSettings,
} from '../services/zaiSettingsStore.js'

/**
 * Read ~/.zai.json → providerProfiles. Returns empty array when the
 * file is missing or the field is absent. The OpenCC schema rejects
 * unknown fields so the read here is best-effort and untyped.
 */
function readClaudeProviderProfiles(): ProviderProfile[] {
  try {
    const path = join(homedir(), '.zai.json')
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    return Array.isArray(raw?.providerProfiles) ? raw.providerProfiles : []
  } catch {
    return []
  }
}

/**
 * Build the picker-visible ModelEntry list with the following precedence:
 *
 *   1. User-configured `~/.zai/settings.json → models[]` (the user
 *      owns this; nothing auto-overrides their entries).
 *   2. Saved OpenCC `~/.zai.json → providerProfiles` (projected
 *      into ModelEntry rows with capability metadata).
 *   3. System default catalog (BUILTIN_PROVIDERS) so the picker is
 *      never empty on a fresh install.
 *
 * Earlier layers win on alias collision so the user's picks stay sticky.
 */
function buildAvailableModels(settings: ZaiSettings): ModelEntry[] {
  const userEntries = settings.models ?? []
  const seen = new Set(userEntries.map((e) => e.alias))

  const fromSavedProfiles = profilesToModelEntries(readClaudeProviderProfiles())
    .filter((e) => !seen.has(e.alias))
  for (const e of fromSavedProfiles) seen.add(e.alias)

  const fromBuiltins = profilesToModelEntries(BUILTIN_PROVIDERS)
    .filter((e) => !seen.has(e.alias))

  return [...userEntries, ...fromSavedProfiles, ...fromBuiltins]
}

const router: IRouter = Router()

/**
 * GET /api/agent/settings — return the runtime defaults + alias table
 * that the picker UI consumes.
 *
 * `defaultModel` is resolved via the same 5-layer chain as
 * resolveModel() — so the UI's fallback display matches what the
 * server will actually pick at runtime when no session override is set.
 *
 * `models` merges (in order): user settings.models[] → saved
 * providerProfiles → builtin catalog. The picker is never empty even
 * on a fresh install, but user edits are preserved on alias collision.
 *
 * `outputStyle` exposes the persisted transcript rendering preference
 * so the SettingsDrawer can render the right selected row on cold
 * start (no flash of "default" before the GET resolves).
 */
router.get('/agent/settings', async (_req: Request, res: Response) => {
  try {
    const settings = await readZaiSettings()
    const env = settings.env ?? {}
    const { model: defaultModel } = resolveModel({ sessionModel: null, cwd: '' })
    const baseURL = env.ANTHROPIC_BASE_URL ?? null
    const models = buildAvailableModels(settings)
    const outputStyle = resolveOutputStyle(settings)
    const theme = resolveTheme(settings)
    const maxVisibleMessages =
      typeof settings.maxVisibleMessages === 'number'
        ? Math.max(1, Math.min(1000, Math.floor(settings.maxVisibleMessages)))
        : 20
    const defaultSplitScreen = resolveDefaultSplitScreen(settings)
    const enableDynamicWorkflow = resolveEnableDynamicWorkflow(settings)
    const autoUpdate = resolveAutoUpdate(settings)
    res.json({
      defaultModel,
      baseURL,
      models,
      defaultMode: getDefaultMode(),
      outputStyle,
      theme,
      maxVisibleMessages,
      defaultSplitScreen,
      enableDynamicWorkflow,
      autoUpdate,
    })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

/**
 * PUT /api/agent/settings/output-style — persist the web UI's
 * transcript output style. Body is
 * `{ outputStyle: 'default' | 'compact' | 'verbose' }`. The server
 * validates the value and round-trips the existing settings.json
 * (other fields preserved).
 *
 * Used by SettingsDrawer when the user changes the "输出样式" row.
 * Returns the persisted value so the client can echo the canonical
 * form back (in case it sent a typo).
 */
router.put('/agent/settings/output-style', async (req: Request, res: Response) => {
  const candidate = (req.body as { outputStyle?: unknown } | undefined)?.outputStyle
  if (!isValidOutputStyle(candidate)) {
    return res
      .status(400)
      .json({ error: `invalid outputStyle: ${String(candidate)}` })
  }
  try {
    const settings = await readZaiSettings()
    const next: ZaiSettings = { ...settings, outputStyle: candidate as OutputStyle }
    await writeZaiSettings(next)
    res.json({ outputStyle: next.outputStyle })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

/**
 * PUT /api/agent/settings/theme — persist the web UI's theme preference.
 * Body is `{ theme: 'auto' | 'dark' | 'light' | 'high-contrast' }`. The
 * server validates the value and round-trips the existing settings.json
 * (other fields preserved).
 *
 * Used by SettingsDrawer when the user changes the "主题" row.
 * Returns the persisted value so the client echoes back the canonical form.
 */
router.put('/agent/settings/theme', async (req: Request, res: Response) => {
  const candidate = (req.body as { theme?: unknown } | undefined)?.theme
  if (!isValidTheme(candidate)) {
    return res.status(400).json({ error: `invalid theme: ${String(candidate)}` })
  }
  try {
    const settings = await readZaiSettings()
    const next: ZaiSettings = { ...settings, theme: candidate as Theme }
    await writeZaiSettings(next)
    res.json({ theme: next.theme })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

/**
 * PUT /api/agent/settings/max-visible-messages — persist the web UI's
 * "消息最大显示条数" setting. Body is `{ value: number }`.
 * Server clamps to [1, 1000] and floors fractional inputs.
 *
 * Used by SettingsDrawer when the user changes the "消息最大显示条数" row.
 * Returns the persisted value so the client echoes back the canonical form.
 */
router.put(
  '/agent/settings/max-visible-messages',
  async (req: Request, res: Response) => {
    const raw = (req.body as { value?: unknown } | undefined)?.value
    const n = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(n)) {
      return res.status(400).json({ error: `invalid value: ${String(raw)}` })
    }
    const clamped = Math.max(1, Math.min(1000, Math.floor(n)))
    try {
      const settings = await readZaiSettings()
      const next: ZaiSettings = { ...settings, maxVisibleMessages: clamped }
      await writeZaiSettings(next)
      res.json({ value: next.maxVisibleMessages })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  },
)

/**
 * PUT /api/agent/settings/default-split-screen — persist the web UI's
 * "默认启动分屏" setting. Body is `{ value: boolean }`.
 *
 * Used by SettingsDrawer when the user toggles the "默认启动分屏" row.
 * Returns the persisted value so the client echoes back the canonical form.
 *
 * Note: this only seeds the first-run default in localStorage — a user who
 * has already toggled the split-pane manually retains their explicit choice
 * (see SplitPane.tsx first-run seed effect for details).
 */
router.put(
  '/agent/settings/default-split-screen',
  async (req: Request, res: Response) => {
    const raw = (req.body as { value?: unknown } | undefined)?.value
    if (!isValidDefaultSplitScreen(raw)) {
      return res
        .status(400)
        .json({ error: `invalid defaultSplitScreen: ${String(raw)}` })
    }
    try {
      const settings = await readZaiSettings()
      const next: ZaiSettings = { ...settings, defaultSplitScreen: raw }
      await writeZaiSettings(next)
      res.json({ value: next.defaultSplitScreen })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  },
)

/**
 * PUT /api/agent/settings/enable-dynamic-workflow — persist the web UI's
 * "启用动态工作流" toggle. Body is `{ value: boolean }`.
 *
 * Why this lives in zai-server (not vendor's settings pipeline):
 *   - zai controls whether the WorkflowTool gets registered into the
 *     LLM-facing tool pool. Default is OFF (workflows cost dozens of
 *     agents + tokens per run) — the user must opt in.
 *   - The toggle writes the persisted flag AND mutates
 *     `process.env.OPENCC_ENABLE_WORKFLOWS` so vendor's
 *     `isWorkflowsDisabled()` returns false on the very next
 *     `getAllBaseTools()` call. env var mutation is safe — vendor reads
 *     it fresh on every call, and a process restart will read the
 *     persisted settings.json again on boot via
 *     `enableOpenccConfigs → applyZaiWorkflowEnableFromSettings`.
 *
 * Returns the persisted value so the client echoes back the canonical
 * form (true/false, never undefined).
 */
router.put(
  '/agent/settings/enable-dynamic-workflow',
  async (req: Request, res: Response) => {
    const raw = (req.body as { value?: unknown } | undefined)?.value
    if (!isValidEnableDynamicWorkflow(raw)) {
      return res
        .status(400)
        .json({ error: `invalid enableDynamicWorkflow: ${String(raw)}` })
    }
    try {
      const settings = await readZaiSettings()
      const next: ZaiSettings = { ...settings, enableDynamicWorkflow: raw }
      await writeZaiSettings(next)
      // Bridge to vendor's runtime gate. Mirror of the boot-time logic
      // in `enableOpenccConfigs() → applyZaiWorkflowEnableFromSettings()`:
      // mutate `process.env.OPENCC_ENABLE_WORKFLOWS` so the very next
      // `query()` call's `getAllBaseTools()` filters WorkflowTool in/out
      // accordingly. The persisted settings.json is the source of truth;
      // a process restart re-applies this bridge from disk.
      if (raw) {
        process.env.OPENCC_ENABLE_WORKFLOWS = '1'
      } else {
        delete process.env.OPENCC_ENABLE_WORKFLOWS
      }
      res.json({ value: next.enableDynamicWorkflow })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  },
)

/**
 * PUT /api/agent/settings/auto-update — 持久化 zai 自身版本自动升级开关。
 * Body 是 `{ value: boolean }`。
 *
 * 与 enable-dynamic-workflow 的区别:本开关不需要同步写 process.env。
 * `maybeAutoUpdate()` 在每次启动读 settings.json 时已经走了 resolveAutoUpdate
 * (默认 true);运行中的 toggle 只影响"下次启动"的判断 — 用户切到 false 后,
 * 重启 zai 才会跳过 npm view / npm install -g,运行中的进程可能仍在
 * 后台跑完这次的 install。这是 by-design:运行中已发出的 installing
 * 不应被半路取消,免得新版本残留在 npm cache 但未安装。
 *
 * SettingsDrawer 改这一行时调用,返回持久化后的值让客户端 echo canonical。
 */
router.put('/agent/settings/auto-update', async (req: Request, res: Response) => {
  const raw = (req.body as { value?: unknown } | undefined)?.value
  if (!isValidAutoUpdate(raw)) {
    return res.status(400).json({ error: `invalid autoUpdate: ${String(raw)}` })
  }
  try {
    const settings = await readZaiSettings()
    const next: ZaiSettings = { ...settings, autoUpdate: raw }
    await writeZaiSettings(next)
    res.json({ value: next.autoUpdate })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

export default router
