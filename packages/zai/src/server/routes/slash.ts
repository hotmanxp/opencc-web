import { Router, type IRouter } from 'express'
import { slashList } from '../services/commands/slashList.js'

export const slashRouter: IRouter = Router()

slashRouter.get('/slash', async (_req, res) => {
  const items = await slashList()
  res.json({ items })
})
