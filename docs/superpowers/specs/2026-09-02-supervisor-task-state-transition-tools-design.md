# 任务调度官 Agent 任务状态扭转工具集

## 目标

为 Task Factory 的 `task-factory` 任务调度官 Agent 增加专用的状态扭转工具集,使其能通过调用工具(而非手动 Edit `index.md`)完整闭环任务的生命周期扭转:`dispatch` (queue→processing)、`resume` (verifying→processing 复位)、`pause` (processing/verifying→paused)、以及 `Move` 任意桶扭转(覆盖 `Verify` 与 `MarkDone` 的现有职责)。

## 背景与现状

`packages/zn-agent-core/src/opencc-src/server/mainAgents-taskFactory.ts` 当前的任务调度官 system prompt 在三个关键节点只给了「指令性描述」而没有可用工具,任务调度官要么手动 Edit `index.md`、要么「忘记」执行:

| 节点 | 当前 prompt 描述 | 缺失的工具动作 |
|------|------------------|---------------|
| Dispatch (step 3) | "SpawnAgent the executor ... After a successful dispatch, backfill the executorTaskId field in index.md" | **没有**把任务从 `queue-tasks/` 移到 `processing-tasks/`、没有把 `status: queued` 改为 `processing` |
| Resume (step 4 FAIL round<3) | "通过 resume 通道(原 executor session 续接 / 重新派发)让 executor 改" | **没有**把任务从 `verifying-tasks/` 移回 `processing-tasks/`、没有把 `status` 重置为 `processing` |
| Pause (step 4 FAIL round==3) | "调 `markTaskStatus(taskId, processing-tasks, status=paused)` 并向用户发通知" | `markTaskStatus` 是 core 函数,**不是工具**,任务调度官根本调不到 |

任务调度官 agent 现有 3 个 SuperTasks 工具:`SuperTasksCreate` / `SuperTasksVerify` / `SuperTasksMarkDone`。其中 Verify 与 MarkDone 各自封装了一次 `moveTask` + 副作用(Verify 还写 `docs/verification.md` 头段),语义偏业务而非「状态扭转」本身。

## 验收标准

1. **新工具齐备**(`packages/zn-agent-core/src/opencc-src/server/taskFactoryTools.ts`):
   - `SuperTasksMove(id, from, to, executorTaskId?)`:任意合法桶间扭转;可选一并写入 `executorTaskId`。
   - `SuperTasksReset(id)`:自动探测 `verifying-tasks` 或 `processing-tasks`(paused)并重置回 `processing-tasks/status=processing/executorTaskId=null`。
   - `SuperTasksPause(id)`:自动探测 `processing-tasks` 或 `verifying-tasks` 并设 `status=paused`、`executorTaskId=null`(桶不变)。
   - 全部工具实现 `mapToolResultToToolResultBlockParam` / `renderToolUseMessage` / `renderToolResultMessage` / `toAutoClassifierInput` / `checkPermissions` boilerplate,与现有工具一致;`description` 与 `prompt` 字段全部英文。
2. **删除现有工具**:从 `taskFactoryTools.ts` 删除 `superTasksVerifyTool` 与 `superTasksMarkDoneTool`,从 `mainAgents-taskFactory.ts` 的 tools 槽移除两者的 import。
3. **任务调度官 prompt 重写**(`mainAgents-taskFactory.ts` 的 `TASK_FACTORY_SYSTEM_PROMPT` step 3-6):
   - step 3 dispatch:SpawnAgent → 拿到 subagent task id → **一次**调 `SuperTasksMove(id, 'queue-tasks', 'processing-tasks', executorTaskId=...)`;不再要求任务调度官 Edit `index.md`。
   - step 4 verify:读 `process.md` 确认 `[DONE]` → 调 `Move(processing → verifying)` → SpawnAgent **独立** verifier subagent → verifier 自写 `## 轮次 N` 头段 + `结论:` 一行 → 任务调度官读 `verification.md` 决策:PASS → `Move(verifying → finished)`;FAIL round<3 → `Reset` + re-SpawnAgent executor;FAIL round==3 → `Pause` + 通知用户。
   - step 5 forced accept:`Move(verifying → finished)`。
   - step 6 system commands:dispatch / resume / accept / pause 全部用新工具名替代原 `markTaskStatus` / `moveTask` 直调描述。
4. **API 路由零改动**:`packages/zai/src/server/routes/superTasks.ts` 仍调用 core 函数 `moveTask` / `markTaskStatus` 直做后端语义(手工 start / pause / accept / delete),与任务调度官 agent 工具层解耦。
5. **taskFactoryManagedLoop 零改动**:5s tick 仍按「队列非空即注入 dispatch」运行,任务调度官用新工具处理收到的指令。
6. **测试覆盖**:`packages/zn-agent-core/test/server/taskFactoryTools-{move,reset,pause}.test.ts` 单测矩阵覆盖;in-flight `tf-c1tnq4yy`(verifying 桶新增)任务不被打断。
7. **端到端验收**:ego-browser 跑通任务调度官流程 — 创建小任务 → dispatch → 执行子任务完成 → 任务调度官 SpawnAgent verifier → PASS → Move 到 finished;截图与四桶状态取证。

## 关键决策与理由

| 决策 | 理由 |
|------|------|
| 三个工具(`Move` / `Reset` / `Pause`)而非一个万能 `Transition` | 每个工具语义明确;任务调度官按业务场景选(Reset 是验证 FAIL 重做的专门操作,Pause 是任何在飞任务的冻结操作),不必每次想 from/to 状态机 |
| 删除 `Verify` / `MarkDone` 而非保留 | 任务调度官真正需要的是「移动+改状态」语义;`verification.md` 头段写入下放给 verifier subagent(它最清楚当前轮数),`MarkDone` 是 `Move` 的特例 |
| `Reset` 只接受 `id`(自动探测桶) | 任务调度官在 resume 时不关心任务当前在 `verifying` 还是 `processing`(paused);工具统一处理两种合法情况,任务调度官只需传 id |
| `Move` 显式接受 `from` | 任务调度官在 dispatch / verify / accept 时**已知**当前桶(`queue-tasks` / `processing-tasks` / `verifying-tasks`);显式参数便于校验 `from` 桶存在 + 防止误移 |
| `executorTaskId` 合并到 `Move` | 任务调度官 SpawnAgent 后只有一次工具调用写状态,避免「先 Move 再 Edit」的 race;frontmatter 与文件夹移动在工具内部紧邻执行 |
| 验证子任务自写 `## 轮次 N` 头段 | 任务调度官 prompt 简化(不背轮数计算逻辑);轮数计算封装在 verifier 子任务上下文内;verifier 拥有写 verification.md 的完整所有权 |
| `Pause` 不动桶位置 | 用户在「暂停」后仍可能人工决定继续/强制通过,保留 verifying 桶语义;桶切换留给 `Reset` 或显式 `Move` |
| `Pause` 不主动 kill 执行子任务 | 任务调度官在调 `Pause` 前应自己 `BackgroundRuntime.cancel(executorTaskId)`;`Pause` 只做状态写入,职责单一 |

## 工具详细设计

### `SuperTasksMove`

**输入 schema**(zod):

```ts
{
  id: string.min(4),                       // 任务 id,例如 tf-a1b2c3d4
  from: enum(['queue-tasks','processing-tasks','verifying-tasks','finished-tasks']),
  to: enum(['queue-tasks','processing-tasks','verifying-tasks','finished-tasks']),
  executorTaskId: string.optional(),       // 一并写入 index.md frontmatter(可选)
}
```

**行为**:

1. `getTaskSummary(id, from)` 校验任务在 `from` 桶;不存在 → 抛 `task ${id} not found in ${from}`。
2. `existsSync(taskDir(to, id))` 校验目标桶无同名;已存在 → 抛 `task ${id} already exists in ${to}`。
3. 若 `executorTaskId` 非空 → `markTaskStatus(from, { executorTaskId })`(原地写 frontmatter)。
4. `moveTask(id, from, to)`(内部已根据目标桶设 status=processing/verifying/done)。
5. `emitTaskFactoryEvent('moved', { id, from, to })`。
6. 返回文本:`Task moved: ${id} (${title}) ${from} → ${to}${executorTaskId ? ` (executorTaskId=${executorTaskId})` : ''}`。

**典型调用组合**:

- Dispatch:`Move(id, 'queue-tasks', 'processing-tasks', executorTaskId=<subTaskId>)`
- Verify:`Move(id, 'processing-tasks', 'verifying-tasks')`
- PASS / forced accept:`Move(id, 'verifying-tasks', 'finished-tasks')` 或 `Move(id, 'processing-tasks', 'finished-tasks')`
- 强制回滚:`Move(id, 'processing-tasks', 'queue-tasks')`(极少见,任务调度官 SpawnAgent 失败时回滚)

### `SuperTasksReset`

**输入 schema**:`{ id: string.min(4) }`

**行为**(自动探测当前桶):

1. 并行查 4 桶位置(`getTaskSummary(id, <bucket>)` × 4)。
2. **verifying-tasks**:`moveTask(verifying → processing)` + `markTaskStatus(... status='processing', executorTaskId=null)` + `emitTaskFactoryEvent('reset', { id })`。
3. **processing-tasks 且 status=paused**:`markTaskStatus(... status='processing', executorTaskId=null)`(桶内原地) + emit `reset`。
4. **其他位置**(queue-tasks / finished-tasks / processing status≠paused / 不存在):抛 `task ${id} cannot be reset (current state: bucket=${bucket}, status=${status})`。
5. 返回文本:`Task reset: ${id} (${title}) → processing-tasks/status=processing (executorTaskId cleared)`。

**用途**:验证 FAIL 后让 executor 重做时,任务调度官调一次 Reset 把任务重置回可执行态。

### `SuperTasksPause`

**输入 schema**:`{ id: string.min(4) }`

**行为**(自动探测当前桶):

1. 并行查 4 桶位置。
2. **processing-tasks**:`markTaskStatus(... status='paused', executorTaskId=null)` + emit `paused`(桶不变,留在 processing-tasks)。
3. **verifying-tasks**:`markTaskStatus(... status='paused', executorTaskId=null)`(留在 verifying-tasks,允许用户后续强制通过) + emit `paused`。
4. **其他位置**(queue-tasks / finished-tasks / 不存在):抛 `task ${id} cannot be paused (current state: bucket=${bucket}, status=${status})`。
5. 返回文本:`Task paused: ${id} (${title}) in ${bucket} (executorTaskId cleared)`。

**注意**:`Pause` 只做状态写入;任务调度官应**自己**先 `BackgroundRuntime.cancel(executorTaskId)` 再调 Pause(职责单一,与现有 `routes/superTasks.ts:121-138` 路由语义对齐 — 路由先 cancel 再 markTaskStatus)。

## 任务调度官 prompt 重写(step 3-6 完整英文版)

`TASK_FACTORY_SYSTEM_PROMPT` 的 step 3 / 4 / 5 / 6 替换为以下内容(其它 step 1 / 2 不动):

```
3. Dispatch execution:
   a. Read <task_dir>/index.md to extract `agent`, `cwd`, and `verifierAgent` (optional).
   b. SpawnAgent the executor (subagent_type=<agent>, cwd=<cwd>, prompt=full spec + plan + ...).
      When delegating via AgentTool, set transcriptSubdir to the absolute path of the task directory.
   c. After SpawnAgent returns the subagent task id, IMMEDIATELY call:
        SuperTasksMove(id, from='queue-tasks', to='processing-tasks', executorTaskId=<subTaskId>)
      to atomically (i) move the folder, (ii) set status=processing, (iii) backfill executorTaskId.
      Do NOT edit index.md by hand — Move is the only allowed write path for task state.
      If Move fails, cancel the SpawnAgent subagent via BackgroundRuntime.cancel and report failure.

4. Verify (after executor subagent <task-notification>):
   a. Read <task_dir>/process.md; confirm the "## [DONE]" marker is appended. If missing,
      the executor did not finish — wait, re-poll, or escalate to the user.
   b. Call SuperTasksMove(id, from='processing-tasks', to='verifying-tasks') to enter the
      verifying lane. No additional tools are needed — Move returns the task in the new bucket.
   c. SpawnAgent an INDEPENDENT verifier subagent (subagent_type=<verifierAgent>, cwd=<cwd>,
      transcriptSubdir=<task_dir>) with a prompt instructing it to:
        - Read <task_dir>/docs/spec.md (acceptance criteria) and process.md (executor record).
        - Compute round N = (count of existing "## 轮次 N" sections in verification.md) + 1.
        - Append to <task_dir>/docs/verification.md:
            ## 轮次 N
            - 时间戳: <ISO timestamp>
            - 验证目标: <task title>
            - 验证 agent: <verifierAgent>
            <blank line>
            结论: PASS|FAIL
            原因: <one paragraph justification>
        - Reply with the conclusion line.
      The verifier subagent owns writing the verification.md round header; do NOT pre-write
      the header in the supervisor session.
   d. After verifier <task-notification>:
      - Read <task_dir>/docs/verification.md; locate the most recent "## 轮次 N" section.
      - Parse the "结论: " line into PASS or FAIL.
      - PASS → SuperTasksMove(id, from='verifying-tasks', to='finished-tasks').
      - FAIL, round < 3 → SuperTasksReset(id) (moves verifying→processing, status=processing,
        executorTaskId=null). Then re-SpawnAgent the executor with a prompt that includes
        "<task_dir>/docs/verification.md" so the executor reads the feedback before continuing.
      - FAIL, round == 3 → BackgroundRuntime.cancel(executorTaskId) if still alive, then
        SuperTasksPause(id). Emit a <task-notification> to the user describing the situation
        and awaiting human decision.

5. Forced accept (UI "强制通过" button on the verifying lane):
   On <task-command action="forced-accept"> for a task in verifying-tasks, immediately call
   SuperTasksMove(id, from='verifying-tasks', to='finished-tasks') — the verifier is bypassed.
   Do NOT re-SpawnAgent the verifier.

6. System commands (<task-command action="..."> injected by taskFactoryManagedLoop / manual UI):
   - dispatch: SpawnAgent executor + SuperTasksMove(queue-tasks → processing-tasks,
     executorTaskId=<subTaskId>). Multiple queued tasks may be dispatched at once.
   - resume: SuperTasksReset(id) + re-SpawnAgent the executor (or continue the original session).
   - accept: SuperTasksMove(id, from='processing-tasks'|'verifying-tasks', to='finished-tasks').
   - pause: BackgroundRuntime.cancel(executorTaskId) if alive + SuperTasksPause(id).

Dispatch at most one executor subagent per task at a time; different tasks may run in parallel —
when receiving a dispatch command, dispatch in queue order (multiple tasks may run concurrently;
do not force waiting for a previous task to finish before dispatching the next).
```

## 数据流与边界

```
                         SpawnAgent(task-factory 任务调度官对话)
                                  │
                                  ▼
   ┌────────────────────────────────────────────────────┐
   │  step 3: dispatch                                   │
   │    ├─ Read index.md                                 │
   │    ├─ SpawnAgent executor (subagent_type=agent)     │
   │    └─ SuperTasksMove(queue-tasks → processing-tasks, │
   │                      executorTaskId=subTaskId)      │
   └────────────────────────────────────────────────────┘
                                  │
                                  ▼
   ┌────────────────────────────────────────────────────┐
   │  executor <task-notification>                       │
   │    ├─ Read process.md (confirm [DONE])              │
   │    └─ SuperTasksMove(processing-tasks →             │
   │                      verifying-tasks)               │
   └────────────────────────────────────────────────────┘
                                  │
                                  ▼
   ┌────────────────────────────────────────────────────┐
   │  SpawnAgent verifier (独立 session)                 │
   │    ├─ Read spec.md / process.md                     │
   │    ├─ Compute round N                               │
   │    ├─ Write ## 轮次 N header + 结论 + 原因          │
   │    └─ Reply with conclusion                         │
   └────────────────────────────────────────────────────┘
                                  │
                                  ▼
   ┌────────────────────────────────────────────────────┐
   │  Decision (read verification.md)                    │
   │    ├─ PASS       → SuperTasksMove(verifying →       │
   │                    finished)                        │
   │    ├─ FAIL r<3   → SuperTasksReset + re-SpawnAgent  │
   │    └─ FAIL r==3  → BackgroundRuntime.cancel +       │
   │                    SuperTasksPause + notify user    │
   └────────────────────────────────────────────────────┘
```

## 错误处理矩阵

| 失败模式 | 工具行为 | 任务调度官应对 |
|---------|---------|---------|
| `Move` 任务不在 `from` 桶 | 抛 `task ${id} not found in ${from}` | 任务调度官应 `getTaskSummary(id)` 看真实位置,重派或报告用户 |
| `Move` 目标桶已有同名 | 抛 `task ${id} already exists in ${to}` | 任务调度官应报告用户(并发冲突);不重试 |
| `Move` 后 SpawnAgent 已失败 | 任务调度官先收到 SpawnAgent 错误,Move 还没调 | 任务调度官应改走显式 `Move(processing → queue)` 回滚;若 Move 还没调,任务仍在 queue 桶,无需回滚 |
| `Reset` 任务在 queue/finished | 抛 `cannot be reset (current state: ...)` | 任务调度官应改走 dispatch 流程或报告用户 |
| `Reset` 任务 processing 但 status≠paused | 同上 | 任务调度官应先报告用户(状态机不一致) |
| `Pause` 任务在 queue/finished | 抛 `cannot be paused` | 任务调度官应报告用户(无意义操作) |
| Verifier subagent 没写 `verification.md` | 任务调度官读不到 `## 轮次 N` 段 | 任务调度官应重 SpawnAgent verifier 一次;两次失败则 Pause + 通知用户 |
| Verifier 写错 `结论:` 格式 | 任务调度官解析不到 PASS/FAIL | 同上(重 SpawnAgent verifier 一次) |
| executor SpawnAgent 拿到 task id 但 Move 抛错 | 任务仍在 queue,subagent 已运行 | 任务调度官应 BackgroundRuntime.cancel(subagent) + 报告用户 |

## 测试覆盖

### 单测

`packages/zn-agent-core/test/server/` 新增 / 更新:

- **`taskFactoryTools-move.test.ts`**:`Move` 状态机矩阵(4 桶 × 4 桶 16 对,合法 12 对逐个覆盖)+ executorTaskId backfill 字段写入正确 + 重复存在报错 + 跨桶移动后 status 字段正确。
- **`taskFactoryTools-reset.test.ts`**:`Reset` 4 桶分支(verifying / processing paused / queue / finished / 不存在)。
- **`taskFactoryTools-pause.test.ts`**:`Pause` 4 桶分支(processing / verifying / queue / finished / 不存在)+ executorTaskId 清空。
- **更新 `taskFactoryFiles-move.test.ts`**(如有):确认 core `moveTask` 行为未变(新工具是其薄包装)。
- **更新 supervisor 配置单测**:`mainAgents-taskFactory` 配置的 tools 数组不包含已删除的 Verify / MarkDone,包含新 Move / Reset / Pause。

### 端到端

ego-browser 走通任务调度官流程(用独立端口避免与 920x 正式服务冲突):

```bash
pnpm --filter @zn-ai/zai dev -- --port 8103 --api-port 7717
```

- 在 `/super-tasks` 页面创建一个简单任务(标题:「测试 Move 工具」,agent=claude-code)
- 触发 managed loop 派发 → 任务调度官 SpawnAgent executor → Move 到 processing-tasks
- executor 完成(写 [DONE]) → 任务调度官 Move 到 verifying-tasks → SpawnAgent verifier → verifier 自写 verification.md PASS
- 任务调度官 Move 到 finished-tasks
- 截图 + GET `/api/super-tasks` 取证四桶状态、`<task_dir>/index.md` frontmatter、`docs/verification.md`

## 明确不在 scope

- 不动 dsh-bridge / 双轨改造相关逻辑
- 不改 lan-agent 移动客户端
- 不改 `~/.claude/plugins/` 迁移逻辑
- 不重写 `routes/superTasks.ts`(API 路由仍用 core 函数,工具层与路由层解耦)
- 不改 `taskFactoryManagedLoop`(注入 dispatch / accept 指令的节奏不变)
- 不中断 in-flight `tf-c1tnq4yy`(verifying 桶新增)任务;新设计以 verifying 桶为基础兼容,旧任务完成后归档不影响
- 不引入新 agent 类型注册(`verifierAgent` 沿用现有 SpawnAgent `subagent_type` 字符串)
- 不改 `docs/DEVELOPMENT_REFERENCE.md` 之外的文档(主文档如有需要由执行者补充)

## 风险与回滚

| 风险 | 回滚方式 |
|------|---------|
| 新工具 Move 在某些边界 case 与 core `moveTask` 不一致 | 单测对照 core `moveTask.test.ts` 矩阵,逐桶 pair 验证;失败即修 |
| 任务调度官 prompt 重写导致现有 task-factory 会话行为异常 | tools 槽仍保留所有默认工具(SpawnAgent / Edit / Write / Read 等),任务调度官可 fallback 到手动 Edit;prompt 用英文写,与现有 prompt 风格一致 |
| 删除 Verify/MarkDone 引用断裂 | 单测 grep 检查 `import { superTasksVerifyTool` / `superTasksMarkDoneTool` 在仓库内仅出现在 `taskFactoryTools.ts` 与 `mainAgents-taskFactory.ts`,两处同步删除 |
| in-flight tf-c1tnq4yy 状态异常 | 该任务在 processing-tasks,新工具对 processing 桶的所有操作与原 Verify/MarkDone 等价;不影响 |
| verifier subagent 自写 verification.md 时机不对 | verifier prompt 明确「读完 spec/process 再写头段」;任务调度官读完 verification.md 后若发现 N 段缺失,重 SpawnAgent verifier 一次 |

## 实施步骤(高层)

1. 在 `taskFactoryTools.ts` 新增 `superTasksMoveTool` / `superTasksResetTool` / `superTasksPauseTool`,删除 `superTasksVerifyTool` / `superTasksMarkDoneTool`。
2. 在 `mainAgents-taskFactory.ts` 的 tools 槽替换为新三个工具 + 重写 step 3-6 systemPrompt。
3. 新增 / 更新单测文件(见「测试覆盖」节)。
4. `pnpm run build:core` 重建 bundle。
5. `pnpm --filter @zn-ai/zn-agent-core test` 跑相关单测。
6. `pnpm --filter @zn-ai/zai dev -- --port 8103 --api-port 7717` 起独立实例,ego-browser 走通任务调度官流程端到端。
7. 截图取证,撰写 task 报告(process.md)并 commit。

## 关联文件

- `packages/zn-agent-core/src/opencc-src/server/taskFactoryTools.ts`(主改)
- `packages/zn-agent-core/src/opencc-src/server/mainAgents-taskFactory.ts`(主改)
- `packages/zn-agent-core/src/opencc-src/server/taskFactoryFiles.ts`(不改,新工具是其薄包装)
- `packages/zai/src/server/routes/superTasks.ts`(不改,API 路由解耦)
- `packages/zai/src/server/services/taskFactoryManagedLoop.ts`(不改)
- `packages/zn-agent-core/test/server/taskFactoryTools-*.test.ts`(新增)
