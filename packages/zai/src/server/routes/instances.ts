import { Router, type IRouter } from 'express'
import { existsSync, statSync } from 'node:fs'
import { getInstanceSupervisor, CURRENT_INSTANCE_ID } from '../services/instanceSupervisor.js'

const router: IRouter = Router()

function notFound(res: import('express').Response, msg: string): void {
  res.status(404).json({ error: msg })
}

function badRequest(res: import('express').Response, msg: string): void {
  res.status(400).json({ error: msg })
}

function handleError(res: import('express').Response, err: unknown): void {
  const code = (err as { code?: string } | null)?.code
  if (code === 'NOT_FOUND') {
    notFound(res, err instanceof Error ? err.message : 'not found')
    return
  }
  if (code === 'CURRENT_INSTANCE') {
    badRequest(res, err instanceof Error ? err.message : 'cannot operate on current instance')
    return
  }
  if (code === 'DUPLICATE_NAME') {
    res.status(409).json({ error: err instanceof Error ? err.message : 'duplicate' })
    return
  }
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
}

router.get('/instances', (_req, res) => {
  res.json({ instances: getInstanceSupervisor().getSnapshots() })
})

router.get('/instances/:id', (req, res) => {
  const snap = getInstanceSupervisor().getSnapshots().find((s) => s.id === req.params.id)
  if (!snap) return notFound(res, `instance ${req.params.id} not found`)
  res.json({ instance: snap })
})

router.post('/instances', async (req, res) => {
  const { name, cwd } = (req.body ?? {}) as { name?: unknown; cwd?: unknown }
  if (typeof name !== 'string' || name.trim() === '') return badRequest(res, 'name is required')
  if (typeof cwd !== 'string' || cwd.trim() === '') return badRequest(res, 'cwd is required')
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return badRequest(res, 'cwd must be an existing directory')
  }
  try {
    const instance = await getInstanceSupervisor().createInstance({ name: name.trim(), cwd })
    res.status(201).json({ instance })
  } catch (err) {
    handleError(res, err)
  }
})

router.post('/instances/:id/start', async (req, res) => {
  if (req.params.id === CURRENT_INSTANCE_ID) return badRequest(res, 'cannot start current instance')
  try {
    const instance = await getInstanceSupervisor().startInstance(req.params.id)
    res.json({ instance })
  } catch (err) {
    handleError(res, err)
  }
})

router.post('/instances/:id/stop', async (req, res) => {
  if (req.params.id === CURRENT_INSTANCE_ID) return badRequest(res, 'cannot stop current instance')
  try {
    const instance = await getInstanceSupervisor().stopInstance(req.params.id)
    res.json({ instance })
  } catch (err) {
    handleError(res, err)
  }
})

router.post('/instances/:id/restart', async (req, res) => {
  if (req.params.id === CURRENT_INSTANCE_ID) return badRequest(res, 'cannot restart current instance')
  try {
    const instance = await getInstanceSupervisor().restartInstance(req.params.id)
    res.json({ instance })
  } catch (err) {
    handleError(res, err)
  }
})

router.delete('/instances/:id', async (req, res) => {
  if (req.params.id === CURRENT_INSTANCE_ID) return badRequest(res, 'cannot delete current instance')
  try {
    await getInstanceSupervisor().removeInstance(req.params.id)
    res.status(204).end()
  } catch (err) {
    handleError(res, err)
  }
})

export default router
