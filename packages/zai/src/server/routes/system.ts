import { Router, type IRouter } from 'express';
import { getSystemInfo } from '../services/detect.js';

const router: IRouter = Router();

router.get('/system', async (_req, res) => {
  try {
    const info = await getSystemInfo();
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
