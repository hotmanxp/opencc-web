import { TaskCreateTool } from './TaskCreateTool.js'
import { TaskGetTool } from './TaskGetTool.js'
import { TaskListTool } from './TaskListTool.js'
import { TaskUpdateTool } from './TaskUpdateTool.js'

export { TaskCreateTool, TaskGetTool, TaskListTool, TaskUpdateTool }
export const taskTools = [TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool]
