import type { Task, TaskType } from './Task.js'
import { DreamTask } from './tasks/DreamTask/DreamTask.js'
import { LocalAgentTask } from './tasks/LocalAgentTask/LocalAgentTask.js'
import { LocalShellTask } from './tasks/LocalShellTask/LocalShellTask.js'
import { LocalWorkflowTask } from './tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { MonitorMcpTask } from './tasks/MonitorMcpTask/MonitorMcpTask.js'
import { RemoteAgentTask } from './tasks/RemoteAgentTask/RemoteAgentTask.js'

/**
 * zai patch (2026-10-12, mods 同步):`MonitorMcpTask` 原是本文件里唯一一处
 * `require(...)`,而且是**无条件**的(没有 feature gate)。其余五个 task 都是
 * 静态 import,唯独它不是 —— 这个不一致没有理由,只是 upstream 的历史形状。
 *
 * 为什么必须改:opencc 跑在 Bun 上,Bun 的 require 能把 `./X.js` 解析到磁盘上的
 * `X.tsx`;vitest 下同一个 require 会落到 Node 原生 CJS resolver —— 它既不做
 * `.js`→`.ts` 替换,也看不见 Vite 的 alias —— 于是任何 import 图走到 tasks.ts
 * 的测试都会以
 * `Cannot find module './tasks/MonitorMcpTask/MonitorMcpTask.js'` 整文件挂掉,
 * 连第一条断言都跑不到。
 *
 * 因为本来就没有 gate,改成静态 import **不改变任何求值时机**,只是换了谁来
 * 解析它(以及由 esbuild 编译,而不是 Node 逐字读)。同文件其余五行已是这个形状。
 *
 * 对比:`services/mcp/client.ts` 里那几处 require **不能**这样改 —— 它们是
 * 有意 lazy 的(注释写明 "the bundle shouldn't carry when Computer Use is off"),
 * 改成静态 import 会把可选功能的代码无条件塞进 bundle。它们的正确处理是让
 * feature gate 在测试里保持关闭,见
 * `src/compat/runtime/test-settings-isolation.mjs`。
 *
 * 改完仍须验 `node -e "import('./dist/opencc-core.mjs')"` —— 新增顶层 import 是
 * 本仓库 bundle 循环依赖的已知触发方式。
 */
const MONITOR_MCP_TASK: Task | null = MonitorMcpTask

/**
 * Get all tasks.
 * Mirrors the pattern from tools.ts
 * Note: Returns array inline to avoid circular dependency issues with top-level const
 */
export function getAllTasks(): Task[] {
  const tasks: Task[] = [
    LocalShellTask,
    LocalAgentTask,
    RemoteAgentTask,
    DreamTask,
  ]
  if (LocalWorkflowTask) tasks.push(LocalWorkflowTask as unknown as Task)
  if (MONITOR_MCP_TASK) tasks.push(MONITOR_MCP_TASK)
  return tasks
}

/**
 * Get a task by its type.
 */
export function getTaskByType(type: TaskType): Task | undefined {
  return getAllTasks().find(t => t.type === type)
}
