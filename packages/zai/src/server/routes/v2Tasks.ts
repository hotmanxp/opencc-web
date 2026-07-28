// V2 TaskList 只读路由. zai-web 通过 SSE 的 runtime.tool_call 拿到增量
// 写入本地 store, 但首次 / 刷新时需要从磁盘把对应 session 的任务拉
// 过来覆盖本地空态. 写操作是 LLM 调 TaskCreate/Update tool, 走
// zai-agent-core 内部通道, 不经过此路由.
//
// 字段映射: server 侧 TaskItem.subject -> client V2TaskItem.subject;
// status 透传; blocks/blockedBy 透传; 不返回 metadata (含 _internal)
// + 不返回 sessionId (client 已知, 冗余).
//
// 历史: 早期实现直接读 ~/.zai/tasks.json; 自从给 TaskListStore 加
// session 隔离后, 实际存储变为 <root>/tasks/<sessionId>.json. 这里改走
// getTaskListStore().list(sid) 拿到按 session 过滤的列表, 与 TaskList
// tool 的内部读取路径一致.

import { Router, type IRouter, type Request, type Response } from 'express'
import { getTaskListStore } from '@zn-ai/zai-agent-core/taskListStore'

const router: IRouter = Router()

/**
 * GET /api/agent/sessions/:sid/v2-tasks — 返回指定 session 的 V2 TaskList.
 *
 * :sid 来自 URL path, 作为 TaskListStore 的 session 隔离 key. 任务列表只
 * 包含属于该 sid 的条目 (TaskListStore.list 内部按 sessionId 过滤).
 */
router.get('/agent/sessions/:sid/v2-tasks', async (req: Request, res: Response) => {
  const sid = req.params.sid
  if (!sid) {
    return res.status(400).json({ error: 'sid is required' })
  }
  try {
    const tasks = await getTaskListStore().list(sid)
    // 裁剪到 client V2TaskItem 字段 (去除 metadata/sessionId)
    const trimmed = tasks.map((t) => ({
      id: t.id,
      subject: t.subject,
      description: t.description,
      activeForm: t.activeForm,
      status: t.status,
      blocks: t.blocks,
      blockedBy: t.blockedBy,
      owner: t.owner,
      updatedAt: t.updatedAt,
    }))
    res.json({ tasks: trimmed })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

export default router