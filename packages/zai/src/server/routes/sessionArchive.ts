/**
 * sessionArchive router — 手动触发会话归档。
 *
 * 唯一端点 `POST /api/agent/sessions/archive`：对**本实例 cwd** 对应的
 * project 目录跑一次归档扫描（与 initAgentRuntime 启动时那次同一实现、
 * 同一 in-flight 去重）。设置页「立即归档」按钮调它。
 *
 * 为什么独立成文件而不是塞进 routes/agent.ts：
 *   - agent.ts 已 2300+ 行；
 *   - agent.ts 的测试必须 mock 整个 agentRuntime.js 才能加载模块，而本端点
 *     完全不依赖 runtime —— 独立 router 可以用裸 express + supertest 自包含测试。
 *
 * 永不返回 5xx：sweep 自身吞掉所有异常，没有可归档项时返回 200 + archived: []。
 * 详见 docs/superpowers/specs/2026-09-23-zai-session-archive-design.md §6.2。
 */
import { Router, type IRouter, type Request, type Response } from 'express'
import { sweepSessionArchive } from '../services/sessionArchive.js'

const router: IRouter = Router()

router.post('/agent/sessions/archive', async (req: Request, res: Response) => {
  try {
    const ctx = req.app.locals.instanceContext as { cwd: string; cwdName: string }
    const result = await sweepSessionArchive({ cwd: ctx.cwd })
    res.json(result)
  } catch (err) {
    // sweep 自带 try/catch，理论上到不了这里；兜底不返 5xx。
    console.warn('[sessionArchive] route failed (swallowed):', err)
    res.json({ archived: [], kept: 0, skipped: 0 })
  }
})

export default router
