import { Router, type IRouter } from 'express'
import { writeCommandFile, readCommandFile, deleteCommandFile, readCommandList } from '../services/commands/fileStore.js'
import { reloadUserCommands } from '../services/commands/userLoader.js'

export const commandsRouter: IRouter = Router()

async function refreshRegistry(): Promise<void> {
  await reloadUserCommands({ cwd: process.cwd(), dataDir: process.env.ZAI_DATA_DIR ?? '' })
}

commandsRouter.get('/commands', async (_req, res) => {
  res.json({ items: await readCommandList() })
})

commandsRouter.get('/commands/:name', async (req, res) => {
  const file = await readCommandFile(req.params.name)
  if (!file) return res.status(404).json({ error: 'not found' })
  res.json(file)
})

commandsRouter.post('/commands', async (req, res) => {
  const { name, frontmatter = {}, body = '' } = req.body ?? {}
  if (typeof name !== 'string' || !name) return res.status(400).json({ error: 'name required' })
  if (typeof body !== 'string' || !body.trim()) return res.status(400).json({ error: 'body required' })
  try {
    await writeCommandFile(name, frontmatter, body)
    await refreshRegistry()
    res.json({ ok: true, name })
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

commandsRouter.put('/commands/:name', async (req, res) => {
  const { frontmatter = {}, body = '' } = req.body ?? {}
  if (typeof body !== 'string' || !body.trim()) return res.status(400).json({ error: 'body required' })
  try {
    await writeCommandFile(req.params.name, frontmatter, body)
    await refreshRegistry()
    res.json({ ok: true, name: req.params.name })
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

commandsRouter.delete('/commands/:name', async (req, res) => {
  await deleteCommandFile(req.params.name)
  await refreshRegistry()
  res.json({ ok: true })
})