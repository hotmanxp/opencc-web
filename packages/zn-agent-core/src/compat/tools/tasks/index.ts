import type { Tool } from '../../runtime/modelCaller.js'
import { TaskCreateTool } from './TaskCreateTool.js'
import { TaskGetTool } from './TaskGetTool.js'
import { TaskListTool } from './TaskListTool.js'
import { TaskUpdateTool } from './TaskUpdateTool.js'

export { TaskCreateTool, TaskGetTool, TaskListTool, TaskUpdateTool }

/**
 * 4 个 Task 工具集合。无条件暴露给模型 — 不需要 feature flag,
 * LLM 用它们追踪多步工作进度,等价于替代 vendored opencc 的 TodoWrite 语义。
 * 服务端每次 create/update/list/deleteSession 都会 emit
 * stateChangeBus.emit('v2_task.changed', ...),推到前端 useAgentStore
 * 触发 TodoZone 实时渲染。
 */
export const taskTools: Tool[] = [
  TaskCreateTool,
  TaskGetTool,
  TaskListTool,
  TaskUpdateTool,
]