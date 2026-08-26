# 主 Agent 通过 TaskId 调用 TaskOutput（不再暴露 OutputFile）

- 日期：2026-08-09
- 状态：设计稿，待评审
- 范围：`packages/zn-agent-core/src/opencc-src/tasks/LocalAgentTask/LocalAgentTask.tsx` 和 `packages/zn-agent-core/src/opencc-src/tools/AgentTool/AgentTool.tsx`

## 背景与问题

`LocalAgentTask` 完成时通过 `enqueueAgentNotification` 向主 Agent 发送 `TaskNotification`，
当前模板同时暴露 `<TaskId>` 与 `<OutputFile>`，后者是 `tasks/<taskId>.output` 的磁盘路径。

由于 `diskOutput.ts:530-542` 的 `initTaskOutputAsSymlink` 把 `.output` 软链接到了
`getAgentTranscriptPath(agentId)`（完整 JSONL transcript），主 Agent 拿到 `OutputFile`
后直接调用 `Read` 经常碰到两个问题：

1. transcript 文件超出 `Read` 工具的 25000 tokens 上限，导致 `File content (71996 tokens) exceeds maximum allowed tokens`。
2. 即便能读到，主 Agent 拿到的是包含 thinking、tool_use、tool_result 的过程日志，不是子 Agent 的最终结论。

而 `TaskOutputTool` 已经具备正确路径：`getTaskOutputData` 对 `local_agent` 任务会优先返回
`agentTask.result` 中提取的 finalMessage（见 `TaskOutputTool.tsx:93-106`）。

因此修复目标是让主 Agent 在收到通知后只通过 `TaskOutput(task_id)` 取结果，不再走 `Read <taskId>.output`。

## 目标

- `TaskNotification` 不再携带 `<OutputFile>`，只保留 `<TaskId>` 与现有 status/summary/result 字段。
- `AgentTool` 工具描述增加一句明确指引，让主 Agent 使用 `TaskOutput(task_id)`。
- 不修改 `TaskOutputTool` 与 `diskOutput.ts` 的现有行为（软链接保留，仅作 UI 调试使用）。
- 旧会话中已经发出的 `OutputFile` 字段保留原样，不做迁移。

## 设计

### 通知模板调整

`packages/zn-agent-core/src/opencc-src/tasks/LocalAgentTask/LocalAgentTask.tsx`：

- 删除消息模板里的 `<OUTPUT_FILE>` 段落。
- 在 `summary` 之后追加一行明确指引，例如：
  `如需获取任务输出，请使用 TaskOutput 工具并传入 task_id。`
- 保留 `<TaskId>`、`<Status>`、`<Summary>`、`<result>`、`<usage>`、`<tool_use_id>`、`<worktree>` 等字段。
- `import { OUTPUT_FILE_TAG } from '../../constants/xml.js'` 不再被使用，从 import 中删除。

### AgentTool 工具描述

`packages/zn-agent-core/src/opencc-src/tools/AgentTool/AgentTool.tsx`：

- 在工具描述（`description` 字段）末尾追加一行：
  `如需获取子 Agent 输出，使用 TaskOutput(task_id)。不要直接读取任务输出文件。`
- 不调整输入 schema。

### 不修改的部分

- `diskOutput.ts`：`.output` 软链接到 transcript 的逻辑保留，UI 调试仍可读 transcript。
- `TaskOutputTool.tsx`：`getTaskOutputData` 的 finalMessage 优先策略保持。
- `BackgroundTasksDialog`、`ShellDetailDialog`：保留现有 detail 渲染。
- 历史 transcript：旧会话中已经存在的 `<OutputFile>` 字段原样保留，不重写。

## 数据流

```text
子 Agent 完成
  ↓
LocalAgentTask.completeAgentTask() / failAgentTask()
  ↓
enqueueAgentNotification({ taskId, status, summary, finalMessage, ... })
  ↓
通知消息（不再含 OutputFile）：
<TaskNotification>
    <TaskId>...</TaskId>
    <Status>completed|failed|killed</Status>
    <Summary>...</Summary>
    <result>...</result>     // 可选
    <usage>...</usage>       // 可选
    <tool_use_id>...</tool_use_id>
    <worktree>...</worktree>
</TaskNotification>
  ↓
主 Agent 收到通知，遵循工具描述里的指引
  ↓
TaskOutput({ task_id })
  ↓
TaskOutputTool.getTaskOutputData()
  → task.type === 'local_agent'
  → 优先返回 agentTask.result 的 finalMessage
```

## 错误处理

- 通知模板缺字段：保留 `TASK_ID_TAG`，主 Agent 至少能拿到 task_id。
- `TaskOutput` 失败：`retrieval_status` 沿用现有 `'success' | 'timeout' | 'not_ready'`。
- 旧 transcript 重放：原样保留，旧主 Agent 不会在真实 zai 进程里继续运行。

## 测试

- 单元：在 `packages/zn-agent-core/test/unit/tasks/LocalAgentTask.test.ts`
  （若不存在则新增）中验证 `enqueueAgentNotification` 输出不包含 `OUTPUT_FILE_TAG`，
  且包含 TaskOutput 指引字符串。
- 保留：`TaskOutputTool` 的 finalMessage 优先覆盖测试。
- 不修改：`diskOutput.ts` 的软链接测试、`getTaskOutputData` 的覆盖。
- 手工验收（强制项，按 AGENTS.md）：用 `/ego-browser` 启动真实 zai 实例，主 Agent 调用
  Agent 工具后只看到 `<TaskId>`，再调用 `TaskOutput(task_id)` 拿到 finalMessage。

## 兼容性

- 仅修改新发出的通知；旧 transcript 历史字段原样保留。
- `.output` 软链接保留以服务 UI 调试，主 Agent 工具描述收敛使用入口。
- `AgentTool` 描述是软提示，旧主 Agent 即使忽略也不会读不到最终结果（TaskOutput 仍然可用）。

## 影响面

| 文件 | 改动类型 | 风险 |
|------|----------|------|
| `LocalAgentTask.tsx` | 模板字符串 + 1 个 import | 低 |
| `AgentTool.tsx` | 工具 description 追加一行 | 低 |
| 测试文件 | 新增/补一个单测 | 低 |
| AGENTS.md / docs | 无 | - |

无 API 协议变更，无 schema 变更，无 UI 变更。