import { Router, type IRouter, type Request, type Response } from 'express'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveModel } from '../lib/resolveModel.js'
import type { ModelEntry } from '../../shared/settings.js'

/**
 * Read ~/.zai/settings.json. Returns parsed object or empty object on
 * any failure (missing file, invalid JSON, permission error).
 *
 * Mirrors the same defensive pattern used in resolveModel.ts — the
 * settings file is optional and the server must keep working when it
 * is absent.
 */
function readZaiSettings(): {
  env?: Record<string, string>
  model?: string
  models?: ModelEntry[]
} {
  try {
    const path = join(homedir(), '.zai', 'settings.json')
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    // Empty file / invalid JSON is fine — fall back to defaults.
    // Real IO errors are surfaced so the route can return 500.
    if (err instanceof SyntaxError) return {}
    throw err
  }
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
 * `models` is the alias table straight from settings.json — empty
 * array when unset (the picker shows "未配置 models[]" in that case).
 */
router.get('/agent/settings', async (_req: Request, res: Response) => {
  try {
    const settings = readZaiSettings()
    const env = settings.env ?? {}
    const { model: defaultModel } = resolveModel({ sessionModel: null, cwd: '' })
    const baseURL = env.ANTHROPIC_BASE_URL ?? null
    const models = settings.models ?? []
    res.json({ defaultModel, baseURL, models })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

export default router
