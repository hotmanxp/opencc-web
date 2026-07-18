// V2 TaskList 只读路由. zai-web 通过 SSE 的 runtime.tool_call 拿到增量
// 写入本地 store, 但首次 / 刷新时需要从磁盘把 ~/.zai/tasks.json 现状拉
// 过来覆盖本地空态. 写操作是 LLM 调 TaskCreate/Update tool, 走
// zai-agent-core 内部通道, 不经过此路由.
//
// 字段映射: server 侧 TaskItem.subject -> client V2TaskItem.subject;
// status 透传; blocks/blockedBy 透传; 不返回 metadata (含 _internal).
//
// 实现说明 (Plan B): 不用 `import { getTaskListStore } from
// '@zn-ai/zai-agent-core/tools/Tasks/TaskListStore.js'`, 因为 zai-agent-core
// 的 package.json `exports` 字段没有把 tools/Tasks 子路径暴露出去, Node 的
// module resolver 会拒绝深路径. 直接读 ~/.zai/tasks.json 即可, 跟
// TaskListStore.list() 内部行为一致 (load → parse → 过滤 deleted +
// _internal), 路由层面补齐相同过滤.

import { Router, type IRouter, type Request, type Response } from 'express'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 与 zai-agent-core TaskListStore 内 TaskItem 字段对齐, 过滤后只返回 client
// 需要的子集. 不引 zod schema, 这层只做形状裁剪, 解析失败 / 字段缺失
// 都不阻断响应 — 缺失字段 fallback 到 undefined, 客户端 V2TaskItem 全
// optional.
type StoredTask = {
  id: string
  subject: string
  description?: string
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  blocks: string[]
  blockedBy: string[]
  owner?: string
  metadata?: Record<string, unknown>
  updatedAt: number
}

/**
 * 读 ~/.zai/tasks.json, parse + 过滤 deleted / _internal, 返回客户端
 * 字段子集. 文件不存在 / JSON 损坏返回空数组 — 这俩是正常路径 (用户
 * 从未调过 TaskCreate tool, 或文件被外部破坏), 不应 5xx.
 */
async function readV2Tasks(): Promise<StoredTask[]> {
  const path = join(homedir(), '.zai', 'tasks.json')
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 损坏 JSON 当空处理: 客户端会显示"无任务"而不是一片红错误. 真要
    // 报警可以走 console.warn; 不上 500 是因为这个端点是"兜底拉取",
    // 失败静默比阻断 UI 体验更好.
    console.warn('[v2Tasks] tasks.json 损坏, 按空列表返回')
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter((t): t is StoredTask => {
    if (!t || typeof t !== 'object') return false
    const task = t as StoredTask
    if (task.status === 'deleted') return false
    if (task.metadata?._internal === true) return false
    return true
  })
}

const router: IRouter = Router()

/**
 * GET /api/agent/sessions/:sid/v2-tasks — 返回当前磁盘上的 V2 TaskList.
 *
 * 路径里的 :sid 当前实现不参与 partition (TaskListStore 是全局单例,
 * 写在 ~/.zai/tasks.json). 保留 :sid 是为了与未来按 session 切片兼容,
 * 前端调用形态统一不必再改.
 */
router.get('/agent/sessions/:sid/v2-tasks', async (_req: Request, res: Response) => {
  try {
    const tasks = await readV2Tasks()
    res.json({ tasks })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

export default router