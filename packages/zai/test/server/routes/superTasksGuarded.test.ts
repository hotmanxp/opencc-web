import { describe, expect, test, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'

/**
 * R2-c:superTasks 16 个路由上的 `guarded()` 是否真的把 async rejection 变成
 * 500 —— 而不是像修复前那样冒泡成 unhandledRejection(Express 4 不转发
 * async handler 的 rejected promise,结果是请求永久挂死 + 整进程被带走)。
 *
 * 用真 router + 真 express app,不 mock superTest 的行为。
 */
vi.mock('@zn-ai/zn-agent-core', async (importOriginal) => ({
  // 只替换 task 工厂那几个函数,其余(registerExtraReminderProvider 等)
  // 走真实实现 —— 整包 mock 会因为漏掉某个传递依赖的 export 直接炸。
  ...(await importOriginal<Record<string, unknown>>()),
  getTasksSnapshot: vi.fn(),
  getTaskSummary: vi.fn(),
  getTaskDetails: vi.fn(),
  deleteTasks: vi.fn(),
  moveTask: vi.fn(),
  markTaskStatus: vi.fn(),
  checkTaskIntakeDocs: vi.fn(),
  getSubagentRegistry: vi.fn(() => ({ list: () => [] })),
}))
vi.mock('../../../src/server/services/taskFactoryBridge.js', () => ({
  getTaskFactoryState: vi.fn(() => ({ managedEnabled: false, supervisorSessionId: null })),
  setTaskFactoryState: vi.fn(),
  injectSupervisorCommand: vi.fn(),
  buildTaskCommand: vi.fn(() => ''),
}))

const { getTasksSnapshot } = await import('@zn-ai/zn-agent-core')
const router = (await import('../../../src/server/routes/superTasks.js')).default

// 兜底:万一有漏网的 rejection,别让它真的杀掉整个 vitest 进程
const rejections: unknown[] = []
process.on('unhandledRejection', (r) => rejections.push(r))

let server: import('node:http').Server
let port: number

beforeEach(async () => {
  vi.mocked(getTasksSnapshot).mockReset()
  const app = express()
  app.use(express.json())
  app.use('/api', router)
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  port = (server.address() as { port: number }).port
  rejections.length = 0
})

afterAll(() => {
  process.off('unhandledRejection', () => {})
})

describe('superTasks guarded():async rejection → 500', () => {
  test('核心层抛错(ENOSPC/EACCES 那类)→ 返回 500,不是挂死', async () => {
    vi.mocked(getTasksSnapshot).mockRejectedValue(new Error('ENOSPC: no space left on device'))

    const res = await fetch(`http://127.0.0.1:${port}/api/super-tasks`)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain('ENOSPC')
    // 关键:没有冒泡成 unhandledRejection
    await new Promise((r) => setTimeout(r, 50))
    expect(rejections).toEqual([])
  })

  test('抛错的响应仍然是合法 JSON(前端不会收到 HTML 错误页)', async () => {
    vi.mocked(getTasksSnapshot).mockRejectedValue(new Error('boom'))
    const res = await fetch(`http://127.0.0.1:${port}/api/super-tasks`)
    expect(res.headers.get('content-type')).toContain('application/json')
    await expect(res.json()).resolves.toHaveProperty('error')
  })

  test('正常路径不受影响(没抛错时行为不变)', async () => {
    vi.mocked(getTasksSnapshot).mockResolvedValue({
      fingerprint: 'fp1',
      buckets: { queue: [], processing: [], verifying: [], finished: [] },
    } as never)
    const res = await fetch(`http://127.0.0.1:${port}/api/super-tasks`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.modified).toBe(true)
    expect(body.hash).toContain('fp1')
  })

  test('带已有 try/catch 的路由仍保留自己的状态码映射(409/404)', async () => {
    const { deleteTasks } = await import('@zn-ai/zn-agent-core')
    vi.mocked(deleteTasks).mockRejectedValue(new Error('task is processing'))

    const res = await fetch(`http://127.0.0.1:${port}/api/super-tasks`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['t1'] }),
    })
    // 内层 catch 映射成 409,不该被 guarded 抢成 500
    expect(res.status).toBe(409)
    await new Promise((r) => setTimeout(r, 50))
    expect(rejections).toEqual([])
  })
})
