import { Router, type IRouter, type Request, type Response } from 'express'
import { z } from 'zod'
import { getRuntime } from '../services/agentRuntime.js'

const IdBody = z.object({ id: z.string().min(1) })

function runtimeOr503(res: Response) {
  try {
    const r = getRuntime()
    if (!r) {
      res.status(503).json({ error: 'agent runtime not ready' })
      return null
    }
    return r
  } catch {
    res.status(503).json({ error: 'agent runtime not ready' })
    return null
  }
}

function parseBody<T>(schema: z.ZodSchema<T>, req: Request, res: Response): T | null {
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
    return null
  }
  return parsed.data
}

export const pluginsRouter: IRouter = Router()

pluginsRouter.get('/', async (_req, res) => {
  const r = runtimeOr503(res)
  if (!r) return
  const result = await r.plugins.listInstalled()
  res.json(result)
})

pluginsRouter.get('/available', async (_req, res) => {
  const r = runtimeOr503(res)
  if (!r) return
  const list = await r.plugins.listAvailable()
  res.json({ plugins: list })
})

pluginsRouter.post('/enable', async (req, res) => {
  const r = runtimeOr503(res)
  if (!r) return
  const body = parseBody(IdBody, req, res)
  if (!body) return
  const result = await r.plugins.setEnabled(body.id, true)
  res.json(result)
})

pluginsRouter.post('/disable', async (req, res) => {
  const r = runtimeOr503(res)
  if (!r) return
  const body = parseBody(IdBody, req, res)
  if (!body) return
  const result = await r.plugins.setEnabled(body.id, false)
  res.json(result)
})

pluginsRouter.post('/install', async (req, res) => {
  const r = runtimeOr503(res)
  if (!r) return
  const body = parseBody(IdBody, req, res)
  if (!body) return
  const result = await r.plugins.install(body.id)
  res.json(result)
})

pluginsRouter.post('/uninstall', async (req, res) => {
  const r = runtimeOr503(res)
  if (!r) return
  const body = parseBody(IdBody, req, res)
  if (!body) return
  const result = await r.plugins.uninstall(body.id)
  res.json(result)
})

pluginsRouter.post('/update', async (req, res) => {
  const r = runtimeOr503(res)
  if (!r) return
  const body = parseBody(IdBody, req, res)
  if (!body) return
  const result = await r.plugins.update(body.id)
  res.json(result)
})

pluginsRouter.post('/reload', async (_req, res) => {
  const r = runtimeOr503(res)
  if (!r) return
  const result = await r.plugins.reload()
  res.json(result)
})

export default pluginsRouter