import { Router, type IRouter, type Request, type Response } from 'express'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveModel } from '../lib/resolveModel.js'
import type { ModelEntry, OutputStyle, ZaiSettings } from '../../shared/settings.js'
import type { ProviderProfile } from '../../shared/types.js'
import { getDefaultMode } from '../services/permissionMode.js'
import { BUILTIN_PROVIDERS } from '../../shared/builtinProviders.js'
import {
  isValidOutputStyle,
  readZaiSettings,
  resolveOutputStyle,
  writeZaiSettings,
} from '../services/zaiSettingsStore.js'

/**
 * Read ~/.claude.json → providerProfiles. Returns empty array when the
 * file is missing or the field is absent. The OpenCC schema rejects
 * unknown fields so the read here is best-effort and untyped.
 */
function readClaudeProviderProfiles(): ProviderProfile[] {
  try {
    const path = join(homedir(), '.claude.json')
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    return Array.isArray(raw?.providerProfiles) ? raw.providerProfiles : []
  } catch {
    return []
  }
}

/**
 * Project a list of provider profiles onto a flat ModelEntry table for
 * the picker. Each comma-separated model in profile.model becomes one
 * ModelEntry whose alias encodes the provider name (e.g. `nova-m3`).
 *
 * Capabilities come from profile.capabilities[<model>] when the user
 * has saved per-model metadata; otherwise undefined and the picker
 * renders without capability badges.
 */
function profilesToModelEntries(profiles: ProviderProfile[]): ModelEntry[] {
  const out: ModelEntry[] = []
  for (const p of profiles) {
    if (!p.model) continue
    const models = p.model.split(',').map((m) => m.trim()).filter(Boolean)
    // profile.id is the canonical namespace; older saved profiles may
    // lack it but the name is unique enough to disambiguate in the
    // picker when no id is present.
    const profileKey = p.id ?? slugifyProfileName(p.name)
    for (const model of models) {
      out.push({
        alias: `${profileKey}-${slugifyModelName(model)}`,
        model,
        label: model,
        description: p.name,
        baseUrl: p.baseUrl,
        capabilities: p.capabilities?.[model],
      })
    }
  }
  return out
}

function slugifyProfileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile'
}

function slugifyModelName(model: string): string {
  return model.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'model'
}

/**
 * Build the picker-visible ModelEntry list with the following precedence:
 *
 *   1. User-configured `~/.zai/settings.json → models[]` (the user
 *      owns this; nothing auto-overrides their entries).
 *   2. Saved OpenCC `~/.claude.json → providerProfiles` (projected
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
    res.json({
      defaultModel,
      baseURL,
      models,
      defaultMode: getDefaultMode(),
      outputStyle,
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

export default router
