import { Router, type IRouter, type Request, type Response } from 'express'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Read ~/.zai/settings.json. Returns parsed object or empty object on
 * any failure (missing file, invalid JSON, permission error).
 *
 * Mirrors the same defensive pattern used in modelCaller.ts:52 — the
 * settings file is optional and the server must keep working when it
 * is absent.
 */
function readZaiSettings(): {
  env?: Record<string, string>
  model?: string
} {
  try {
    const path = join(homedir(), '.zai', 'settings.json')
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    // Empty file / invalid JSON is fine — the file is optional, so we
    // fall back to defaults. But for any other error (real IO failure
    // like ENOENT permission denied on a path the user *did* set up),
    // we surface it so the route can return 500.
    if (err instanceof SyntaxError) return {}
    throw err
  }
}

const router: IRouter = Router()

/**
 * GET /api/agent/settings — return the runtime defaults that the server
 * will fall back to when a session's `model` field is "unknown".
 *
 * Priority for defaultModel:
 *   1. env.ANTHROPIC_DEFAULT_SONNET_MODEL
 *   2. env.ANTHROPIC_SMALL_FAST_MODEL
 *   3. top-level settings.model
 *   4. null
 */
router.get('/agent/settings', async (_req: Request, res: Response) => {
  try {
    const settings = readZaiSettings()
    const env = settings.env ?? {}
    const defaultModel =
      env.ANTHROPIC_DEFAULT_SONNET_MODEL
      ?? env.ANTHROPIC_SMALL_FAST_MODEL
      ?? settings.model
      ?? null
    const baseURL = env.ANTHROPIC_BASE_URL ?? null
    res.json({ defaultModel, baseURL })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

export default router