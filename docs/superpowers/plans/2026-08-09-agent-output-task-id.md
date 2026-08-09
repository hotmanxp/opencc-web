# 主 Agent 通过 TaskId 调用 TaskOutput 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `TaskNotification` 中暴露的 `OutputFile` 路径移除，并让 AgentTool 工具描述明确指引主 Agent 通过 `TaskOutput(task_id)` 读取子 Agent 结果。

**Architecture:** 仅修改通知模板字符串与 AgentTool 描述文案；保留 `diskOutput.ts` 的 `.output` 软链接供 UI 调试使用；保留 `TaskOutputTool` 的 finalMessage 优先策略。改动面集中在 zn-agent-core 内两个文件 + 一个新增单测。

**Tech Stack:** TypeScript, vitest, AgentTool/LocalAgentTask 子模块,Anthropic SDK 流式消息协议无关。

## Global Constraints

- 旧会话中已有的 `<OutputFile>` 字段不迁移，原样保留。
- 不修改 `diskOutput.ts` 与 `TaskOutputTool.tsx` 行为。
- 测试粒度按 AGENTS.md：仅跑受影响单测；功能改动完成后禁止 `pnpm -r test`。
- 所有 commit message 必须使用中文。
- 按 TDD 顺序：先写失败测试，再写实现，再运行测试，最后 commit。

## File Structure

| 文件 | 角色 |
|------|------|
| `packages/zn-agent-core/src/opencc-src/tasks/LocalAgentTask/LocalAgentTask.tsx` | `enqueueAgentNotification` 模板调整，删除 `<OUTPUT_FILE>`，追加 TaskOutput 指引 |
| `packages/zn-agent-core/src/opencc-src/tools/AgentTool/AgentTool.tsx` | AgentTool 工具描述末尾追加指引 |
| `packages/zn-agent-core/test/unit/tasks/LocalAgentTask.test.ts` | 新增单测：通知不再含 `OUTPUT_FILE_TAG`，并包含 TaskOutput 指引文本 |

不创建新模块。

---

### Task 1: 通知模板删除 OutputFile 并新增指引

**Files:**
- Modify: `packages/zn-agent-core/src/opencc-src/tasks/LocalAgentTask/LocalAgentTask.tsx:248-258`

**Interfaces:**
- Consumes: 无（修改现成模板字符串）
- Produces: 通知消息字符串去掉 `<OUTPUT_FILE>` 段落；在 summary 之后追加 `Use TaskOutput with task_id to retrieve the final result.` 文本

- [ ] **Step 1: 写失败测试**

打开 `packages/zn-agent-core/test/unit/tasks/LocalAgentTask.test.ts`（若不存在则新建，并按 vitest 默认 pattern `*.test.ts` 校验配置）。

新增测试：

```ts
import { enqueueAgentNotification } from '@zn-ai/zn-agent-core/opencc-src/tasks/LocalAgentTask/LocalAgentTask'
import { enqueuePendingNotification } from '@zn-ai/zn-agent-core/opencc-src/utils/messageQueueManager'

describe('enqueueAgentNotification', () => {
  it('does not include OutputFile tag in TaskNotification payload', () => {
    const calls: Array<{ value: string; mode: string }> = []
    // 替换默认的 enqueuePendingNotification，捕获参数
    const setAppState = jest.fn()
    enqueueAgentNotification({
      taskId: 'a-test-task',
      description: 'demo',
      status: 'completed',
      setAppState,
    })
    // 期望：调用栈里任何 enqueuePendingNotification 调用都不再包含 <output_file>
    // ...实现通过 spy 拦截 enqueuePendingNotification ...
  })
})
```

**注：** 计划中只描述意图。具体 spy 写法以 `LocalAgentTask.tsx` 当前 import 为准，使用模块级 spy 拦截 `enqueuePendingNotification`，读取 `calls[0].value` 并断言不含 `<output_file>`，同时断言包含 `Use TaskOutput with task_id to retrieve the final result.`。

- [ ] **Step 2: 运行测试确认失败**

运行：

```bash
pnpm --filter @zn-ai/zn-agent-core test test/unit/tasks/LocalAgentTask.test.ts
```

期望：失败，提示模板里仍含 `<output_file>` 且缺少 TaskOutput 指引。

- [ ] **Step 3: 修改通知模板**

打开 `packages/zn-agent-core/src/opencc-src/tasks/LocalAgentTask/LocalAgentTask.tsx`，定位：

```ts
const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${summary}</${SUMMARY_TAG}>${resultSection}${usageSection}${worktreeSection}
</${TASK_NOTIFICATION_TAG}>`
```

替换为：

```ts
const guidance = 'Use TaskOutput with task_id to retrieve the final result.'
const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${summary}</${SUMMARY_TAG}>
<${SUMMARY_TAG}>${guidance}</${SUMMARY_TAG}>${resultSection}${usageSection}${worktreeSection}
</${TASK_NOTIFICATION_TAG}>`
```

并删除：

```ts
const outputPath = getTaskOutputPath(taskId)
```

若 `getTaskOutputPath` 不再被该函数使用，从 `import { evictTaskOutput, getTaskOutputPath, initTaskOutputAsSymlink } from '../../utils/task/diskOutput.js';` 中移除 `getTaskOutputPath`（其余调用方仍使用）。同步删除 `import { OUTPUT_FILE_TAG } from '../../constants/xml.js';` 中不再被使用的常量（确认文件其它位置不使用）。

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm --filter @zn-ai/zn-agent-core test test/unit/tasks/LocalAgentTask.test.ts
```

期望：测试通过。

- [ ] **Step 5: 提交**

```bash
git add packages/zn-agent-core/src/opencc-src/tasks/LocalAgentTask/LocalAgentTask.tsx \
        packages/zn-agent-core/test/unit/tasks/LocalAgentTask.test.ts
git commit -m "fix(zn-agent-core): TaskNotification 移除 OutputFile 并指引主 Agent 使用 TaskOutput(task_id)"
```

---

### Task 2: AgentTool 工具描述追加 TaskOutput 指引

**Files:**
- Modify: `packages/zn-agent-core/src/opencc-src/tools/AgentTool/AgentTool.tsx`

**Interfaces:**
- Consumes: 不依赖 Task 1 的具体模板，仅要求工具 description 字符串更新
- Produces: AgentTool 的 `description` 末尾追加一行 `Use TaskOutput(task_id) to retrieve the agent's final result. Do not read task output files directly.`

- [ ] **Step 1: 定位当前 description**

读取 `packages/zn-agent-core/src/opencc-src/tools/AgentTool/AgentTool.tsx`，找到工具 description 字段（通常为 `description: '...'`）。

- [ ] **Step 2: 追加指引**

在 description 字符串末尾（保留原内容）追加：

```text
Use TaskOutput(task_id) to retrieve the agent's final result. Do not read task output files directly.
```

若 description 是模板字符串（反引号），用 `${}` 嵌入；若是普通字符串，直接拼接。

- [ ] **Step 3: 运行 AgentTool 相关单测（若存在）**

```bash
pnpm --filter @zn-ai/zn-agent-core test test/unit/tools/AgentTool
```

期望：现有测试不依赖 description 文本字面值，应该全部通过。如有快照/字符串匹配测试，根据实际失败调整（按需更新快照）。

- [ ] **Step 4: 提交**

```bash
git add packages/zn-agent-core/src/opencc-src/tools/AgentTool/AgentTool.tsx
git commit -m "fix(zn-agent-core): AgentTool 工具描述指引主 Agent 使用 TaskOutput(task_id)"
```

---

### Task 3: 回归检查与手工验收

**Files:**
- 无

- [ ] **Step 1: 运行受影响测试**

```bash
pnpm --filter @zn-ai/zn-agent-core test test/unit/tasks/LocalAgentTask.test.ts test/unit/tools/AgentTool test/unit/tools/TaskOutputTool test/unit/utils/task/diskOutput.test.ts 2>/dev/null
```

期望：所有相关测试通过。如某些路径不存在，按实际目录调整。

- [ ] **Step 2: 类型检查**

```bash
pnpm --filter @zn-ai/zn-agent-core exec tsc --noEmit
```

期望：无错误。

- [ ] **Step 3: 真实浏览器验收**

按 AGENTS.md，使用 `/ego-browser` skill 启动真实 zai 实例。

验证路径：
1. 主 Agent 调用 Agent 工具创建子 Agent。
2. 子 Agent 完成后，聊天面板中只看到 `<TaskId>`、`<Status>`、`<Summary>`、TaskOutput 指引，**不再出现 `<output_file>` 段**。
3. 主 Agent 后续行为是用 `TaskOutput(task_id)` 取结果，不是 `Read <taskId>.output`。
4. 截图保存到工作目录。

- [ ] **Step 4: 若验收失败，回到 Task 1/Task 2 修复后再走 Step 3**

- [ ] **Step 5: 最终提交（若有改动）**

```bash
git status
# 若有未提交改动：
git add <files>
git commit -m "chore(zn-agent-core): 验收后微调"
```

---

## 验收清单

- [ ] TaskNotification 模板不再包含 `<output_file>`。
- [ ] TaskNotification 包含 TaskOutput 指引文本。
- [ ] AgentTool 工具描述末尾包含 TaskOutput 指引。
- [ ] 旧 transcript 中的 `OutputFile` 字段未受影响。
- [ ] `diskOutput.ts` 软链接未变；UI 调试面板仍可读 transcript。
- [ ] `TaskOutputTool` 行为未变。
- [ ] 受影响单测通过，`tsc --noEmit` 无错误。
- [ ] 真实 zai 实例验收通过并截图。

## 兼容性

- 仅修改新发出的通知；旧 transcript 原样保留。
- 主 Agent 即使忽略新指引，TaskOutput 仍然可用，行为不退化。
- 无 API 协议变更，无 schema 变更。