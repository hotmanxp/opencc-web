# vendor 消息体系深度解析

> **本文档定位**:vendor 原生 REPL(`opencc-src/screens/REPL.tsx` 等)的完整消息体系——消息来源、生产机制、消费机制、触发时机。每个事实基于真实代码与文件:行号引用,**不依赖过期文档或泛泛而谈的二手描述**。
>
> **调研方法**:4 个独立 Explore agent 并行深入阅读关键文件(每个文件完整读完,不是 grep 摘要):
> - Agent `ad907c831d03544fe` — `messageQueueManager.ts`(559 行)完整解析 + 23 个调用方
> - Agent `abeae026b7cb613c8` — `query.ts:2600-2827` 主循环 + mid-turn drain + attachments 转换链 + 5 个 trace
> - Agent `a71def0f88788bc8a` — `useInboxPoller.ts` / `useMailboxBridge.ts` / `useScheduledTasks.ts` / `cronScheduler.ts` / vendor bg-daemon 完整机制 + 4 个 trace
> - Agent `a6fcf464853b4cb77` — vendor 后台任务完整路径 + 16 类消息来源
>
> **覆盖范围**:仅 vendor 原生 REPL,**不涉及 zai-server 实现**(zai 镜像行为详见 `2026-09-06-opencc-web-repl-unified-view.md`)。
>
> **路径规范**:除非另注,所有 `path:line` 相对仓库根 `/Users/ethan/code/opencc-web/`。

---

## 0. 阅读指南

- §1 全景图(高层架构速读)
- §2-§3 消息来源与生产(谁写)
- §4-§7 消息消费机制(谁读 + 何时读)
- §8-§10 三套异步通知机制(Inbox / Mailbox / Cron)
- §11 端到端 trace(8 个具体场景的代码级链路)
- §12-§13 关键不变量与调试速查

每节末尾标注对应子 agent 报告 ID。

---

## 1. 消息体系全景图

```
                    ┌───────────────────────────┐
                    │  16 类消息来源            │  §2
                    │  (用户/任务/cron/hook/...) │
                    └────────────┬──────────────┘
                                 │
              ┌──────────────────┴──────────────────┐
              ▼                                     ▼
    ┌──────────────────┐                 ┌───────────────────────┐
    │ 入口 A:直接 prompt│                 │ 入口 B:enqueue 路径    │
    │ onSubmit →       │                 │ enqueuePendingNotif... │
    │ handlePromptSub  │                 │ enqueue               │
    │ → executeUser... │                 │ ↓ commandQueue(单例)  │
    │ → onQuery        │                 │                       │
    │ → vendor query() │                 │ §4 messageQueueMgr    │
    └────────┬─────────┘                 └──────────┬────────────┘
             │                                      │
             │                                      ▼
             │                          ┌────────────────────────┐
             │                          │ 5 个消费者按不同时机   │  §5-§10
             │                          │ 消费 commandQueue      │
             │                          ├────────────────────────┤
             │                          │ ① mid-turn drain       │
             │                          │   query.ts:2671        │
             │                          │ ② useQueueProcessor    │
             │                          │   turn idle React hook │
             │                          │ ③ pre-API inbox        │
             │                          │   query.ts:708-712     │
             │                          │ ④ useInboxPoller       │
             │                          │   1000ms 轮询          │
             │                          │ ⑤ useMailboxBridge     │
             │                          │   signal 订阅 + poll   │
             │                          └────────────────────────┘
             │                                      │
             └──────────────────┬───────────────────┘
                                ▼
                    ┌────────────────────────┐
                    │  LLM 感知(下一轮 API)  │
                    │  - AttachmentMessage   │
                    │  - UserMessage         │
                    │  - <system-reminder>   │
                    └────────────────────────┘
```

**关键事实**:
- vendor 消息体系有 **2 个生产入口** + **5 个消费者**,但底层共享 `messageQueueManager.commandQueue` 模块级单例
- **没有"统一调度器"**:5 个消费者各自独立触发,按自身时机决定何时读
- **5 个消费者的触发时机不同**:① 同步 / ② turn idle 异步 / ③ 每次 API call 前 / ④ 1000ms 轮询 / ⑤ signal 订阅立即

> 来源:Agent `a6fcf464853b4cb77` + `ad907c831d03544fe` + `abeae026b7cb613c8` + `a71def0f88788bc8a`

---

## 2. 消息来源完整清单

### 2.1 用户直接输入(直接 prompt 路径,不进队列)

```text
键盘 stdin → Ink useInput
  → PromptInput.onSubmit (REPL.tsx:3432)
    ├─ mode='slash' → processSlashCommand
    ├─ mode='bash'  → executeBashCommand
    └─ mode='prompt' → executeUserInput → onQuery → query()  ← 直接,不进队列
```

| 来源 | 入口函数 | 文件:行号 |
|---|---|---|
| 用户主动输入 | `onSubmit` | `REPL.tsx:3432` |
| proactive tick(内部 gated) | `useProactive.onSubmitTick` | `REPL.tsx:4424` |
| teammate idle 消息 | `useInboxPoller.onSubmitTeammateMessage` | `useInboxPoller.ts:844-853` |
| mailbox idle 消息 | `useMailboxBridge.onSubmitMessage` | `useMailboxBridge.ts:19-23` |
| turn 间 drain | `useQueueProcessor.executeQueuedInput` | `REPL.tsx:4214-4241` |

### 2.2 后台任务完成通知 — `enqueuePendingNotification` 全部调用方(23 处)

**统一生产函数**(`messageQueueManager.ts:147-159`):

```typescript
export function enqueuePendingNotification(command: QueuedCommand): void {
  commandQueue.push({
    ...command,
    enqueuedAt: command.enqueuedAt ?? Date.now(),
    priority: command.priority ?? 'later',  // 默认 priority: 'later'
  })
  notifySubscribers()
  logOperation('enqueue', ...)
}
```

**全部调用方**:

| # | 文件:行号 | 场景 | mode | priority | taskKind | 特殊字段 |
|---|---|---|---|---|---|---|
| 1 | `LocalShellTask.tsx:112` | stall watchdog 超时 | `task-notification` | `'next'` | `'bash'` | — |
| 2 | `LocalShellTask.tsx:192` | bash 后台任务完成 | `task-notification` | `'next'` | `'bash'` / `'monitor'` | — |
| 3 | `LocalShellTask.tsx:413` | 前台 bash kill | `task-notification` | `'next'` | `'bash'` | — |
| 4 | `LocalShellTask.tsx:416` | 前台 bash 完成 | `task-notification` | `'next'` | `'bash'` | — |
| 5 | `LocalShellTask.tsx:528` | 前台 bash cancel | `task-notification` | `'next'` | `'bash'` | — |
| 6 | `LocalAgentTask.tsx:260` | 本地子 agent 完成 | `task-notification` | 默认 `'later'` | `'agent'` | `agentId` 字段 |
| 7 | `RemoteAgentTask.tsx:203` | 远程任务完成 | `task-notification` | 默认 `'later'` | — | `agentId` 字段 |
| 8 | `RemoteAgentTask.tsx:259` | ultraplan 失败 | `task-notification` | 默认 `'later'` | — | — |
| 9 | `RemoteAgentTask.tsx:362` | 远程 review 完成 | `task-notification` | 默认 `'later'` | — | — |
| 10 | `RemoteAgentTask.tsx:380` | 远程 review 失败 | `task-notification` | 默认 `'later'` | — | — |
| 11 | `LocalWorkflowTask.ts:502` | workflow 完成/失败 | `task-notification` | 默认 `'later'` | `'workflow'` | — |
| 12 | `LocalMainSessionTask.ts:263` | 主 session 后台任务完成 | `task-notification` | 默认 `'later'` | `'agent'` | — |
| 13 | `framework.ts:289` | framework 轮询任务完成 | `task-notification` | 默认 `'later'` | — | — |
| 14 | `useScheduledTasks.ts:74` | cron tick 触发(`enqueueForLead`) | `'prompt'` | `'later'` | — | `isMeta: true`, `workload: WORKLOAD_CRON` |
| 15 | `useCancelRequest.ts:233` | Ctrl+C 终止后台任务摘要 | `task-notification` | 默认 `'later'` | — | — |
| 16 | `hooks.ts:412` | hook 执行失败(exit code 2) | `task-notification` | 默认 `'later'` | — | — |
| 17 | `ultraplan.tsx:119` | ultraplan 获批 | `task-notification` | 默认 `'later'` | — | — |
| 18 | `ultraplan.tsx:153` | ultraplan poll 错误 | `task-notification` | 默认 `'later'` | — | — |
| 19 | `ultraplan.tsx:216` | ultraplan 被用户停止 | `task-notification` | 默认 `'later'` | — | — |
| 20 | `ultraplan.tsx:220` | ultraplan 停止后元命令 | `task-notification` | 默认 `'later'` | — | `isMeta: true` |
| 21 | `ultraplan.tsx:324` | ultraplan eligibility errors | `task-notification` | 默认 `'later'` | — | — |
| 22 | `ultraplan.tsx:348` | ultraplan session 创建失败 | `task-notification` | 默认 `'later'` | — | — |
| 23 | `ultraplan.tsx:390` | ultraplan 异常 | `task-notification` | 默认 `'later'` | — | — |
| 24 | `processSlashCommand.tsx:134` | slash 命令结果回填 | `'prompt'` | `'later'` | — | `isMeta: true`, `skipSlashCommands: true` |
| 25 | `ExitPlanModePermissionRequest.tsx:340` | ultraplan launch result | | `task-notification` | 默认 `'later'` | — |
| 26 | `compat/repl/setup/setupCronScheduler.ts:33` | zai REPL 环境 cron fire(`enqueueForLead`) | `'prompt'` | `'later'` | — | `isMeta: true` |

> **关键观察**:bash 相关(#1-5)默认 `priority: 'next'`,其他任务通知默认 `'later'`。这是关键设计差异:
> - bash 完成(默认 `next`):**不**降级路径下,mid-turn drain 可立即拉到(§5)
> - 子 agent / workflow / ultraplan(默认 `later`):mid-turn drain 在 `sleepRan=false` 时取不到,只能等 turn idle

### 2.3 `enqueue` 调用方(用户 UI 输入 + 内部命令回填)

| 文件:行号 | 场景 | priority 默认 |
|---|---|---|
| `REPL.tsx:executeUserInput` 多处 | 用户 UI 输入 | `'next'` |
| `setupCommandQueue.ts` (`cmdQueue.enqueue`) | zai REPL fallback 路径命令入队 | 由调用方指定 |

> 与 `enqueuePendingNotification` 区别:**默认 `priority: 'next'`**,且不带后台任务语义(`taskKind` 字段不强制要求)。

### 2.4 跨 session / 跨 agent inbox 消息来源

不经过 `commandQueue`,直接落 inbox 文件:

| 来源 | 写文件 | 文件格式 |
|---|---|---|
| teammate mailbox | `~/.zai/teams/{team}/inboxes/{agent}.json` | JSON 数组,`TeammateMessage[]` |
| 跨 REPL session(zai patch) | `${cwd}/.zai/inbox/${to}.jsonl` | JSONL |
| vendor bg-daemon | Unix socket IPC(不是文件) | IPC 协议 |

### 2.5 Cron 任务触发

来源来源:**`useScheduledTasks.ts:74`**(vendor)+ **`compat/repl/setup/setupCronScheduler.ts:33`**(zai patch),两者均调 `enqueuePendingNotification({mode: 'prompt', priority: 'later', isMeta: true})`,最终走 §2.2 的入队链路。

> 来源:Agent `ad907c831d03544fe` §B(23 个调用方)+ Agent `a6fcf464853b4cb77` §1

---

## 3. 生产机制详细

### 3.1 入口 A:直接 prompt 路径(绕过队列)

```text
用户输入 / slash / bash / teammate idle message
    ↓
onSubmit (REPL.tsx:3432)
    ↓ handlePromptSubmit (utils/handlePromptSubmit.ts:127)
executeUserInput (handlePromptSubmit.ts:404)
    ↓ queryGuard.tryStart()
onQuery (REPL.tsx:3109) → onQueryImpl (REPL.tsx:2915)
    ↓ for await query({...})  (vendor query 真实调用)
```

**关键事实**:
- **不**经过 `commandQueue`
- 直接走 `queryGuard.tryStart` 进入 running,触发 vendor `query()`
- 适用场景:用户主动输入、teammate/mailbox 在 idle 状态、useQueueProcessor 提交后

### 3.2 入口 B:enqueue → commandQueue 路径(异步)

```typescript
// 23 个调用方,统一通过这两个函数写入 commandQueue
enqueue(command)                  // 默认 priority: 'next'
enqueuePendingNotification(command) // 默认 priority: 'later'
    ↓
commandQueue.push(...)            // 模块级单例
    ↓ notifySubscribers()
queueChanged.emit()              // signal 通知 React useSyncExternalStore 订阅者
    ↓ logOperation()
recordQueueOperation(queueOp)     // 持久化到 ~/.zai/projects/<project>/queue_operations.json
```

**写入细节**(`messageQueueManager.ts:127-159`):

```typescript
export function enqueue(command: QueuedCommand): void {
  const normalized = {
    ...command,
    priority: command.priority ?? 'next',      // 默认 'next'
    enqueuedAt: command.enqueuedAt ?? Date.now(),
    uuid: command.uuid ?? randomUUID(),
  }
  commandQueue.push(normalized)
  notifySubscribers()
  logOperation('enqueue', typeof command.value === 'string' ? command.value : null)
}

export function enqueuePendingNotification(command: QueuedCommand): void {
  commandQueue.push({
    ...command,
    enqueuedAt: command.enqueuedAt ?? Date.now(),
    priority: command.priority ?? 'later',     // 默认 'later'
  })
  notifySubscribers()
  logOperation('enqueue', typeof command.value === 'string' ? command.value : null)
}
```

### 3.3 QueuedCommand 完整字段表

`types/textInputTypes.ts:301-372` 定义:

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `value` | `string \| Array<ContentBlockParam>` | 必填 | 命令内容(text + 图片 blocks) |
| `mode` | `PromptInputMode` | 必填 | `'bash' \| 'prompt' \| 'orphaned-permission' \| 'task-notification'` |
| `priority` | `QueuePriority` | 由入队函数填 | `'now' \| 'next' \| 'later'` |
| `uuid` | `UUID` | 入队时生成 | 命令唯一标识(防 dedup + 生命周期追踪) |
| `orphanedPermission` | `OrphanedPermission` | — | 孤立权限场景 |
| `pastedContents` | `Record<number, PastedContent>` | — | 粘贴的图片内容(image_blocks 转 attachment) |
| `preExpansionValue` | `string` | — | 粘贴扩展前的原始字符串(ultraplan 关键词检测防误触) |
| `skipSlashCommands` | `boolean` | — | true 时不触发 slash 命令解析(bridge/CCR 消息) |
| `bridgeOrigin` | `boolean` | — | true 时走 `isBridgeSafeCommand` 过滤 |
| `isMeta` | `boolean` | — | true 时 `UserMessage.isMeta=true`,模型可见但 UI 隐藏 |
| `origin` | `MessageOrigin` | — | 命令来源:`human \| keyboard \| system \| proactiveTick \| teammate` |
| `workload` | `string` | — | cc_workload 计费标签(cron 任务带 `WORKLOAD_CRON`) |
| `agentId` | `AgentId` | undefined | 子 agent ID;**主线程命令 = undefined** |
| `taskKind` | `TaskNotificationKind` | — | `'bash' \| 'agent' \| 'monitor' \| 'workflow'`,zai 用于文案分流 |
| `enqueuedAt` | `number` | 入队时设 | ms epoch,模型文案渲染可读时间 |

**特殊语义**:
- `task-notification` 模式:**不可编辑**(`isPromptInputModeEditable` 返回 false),UP 键无法召回
- `isMeta: true`:**模型可见但 UI 隐藏**,cron 任务、ultraplan 元命令都用这个
- `agentId`:**主/子线程隔离的过滤器**——主线程只看 `agentId === undefined` 的命令

> 来源:Agent `ad907c831d03544fe` §A4-A5

---

## 4. messageQueueManager 详解(559 行核心模块)

### 4.1 模块级状态

| 状态 | 行号 | 类型 | 变化时机 |
|---|---|---|---|
| `commandQueue` | 52 | `QueuedCommand[]` 可变数组 | `enqueue` push;`dequeue`/`remove`/`popAllEditable` splice;`resetCommandQueue` length=0 |
| `snapshot` | 54 | `readonly QueuedCommand[]` frozen | `notifySubscribers()` 时 `[...commandQueue]` 重新 freeze |
| `queueChanged` | 55 | `Signal` (`createSignal()`) | `notifySubscribers()` 时 emit |

**关键事实**:
- `signal.emit()` **同步遍历** `Set<Listener>`,**无锁、无缓冲**
- 多个并发 `enqueue` 在同一 microtask 内 → 最终 snapshot 反映所有入队结果(不丢更新)
- 同一 tick 内第二次 `enqueue` 的 snapshot 覆盖第一次(数组引用每次新建)

### 4.2 PRIORITY_ORDER

`messageQueueManager.ts:161-165`:

```typescript
const PRIORITY_ORDER: Record<QueuePriority, number> = {
  now: 0,
  next: 1,
  later: 2,
}
```

**数字越小越优先**:`now`(0) > `next`(1) > `later`(2)。

### 4.3 完整函数清单(15 个)

| 函数 | 行号 | 签名 | 一句话职责 |
|---|---|---|---|
| `enqueue` | 127 | `(command: QueuedCommand): void` | 用户命令入队,默认 priority `'next'` |
| `enqueuePendingNotification` | 147 | `(command: QueuedCommand): void` | 任务通知入队,默认 priority `'later'` |
| `dequeue` | 177 | `(filter?: (cmd) => boolean) => QueuedCommand \| undefined` | 移除并返回最高优先级命令(支持 filter) |
| `peek` | 229 | `(filter?: (cmd) => boolean) => QueuedCommand \| undefined` | 查看最高优先级(不移除) |
| `getCommandsByMaxPriority` | 536 | `(maxPriority: QueuePriority) => QueuedCommand[]` | 返回所有 priority ≤ maxPriority 的命令(批量读取,不移除) |
| `popAllEditable` | 439 | `(currentInput, cursorOffset) => PopAllEditableResult \| undefined` | UP 键快捷键:把 editable 命令拼接回 input,非 editable 保留 |
| `remove` | 283 | `(commandsToRemove: QueuedCommand[]) => void` | 按**引用 identity** 删除(支持批量) |
| `removeByFilter` | 308 | `(predicate: (cmd) => boolean) => QueuedCommand[]` | 按 predicate 删除并返回被移除命令 |
| `clearCommandQueue` | 332 | `(): void` | 清空队列(ESC 取消时) |
| `resetCommandQueue` | 344 | `(): void` | 清空 + 重置 snapshot(**仅测试用**) |
| `subscribeToCommandQueue` | 70 | `queueChanged.subscribe` | useSyncExternalStore 订阅接口 |
| `getCommandQueueSnapshot` | 77 | `() => readonly QueuedCommand[]` | 读取 snapshot |
| `getCommandQueue` | 89 | `() => QueuedCommand[]` | 返回可变副本(非 React 代码用) |
| `getCommandQueueLength` | 96 | `() => number` | 队列长度 |
| `hasCommandsInQueue` | 103 | `() => boolean` | 是否非空 |
| `recheckCommandQueue` | 112 | `(): void` | 异步处理完成后手动触发 re-render |
| `dequeueAll` | 209 | `() => QueuedCommand[]` | 移除并返回所有 |
| `dequeueAllMatching` | 254 | `(predicate: (cmd) => boolean) => QueuedCommand[]` | 批量移除并返回(保持优先级顺序) |
| `isPromptInputModeEditable` | 358 | `(mode) => boolean` | 判断 mode 是否可编辑 |
| `isQueuedCommandEditable` | 370 | `(cmd) => boolean` | `isPromptInputModeEditable(cmd.mode) && !cmd.isMeta` |
| `isQueuedCommandVisible` | 379 | `(cmd) => boolean` | 是否在队列预览显示(channel 消息可见但不可编辑) |
| `isSlashCommand` | 552 | `(cmd) => boolean` | 是否 slash 命令(string 值 + `/` 开头 + 非 skipSlashCommands) |
| `logOperation` | 27 | `(operation, content?) => void` | 构造 `QueueOperationMessage` + 持久化 |

### 4.4 持久化机制

`logOperation` → `recordQueueOperation(queueOp)`(`sessionStorage.ts:2113`):

```typescript
{
  type: 'queue-operation',
  operation: 'enqueue' | 'dequeue' | 'remove' | 'popAll',
  timestamp: ISO string,
  sessionId: string,
  content?: string  // 仅 enqueue/popAll 有
}
```

**写入位置**:`~/.zai/projects/<project>/queue_operations.json`

**Replay 时机**:session 恢复时从该文件重建队列状态。

### 4.5 边界条件

| 场景 | 行为 |
|---|---|
| 并发 enqueue | 最终 snapshot 反映所有入队结果(无锁但 React 不会丢更新) |
| `resetCommandQueue` 调用方 | **生产代码无调用**,仅测试 cleanup(`bundle-entry.ts:142` 暴露供测试) |
| `getCommandsByMaxPriority('later')` vs `dequeue()` | 前者批量读取 all(不修改),后者单条移除 |
| `remove` 按引用 identity | 不按 index(防止 splice 时 index 漂移) |

> 来源:Agent `ad907c831d03544fe` §A、C

---

## 5. 消费者 ①:**mid-turn drain**(`query.ts:2671`)

### 5.1 触发时机

vendor `query()` 主循环(`query.ts:628-2827`)每次迭代,在以下时序点触发:

```text
while (true) {
  ┌─ snipCompactIfNeeded (line 800-806)         // ① 消息压缩
  ├─ buildInboxSystemReminder (line 708)         // ② 拉取 vendor bg-daemon inbox
  ├─ runExtraReminderProviders (line 709)        // ③ 拉取 zai sessionInbox(zai patch 2026-09-06)
  ├─ deps.callModel (line 1283-1531)              // ④ LLM 调用
  ├─ runTools / streamingToolExecutor (2354-2387) // ⑤ 工具执行
  ├─ ★ MID-TURN DRAIN (line 2660-2691)            // ⑥ ★ 本节重点
  ├─ toolResults.push(attachment)                 // ⑦ 注入下一轮 messages
  ├─ removeFromQueue (line 2743)                  // ⑧ 从队列移除
  └─ notifyCommandLifecycle(uuid, 'started') (line 2740) // ⑨ 生命周期上报
}
```

**重要**:每次迭代都跑 mid-turn drain,**不仅在 turn idle**。当前 turn 活跃时,后台通知能"插队"到当前 LLM 上下文。

### 5.2 完整代码(`query.ts:2660-2691`)

```typescript
// query.ts:2660-2691
const sleepRan = toolUseBlocks.some(b => b.name === SLEEP_TOOL_NAME)
const isMainThread =
  querySource.startsWith('repl_main_thread') ||
  querySource === 'server-repl' ||
  querySource === 'sdk'
const currentAgentId = toolUseContext.agentId

// 核心:根据 sleepRan 决定取 'next' 还是 'later' 优先级的命令
const queuedCommandsSnapshot = getCommandsByMaxPriority(
  sleepRan ? 'later' : 'next',
).filter(cmd => {
  if (isSlashCommand(cmd)) return false                    // 排除 slash
  if (isMainThread) return cmd.agentId === undefined      // 主线程只取无 agentId
  // 子 agent 只取自己的 task-notification
  return cmd.mode === 'task-notification' && cmd.agentId === currentAgentId
})

// Async generator:QueuedCommand[] → AttachmentMessage[]
for await (const attachment of getAttachmentMessages(
  null, updatedToolUseContext, null,
  queuedCommandsSnapshot,
  [...messagesForQuery, ...assistantMessages, ...toolResults],
  querySource,
)) {
  yield attachment
  toolResults.push(attachment)
}
```

### 5.3 sleepRan 降级机制详解

**触发条件**:本轮 turn 中执行了 `SLEEP_TOOL_NAME` 工具。

**降级效果**:
- `sleepRan = false`(普通 turn):`getCommandsByMaxPriority('next')` → **只拉 now + next**(默认 later 不拉)
- `sleepRan = true`(本轮有 Sleep 工具):降级到 `getCommandsByMaxPriority('later')` → **拉所有优先级**(now + next + later)

**设计意图**:Sleep 唤醒后,确保之前被跳过的 `priority:'later'` 的子 agent / workflow 通知能被本轮 LLM 感知。

### 5.4 filter 逻辑精确分析

| cmd 类型 | 主线程 filter | 子 agent filter |
|---|---|---|
| **slash command** | ❌ 排除(走 turn 间 processQueueIfReady) | ❌ 排除 |
| **prompt**(无 agentId) | ✅ 拉取 | ❌ 排除(子 agent 不应消费主线程命令) |
| **task-notification**(无 agentId) | ✅ 拉取 | ❌ 排除 |
| **prompt**(有 agentId = 子 agent A) | ❌ 排除 | ❌ 排除(只取 task-notification) |
| **task-notification**(有 agentId = 当前子 agent) | ❌ 排除 | ✅ 拉取 |

### 5.5 完整转换链路:`QueuedCommand[]` → LLM 感知

```
QueuedCommand[]  (mid-turn drain 过滤后)
  ↓
getQueuedCommandAttachments(queuedCommands)        (attachments.ts:1136)
  ├─ 过滤 INLINE_NOTIFICATION_MODES = { 'prompt', 'task-notification' }
  ├─ 转换:每个 cmd → { type: 'queued_command', prompt, source_uuid, ... }
  └─ 处理 pastedContents(image blocks)
  ↓
Attachment[]  ({ type: 'queued_command', ... })
  ↓
createAttachmentMessage(attachment)                 (attachments.ts:3524)
  ↓
AttachmentMessage { attachment, type: 'attachment', uuid, timestamp }
  ↓
yield 进 toolResults                                  (query.ts:2685-2690)
  ↓
messages: [...messagesForQuery, ...assistantMessages, ...toolResults]  (line 2811)
  ↓
LLM API call 看到 user attachment 消息
```

**`INLINE_NOTIFICATION_MODES`**(`attachments.ts:1136`):
```typescript
const INLINE_NOTIFICATION_MODES = new Set(['prompt', 'task-notification'])
```

### 5.6 移除 + 生命周期上报

```typescript
// query.ts:2736-2744
const consumedCommands = queuedCommandsSnapshot.filter(
  cmd => cmd.mode === 'prompt' || cmd.mode === 'task-notification',
)
if (consumedCommands.length > 0) {
  for (const cmd of consumedCommands) {
    if (cmd.uuid) {
      consumedCommandUuids.push(cmd.uuid)
      notifyCommandLifecycle(cmd.uuid, 'started')  // ④ 生命周期 started
    }
  }
  removeFromQueue(consumedCommands)                 // ⑤ 从队列移除
}
```

**`notifyCommandLifecycle` 时序**:
- turn 开始(每个 cmd):`'started'`(query.ts:2740)
- turn 结束(query.ts:523):对所有 `consumedCommandUuids` 调 `'completed'`

> 来源:Agent `abeae026b7cb613c8` §A1-A4、§B

---

## 6. 消费者 ②:**turn 间消费**(`useQueueProcessor` + `queueProcessor`)

### 6.1 `useQueueProcessor.ts` 完整结构

```typescript
// useQueueProcessor.ts
export function useQueueProcessor({
  executeQueuedInput,
  hasActiveLocalJsxUI,
  queryGuard,
}: Props) {
  // 订阅 QueryGuard.isActive
  const isQueryActive = useSyncExternalStore(queryGuard.subscribe, queryGuard.getSnapshot)
  // 订阅 commandQueue snapshot
  const queueSnapshot = useSyncExternalStore(subscribeToCommandQueue, getCommandQueueSnapshot)

  useEffect(() => {
    if (isQueryActive) return                    // ① turn 在跑 → 跳过
    if (hasActiveLocalJsxUI) return              // ② JSX UI 阻塞 → 跳过
    if (queueSnapshot.length === 0) return       // ③ 队列空 → 跳过
    processQueueIfReady({ executeInput: executeQueuedInput })
  }, [queueSnapshot, isQueryActive, executeQueuedInput, hasActiveLocalJsxUI, queryGuard])
}
```

**### 触发条件**:**所有** 同时满足:
1. `isQueryActive === false`(`QueryGuard._status === 'idle'`)
2. `!hasActiveLocalJsxUI`(无 JSX 命令对话框阻塞)
3. `queueSnapshot.length > 0`

### 6.2 `queueProcessor.ts:processQueueIfReady` 完整实现

```typescript
// queueProcessor.ts:52-87
export function processQueueIfReady({ executeInput }): ProcessQueueResult {
  const isMainThread = (cmd: QueuedCommand) => cmd.agentId === undefined

  const next = peek(isMainThread)                // 只看主线程最高优先级
  if (!next) return { processed: false }

  // 单条处理:slash command 或 bash mode
  if (isSlashCommand(next) || next.mode === 'bash') {
    const cmd = dequeue(isMainThread)!
    void executeInput([cmd])                     // 单独执行,per-command 错误隔离
    return { processed: true }
  }

  // 批量处理:同 mode 的所有非 slash 命令
  const targetMode = next.mode
  const commands = dequeueAllMatching(
    cmd => isMainThread(cmd) && !isSlashCommand(cmd) && cmd.mode === targetMode,
  )
  if (commands.length === 0) return { processed: false }

  void executeInput(commands)                    // 一次执行多条
  return { processed: true }
}
```

**决策规则**:

| 队首 cmd 类型 | 决策 | 原因 |
|---|---|---|
| **slash command**(`/foo`) | 单条 | 每个 slash 需单独走 `processSlashCommand` |
| **bash mode** | 单条 | 保留 per-command 错误隔离、exit code、进度 UI |
| **prompt** / **task-notification** | 批量(同 mode) | 可一次执行多条,合并为新 turn |

### 6.3 `executeQueuedInput` 实现(`REPL.tsx:4214-4241`)

```typescript
const executeQueuedInput = useCallback(async (queuedCommands: QueuedCommand[]) => {
  await handlePromptSubmit({
    helpers: { setCursorOffset: () => {}, clearBuffer: () => {}, resetHistory: () => {} },
    queryGuard, commands, onInputChange: () => {}, setPastedContents: () => {},
    setToolJSX, getToolUseContext, messages, mainLoopModel, ideSelection,
    setUserInputOnProcessing, setAbortController, onQuery, setAppState,
    querySource: getQuerySourceForREPL(), onBeforeQuery, canUseTool, addNotification,
    setMessages,
    queuedCommands  // ← QueuedCommand[] 直接传入作为用户消息
  })
}, [...])
```

**关键**:`queuedCommands` 数组 → `handlePromptSubmit` → `executeUserInput` → 每个 cmd 创建独立 `UserMessage`(cmd 自带 UUID,防 dedup)→ 走直接 prompt 路径。

### 6.4 `isMainThread` filter

`queueProcessor.ts:61`:

```typescript
const isMainThread = (cmd: QueuedCommand) => cmd.agentId === undefined
```

**注意**:`processQueueIfReady` 只消费主线程命令(子 agent 的通知留在队列里,等子 agent 自己的 mid-turn drain)。

> 来源:Agent `abeae026b7cb613c8` §C-D

---

## 7. 消费者 ③:**pre-API inbox reminder**(`query.ts:708-712`)

### 7.1 触发时机

每次 `deps.callModel` 之前 — 即**每个 LLM API call 之前都跑**。

### 7.2 完整代码

```typescript
// query.ts:706-741
{
  // Vendor bg-daemon drain + zai-session-inbox drain (zai patch 2026-09-06).
  const bgReminder = await buildInboxSystemReminder()
  const extraReminder = await runExtraReminderProviders(getSessionId())
  const reminder = bgReminder && extraReminder
    ? `${bgReminder}\n\n${extraReminder}`
    : (bgReminder ?? extraReminder ?? null)
  if (reminder) {
    // Strip leading <system-reminder>...</system-reminder> blocks from user message
    messagesForQuery = messagesForQuery.map(m => { ... })
    // Prepend new user message carrying the reminder
    messagesForQuery = [
      { type: 'user', message: { role: 'user', content: reminder }, uuid: `bg-inbox-${Date.now()}`, timestamp: ... },
      ...messagesForQuery,
    ]
  }
}
```

### 7.3 两路并行追加

| 来源 | 函数 | 作用 |
|---|---|---|
| vendor bg-daemon | `buildInboxSystemReminder()` | 读 vendor Unix socket IPC 收件箱 |
| zai sessionInbox | `runExtraReminderProviders(getSessionId())` | 读 zai SessionInbox.nextStep lane(zai patch 2026-09-06) |

两者**并列追加**到同一个 `<system-reminder>` 块,prepend 到 last user message。

### 7.4 zai 的 `registerExtraReminderProvider` hook

**vendor 暴露点**:`bundle-entry.ts` exports `registerExtraReminderProvider`

**zai 注册点**:`zai/src/server/services/agentRuntime.ts:164`:

```typescript
import { registerExtraReminderProvider } from '@zn-ai/zn-agent-core'
registerExtraReminderProvider((sid: string) => drainInboxReminder(sid))
```

**vendor 调用点**:`query.ts:709` — `runExtraReminderProviders(getSessionId())` 在每次 LLM API call 前

**zai 自己的 inbox**:`inboxReminder.ts` 的 `drainInboxReminder()` → `getSessionInbox(sessionId).consumeNextStep()` → 渲染为 `<system-reminder>` prepend 到 user message

> 来源:Agent `a71def0f88788bc8a` §D + Agent `abeae026b7cb613c8` §A1

---

## 8. 消费者 ④:**useInboxPoller**(teammate 消息)

### 8.1 轮询对象

- **路径**:`~/.zai/teams/{teamName}/inboxes/{agentName}.json`
- **文件格式**:**JSON 数组**,不是 JSONL(`TeammateMessage[]`)
- **读取函数**:`readMailbox()` → `readUnreadMessages()` 过滤 `read === false`

### 8.2 轮询频率

- **常量**:`INBOX_POLL_INTERVAL_MS = 1000`(`useInboxPoller.ts:107`)
- **实现**:`useInterval(() => void poll(), shouldPoll ? INBOX_POLL_INTERVAL_MS : null)`(line 954)
- **mount 时**:立即触发一次 initial poll(line 958-968)

### 8.3 8 类 message types 完整解析

| Type | Guard Function | 处理 |
|---|---|---|
| `permission_request` | `isPermissionRequest` | → `ToolUseConfirmQueue`(leader side 弹窗) |
| `permission_response` | `isPermissionResponse` | → `processMailboxPermissionResponse`(teammate side 处理响应) |
| `sandbox_permission_request` | `isSandboxPermissionRequest` | → `workerSandboxPermissions` queue |
| `sandbox_permission_response` | `isSandboxPermissionResponse` | → `processSandboxPermissionResponse` |
| `shutdown_request` | `isShutdownRequest` | → `regularMessages` pass-through |
| `shutdown_approved` | `isShutdownApproved` | → kill pane + remove from team |
| `team_permission_update` | `isTeamPermissionUpdate` | → 应用到 `toolPermissionContext` |
| `mode_set_request` | `isModeSetRequest` | → 更新 permission mode + `config.json` |
| `plan_approval_request` | `isPlanApprovalRequest` | → auto-approve + 写 response 到 inbox |
| `teammate_terminated`(内部生成) | — | 通过正常消息通道 |
| 其他 → `regularMessages` | — | XML-wrapped turn submission |

### 8.4 TeammateMessage 数据结构

```typescript
type TeammateMessage = {
  from: string          // sender name
  text: string          // raw JSON string(parsed by guard functions)
  timestamp: string     // ISO 8601
  read: boolean         // default false
  color?: string        // 'red'|'blue'|...
  summary?: string      // 5-10 word preview
}
```

**XML 包装格式**(`useInboxPoller.ts:818`):
```xml
<teammate-message teammate_id="{from}"{colorAttr}{summaryAttr}>
{text}
</teammate-message>
```

### 8.5 busy vs idle 处理路径

#### idle 路径(turn 没在跑)

```typescript
// useInboxPoller.ts:844-853
if (!isLoading) {
  const submitted = onSubmitTeammateMessage(xmlFormatted)  // 直接走 onSubmit
  if (!submitted) {                                        // 提交失败回退
    return queueMessages(formatted, from, color, summary, teammate_id, 'regular')
  }
}
```

#### busy 路径(turn 在跑)

```typescript
// useInboxPoller.ts:843-858
if (isLoading) {
  return queueMessages(formatted, from, color, summary, teammate_id, type)
  // 写入 AppState.inbox.messages (status: 'pending')
}
```

### 8.6 busy → idle 切换时批量提交(`useInboxPoller.ts:876-950`)

```typescript
useEffect(() => {
  // 监听 isLoading / focusedInputDialog 变化
  if (isLoading || focusedInputDialog) return
  
  const pendingMessages = inbox.messages.filter(m => m.status === 'pending')
  for (const msg of pendingMessages) {
    const formatted = formatMessage(msg)
    const submitted = onSubmitTeammateMessage(formatted)
    if (submitted) {
      // 成功后按 ID 从 AppState.inbox.messages 删除
      setAppState({ inbox: { messages: filter(!submittedIds) } })
    }
  }
}, [isLoading, focusedInputDialog, inbox.messages])
```

### 8.7 markRead 时机

```-`messages-asRead(agentName, teamName)`(`useInboxPoller.ts:200-202`):批量将 inbox JSON 中所有消息 `read: true` 写回文件。

**触发时机**:
- 消息成功 `onSubmit` 后
- 消息可靠 `queueMessages` 后(line 864)
- **不在 poll 后立即 markRead**(防止消息丢失)

### 8.8 与 vendor bg-daemon 的关系

| | useInboxPoller | bg-daemon (buildInboxSystemReminder) |
|---|---|---|
| **作用对象** | teammate 间主动消息(permission/mode/shutdown/regular) | bg agent completion 通知 |
| **文件位置** | `~/.zai/teams/*/inboxes/*.json` | Unix socket IPC |
| **读取时机** | 1000ms `useInterval` | 每次 API call 前(`query.ts:708`) |
| **注入方式** | idle 时 onSubmit / busy 时 pending queue → idle 后批量提交 | `<system-reminder>` prepend to user message |
| **正交** | ✓ 两者独立运行 | ✓ 不冲突 |

> 来源:Agent `a71def0f88788bc8a` §A

---

## 9. 消费者 ⑤:**useMailboxBridge**(跨 session)

### 9.1 mailbox 实例

- **来源**:`useMailbox()` 来自 `context/mailbox.tsx` 的 React Context(`MailboxProvider`)
- **`Mailbox` 类**(`utils/mailbox.ts`):**in-memory queue** + signal-based subscribe

### 9.2 subscribe 实现(`useMailboxBridge.ts:12-23`)

```typescript
const mailbox = useMailbox()
const subscribe = useMemo(() => mailbox.subscribe.bind(mailbox), [mailbox])
const getSnapshot = useCallback(() => mailbox.revision, [mailbox])
const revision = useSyncExternalStore(subscribe, getSnapshot)

useEffect(() => {
  if (isLoading) return
  const msg = mailbox.poll()                      // 每次 revision 变化取走一条
  if (msg) onSubmitMessage(msg.content)
}, [isLoading, revision, mailbox, onSubmitMessage])
```

**关键事实**:
- **不是文件轮询**,是**内存 signal 订阅**
- `mailbox.revision` 变化触发 re-render,`mailbox.poll()` 同步取一条
- **严格按 isLoading 过滤**:busy 时 `return`,idle 时才 poll

### 9.3 跨 session 文件写入

`setupMailboxBridge.ts`(zai patch L1 adapter)写入:
```
join(cwd, '.zai', 'inbox', '${to}.jsonl')
```

**注意**:`useMailboxBridge` 监听的是**内存 `Mailbox` 实例**(signal),不是这个文件。

跨 session 文件写入的真实路径:
- `SendMessageTool` / `spawnMultiAgent` → `writeToMailbox()` → 落 `~/.zai/teams/{team}/inboxes/{agent}.json`(**JSON 数组**)
- zai patch 的 `setupMailboxBridge.send()` 用 `appendFileSync` 写 **JSONL**(跨 REPL session)

### 9.4 busy vs idle

**严格按 `isLoading`**:busy 时 `return` 不 poll;idle 时 poll 1 条就 `onSubmitMessage`。

> 来源:Agent `a71def0f88788bc8a` §B

---

## 10. 消费者(Cron):**cronScheduler**

### 10.1 注册时机

`useScheduledTasks.ts` 在 `REPL.tsx:4398-4405` 注册:

```typescript
// Scheduled tasks from .claude/scheduled_tasks.json (CronCreate/Delete/List)
// and session-only /loop runs.
const assistantMode = store.getState().kairosEnabled
useScheduledTasks({ isLoading, assistantMode, setMessages })
```

`assistantMode = kairosEnabled`(GrowthBook feature flag);内部 `isKairosCronEnabled()` 决定是否启动 scheduler。

### 10.2 scheduler 生命周期

- `start()`: 获取 scheduler lock → `load(true)` 加载文件任务 → chokidar watch → `setInterval(check, 1000)`
- `stop()`: 清所有 timer + close chokidar + release lock
- `enable()`: 若 `scheduled_tasks.json` 有任务或 `assistantMode=true` 则直接 enable,否则 poll `getScheduledTasksEnabled()`

### 10.3 核心常量

| 常量 | 值 | 用途 |
|---|---|---|
| `CHECK_INTERVAL_MS` | 1000 | 主循环 tick 间隔 |
| `FILE_STABILITY_MS` | 300 | chokidar `awaitWriteFinish` 防抖 |
| `LOCK_PROBE_INTERVAL_MS` | 5000 | 非 owner session 探测 lock 间隔 |

### 10.4 `createCronScheduler(options)` 完整签名

| Option | Type | Default |
|---|---|---|
| `onFire` | `(prompt: string) => void` | **required** |
| `isLoading` | `() => boolean` | **required** |
| `assistantMode` | `boolean` | `false` |
| `onFireTask` | `(task: CronTask) => void` | `undefined` |
| `onMissed` | `(tasks: CronTask[]) => void` | `undefined` |
| `dir` | `string` | `undefined`(REPL 路径) |
| `lockIdentity` | `string` | `undefined`(用 sessionId) |
| `getJitterConfig` | `() => CronJitterConfig` | `DEFAULT_CRON_JITTER_CONFIG` |
| `isKilled` | `() => boolean` | `undefined` |
| `filter` | `(t: CronTask) => boolean` | `undefined` |

### 10.5 `check()` 主循环(`cronScheduler.ts:230-394`)

```text
check() 每 1s tick:
  if (isKilled?.()) return                                              // (1) GrowthBook 守卫
  if (isLoading() && !assistantMode) return                             // (2) turn 期间不发
  遍历 file-backed tasks(仅 owner)
  遍历 session tasks(所有实例)
  对每个 task:
    if filter && !filter(t) return                                      // daemon filter
    if inFlight.has(t.id) return                                        // 防重入
    next = nextFireAt.get(t.id)
    if next === undefined → 从 lastFiredAt ?? createdAt 锚定
    if now < next → return
    if onFireTask(t) → 走 task 路径
    else onFire(t.prompt) → 走 prompt 字符串路径
    aged = isRecurringTaskAged(t, now, recurringMaxAgeMs)
    if aged → 一次性删除
    if recurring && !aged → 从 now 重锚定 nextFireAt
    else if session task → removeSessionCronTasks
    else if one-shot file task → 异步 removeCronTasks(inFlight guard)
```

### 10.6 锁机制

- `tryAcquireSchedulerLock()`:在 `.zai/` 下写 lock 文件(PID + identity)
- Owner 死后,其他 session 5s 探测一次,成功获取后接管
- chokidar `change` 触发 reload:重新读取文件,清空 `nextFireAt` 重新计算

### 10.7 任务类型处理

| 类型 | 处理 |
|---|
| `recurring: true` | reschedule from `now`;`lastFiredAt` 持久化 |
| `recurring: false/undefined` | 异步 `removeCronTasks`;`inFlight` 防重 |
| `durable: false`(session-only) | 不落盘,每 tick 重新读 `getSessionCronTasks()` |
| `permanent: true` | 永不过期,`isRecurringTaskAged` 跳过 |

### 10.8 fire 流程

- `onFireTask(t)`:有 `agentId` → `injectUserMessageToTeammate()`;无 `agentId` → `enqueueForLead` + `ScheduledTaskFireMessage`
- `onFire(prompt)`:直接 `enqueuePendingNotification({ priority: 'later', isMeta: true, mode: 'prompt' })`

### 10.9 失败重发保护

- `inFlight: Set<string>`:fire 时 add,`removeCronTasks` finally 时 delete
- `markCronTasksFired` 写 `lastFiredAt`,下次 load 时 first-sight 用 `lastFiredAt` 重新计算 `nextFireAt`

### 10.10 任务过期与错过

- **过期**:`isRecurringTaskAged(t, now, recurringMaxAgeMs)` — `now - t.createdAt >= recurringMaxAgeMs` → fire 一次后删
  - `recurringMaxAgeMs` 来自 `CronJitterConfig`(GrowthBook,默认 7 天,0 = 不限)
- **错过**:`findMissedTasks(next, now)` — `now > jitteredNextRun` 的一次性任务
  - 启动时:`onMissed(missed)` 或 `onFire(buildMissedTaskNotification(missed))` → `removeCronTasks` 异步删

> 来源:Agent `a71def0f88788bc8a` §C

---

## 11. 端到端 Trace — 8 个具体场景

### 场景 1:bash 后台完成于活跃 turn 中(`priority: 'next'`)

```
1. 用户输入 turn 1 → vendor query 启动
2. turn 1 跑中,bash 后台完成
   → LocalShellTask.tsx:192 enqueuePendingNotification({priority:'next', mode:'task-notification', taskKind:'bash'})
   → commandQueue.push → notifySubscribers → React re-render
3. turn 1 主循环下一次迭代到 query.ts:2671
   → sleepRan = false(无 Sleep)
   → getCommandsByMaxPriority('next') → 拿到 bash 完成(cmd priority='next')
   → filter:isSlashCommand=false, agentId=undefined → 通过
4. 转换:QueuedCommand → AttachmentMessage({type: 'queued_command', taskKind:'bash', ...})
   → yield 进 toolResults
5. removeFromQueue → 队列清掉这条
   → notifyCommandLifecycle(uuid, 'started')
6. 下一轮 deps.callModel 看到 bash 结果作为 user attachment message
```

**延迟**:**立即**(同一轮 LLM API call 的下一次迭代)

### 场景 2:子 agent 完成于活跃 turn 中(`priority: 'later'`,无 Sleep)

```
1. turn 1 跑中,子 agent A 完成 → LocalAgentTask.tsx:260
   → enqueuePendingNotification({priority:'later' (默认), mode:'task-notification', taskKind:'agent', agentId:'A'})
2. turn 1 主循环迭代到 query.ts:2671
   → sleepRan = false
   → getCommandsByMaxPriority('next') → 只拉 now+next,**'later' 拿不到**
   → 中转 attachment 生成空 → 不消耗
3. 子 agent 通知留在 commandQueue,等下一轮
4. turn 1 结束 → QueryGuard._status → 'idle'
5. useQueueProcessor useEffect 触发
   → processQueueIfReady → peek(isMainThread)
   → cmd.agentId === 'A' → isMainThread(cmd) = false → 跳过
6. 子 agent 通知**留在队列里**,等 useInboxPoller / 自己 mid-turn drain 触发
```

**延迟**:等下一次 turn 启动 → mid-turn drain 时(isMainThread 子路径,只看 task-notification + agentId match)→ LLM 看到

### 场景 3:turn idle 时 bash 后台完成(`priority: 'next'`)

```
1. turn idle,queryGuard._status === 'idle'
2. bash 后台完成 → enqueuePendingNotification({priority:'next'})
3. queueChanged signal → React re-render → useQueueProcessor useEffect 触发
4. peek(isMainThread) → 拿到 bash 完成
   → isSlashCommand=false, mode='task-notification' → 走批量路径
   → dequeueAllMatching 同 mode → 取出
5. executeQueuedInput(commands) → handlePromptSubmit → 新 turn 启动
6. onQuery → vendor query → 新 turn 的 mid-turn drain 看到这条(从队列移除)
   → LLM 看到
```

**延迟**:signal emit → React re-render → 新 turn 启动 → 数百 ms

### 场景 4:turn idle 时子 agent 完成(`priority: 'later'`,主线程无法消费)

```
1. turn idle
2. 子 agent A 完成 → enqueuePendingNotification({priority:'later', agentId:'A'})
3. useQueueProcessor 触发 → peek(isMainThread) → cmd.agentId='A' → 跳过
4. **子 agent 通知留在 commandQueue**
5. 结果:无消费者 → 永久滞留
   (实际不会发生,因为 useQueueProcessor 还在 useSyncExternalStore 订阅,队列变化会持续触发,但每次都被 isMainThread filter 跳过)
```

**关键洞察**:**主线程 REPL 看不到子 agent 的 task-notification**(因为 filter agentId match)。这是**有意为之**:子 agent 通知由子 agent 自己的 query 循环消费(但 zai web 不跑子 agent 循环,所以这条消息实际丢失)。

### 场景 5:teammate 发消息到 idle REPL

```
1. teammate B 调 SendMessageTool → writeToMailbox('AgentA', {from:'B', text:'...', timestamp, read:false})
   → lock ~/.zai/teams/{team}/inboxes/AgentA.json
   → read → append → writeFile
2. AgentA useInboxPoller 1000ms tick → poll()
   → readUnreadMessages('AgentA') → 找到未读
   → isLoading=false → onSubmitTeammateMessage(xmlFormatted)
   → XML 包装 <teammate-message teammate_id="B" color="..." summary="...">text</teammate-message>
   → onSubmit → handlePromptSubmit → executeUserInput → onQuery → vendor query
3. turn 跑起来,新消息作为 user message(非 attachment)
4. markMessagesAsRead('AgentA') → inbox 文件 read:true 写回
```

**延迟**:**1000ms 轮询周期 + React re-render + 新 turn 启动** ≈ 1-2 秒

### 场景 6:teammate 发消息到 busy REPL

```
1. teammate B 写入 inbox
2. AgentA useInboxPoller 1000ms tick → isLoading=true
   → queueMessages(formatted, ...) → AppState.inbox.messages.push({status:'pending', ...})
   → markMessagesAsRead()
3. turn 继续,pending 消息不消费
4. turn 结束 → isLoading 变 false
5. useInboxPoller useEffect (line 876-950) 触发
   → inbox.messages.filter(status==='pending')
   → 批量 onSubmitTeammateMessage → 新 turn 启动
6. setAppState({inbox:{messages: filter(!submittedIds)}}) → 清 pending
```

**延迟**:轮询延迟(1s)+ turn 剩余时间 + busy→idle 切换延迟

### 场景 7:/loop 5m "check builds"

```
1. 用户输入 /loop 5m "check builds"
   → registerLoopSkill → CronCreateTool
   → addCronTask('*/5 * * * *', 'check builds', recurring:true, durable:true)
   → 写 ~/.zai/scheduled_tasks.json
2. useScheduledTasks / createCronScheduler
   → scheduler.start() → enable()
   → tryAcquireSchedulerLock() → 写 lock file
   → chokidar watch + setInterval(check, 1000)
3. 每 1s tick: check()
   → 计算 nextFireAt (jitteredNextCronRunMs)
   → 5m 到期
4. onFireTask(task)
   → 没有 agentId → enqueueForLead(task.prompt)
   → enqueuePendingNotification({priority:'later', isMeta:true, mode:'prompt', workload:WORKLOAD_CRON})
   → commandQueue.push
5. 下一轮 check(): markCronTasksFired([task.id], now) → 持久化 lastFiredAt
   → 计算下次 nextFireAt (5m + jitter)
6. commandQueue 中的 cron 命令 → §3 mid-turn drain 或 §6 turn 间 useQueueProcessor 消费
```

### 场景 8:bg agent completion(Unix socket)

```
1. AgentTool run_in_background:true 派发 bg agent
   → markBackgroundAgentDispatched() (module-level flag → true)
   → 持久化 cachedClientId (process-level)
2. bg agent 在 daemon 进程跑完
3. daemon 通过 Unix socket 发送 InboxMessage({...})
4. 下一轮 LLM API call → query.ts:708 buildInboxSystemReminder()
   → requestDaemon({proto:1, op:'inbox', clientId, ackThrough}, 2000)
   → 返回 { messages: [...], highestId }
   → lastInboxAckThrough 更新
   → renderInbox(messages) → "<system-reminder>...</system-reminder>"
   → prepend 到 messagesForQuery 的 last user message
5. LLM 看到 bg agent completion 作为 system-reminder
```

**注意**:**第一次 dispatch bg agent 后才短路**(避免无用 IPC);`ackThrough` 游标防重放。

> 来源:Agent `a6fcf464853b4cb77` 完整 + Agent `abeae026b7cb613c8` §E(5 个 trace)+ Agent `a71def0f88788bc8a` §E(4 个 trace)

---

## 12. 关键不变量

| 不变量 | 文件:行号 | 含义 |
|---|---|---|
| `commandQueue` 是模块级 singleton | `messageQueueManager.ts:52` | 同进程所有组件共享队列 |
| `signal.emit` 同步遍历,无锁 | `utils/signal.ts:27` | 多个并发 enqueue 最终 snapshot 反映全部 |
| mid-turn drain 触发条件 | `query.ts:2660-2691` | turn 活跃时每轮迭代都跑 |
| sleepRan 降级到 `'later'` | `query.ts:2660, 2671` | 本轮有 Sleep 工具时拉所有优先级 |
| mid-turn drain 主线程 filter | `query.ts:2667-2669` | `agentId === undefined` 才取 |
| 子 agent filter | `query.ts:2672-2673` | `mode === 'task-notification' && agentId === currentAgentId` |
| `notifyCommandLifecycle` 时序 | `query.ts:2740, 523` | start 在 mid-turn drain,complete 在 turn 结束 |
| useQueueProcessor 触发条件 | `useQueueProcessor.ts:48-60` | `isQueryActive=false && !hasActiveLocalJsxUI && queueSnapshot.length>0` |
| isMainThread filter(turn 间) | `queueProcessor.ts:61` | `cmd.agentId === undefined` |
| bash 默认 priority `'next'` | `LocalShellTask.tsx:192, 413, 416, 528` | 不走 sleepRan 降级路径即可 mid-turn 消费 |
| 其他任务通知默认 `'later'` | `enqueuePendingNotification:147` | 仅 sleepRan=true 或 turn idle 时消费 |
| useInboxPoller 轮询 1000ms | `useInboxPoller.ts:107` | 1s tick |
| cronScheduler 轮询 1000ms | `cronScheduler.ts:40` | `CHECK_INTERVAL_MS = 1000` |
| file stability 300ms | `cronScheduler.ts:41` | chokidar `awaitWriteFinish` |
| lock probe 5000ms | `cronScheduler.ts:44` | 非 owner session 探测 lock 间隔 |
| bg-daemon 第一次 dispatch 才 IPC | `utils/daemon/mailbox.ts:109-112` | 短路未用 bg tool 的 REPL |
| clientId 进程级持久 | `utils/daemon/mailbox.ts:99-105` | `cachedClientId`,进程死则重置 |
| `lastInboxAckThrough` 防重放 | `utils/daemon/inboxSection.ts:39-84` | 每次 buildInboxSystemReminder 更新 |
| `INLINE_NOTIFICATION_MODES` | `attachments.ts:1136` | `{ 'prompt', 'task-notification' }` |
| `isQueuedCommandEditable` | `messageQueueManager.ts:370` | `isPromptInputModeEditable && !isMeta` |
| `resetCommandQueue` 仅测试用 | `messageQueueManager.ts:344` | 生产代码无调用 |
| `popAllEditable` UP 键逻辑 | `messageQueueManager.ts:439` | editable 弹出拼接,非 editable 保留 |
| permission 文件 | `~/.zai/teams/{team}/inboxes/{agent}.json` | JSON 数组(不是 jsonl) |
| queue 持久化 | `~/.zai/projects/<project>/queue_operations.json` | replay 时重建 |

---

## 13. 调试速查表

### 13.1 问题诊断 → 看哪里

| 问题 | 排查路径 |
|---|---|
| 用户输入没被消费 | `REPL.tsx:3432 onSubmit` → `handlePromptSubmit.ts:127` → `executeUserInput` → `onQuery` |
| 后台 bash 完成,模型没看到(turn 活跃) | 检查 `LocalShellTask.tsx:192` priority 是否被改;`query.ts:2671` sleepRan 是否 true |
| 子 agent 完成,主线程 REPL 没看到 | **预期行为**——主线程 filter `agentId === undefined`,子 agent 通知**不会**到主线程 |
| 子 agent 完成,子 agent 自己的 REPL 没看到 | 检查子 agent querySource 是否 `'sdk'`,isMainThread 路径是否被覆盖 |
| turn idle 时通知没消费 | `useQueueProcessor.ts:48` useEffect 触发条件;`queueProcessor.ts:52` processQueueIfReady filter |
| teammate 消息没收到 | `useInboxPoller.ts:107` 1000ms tick;`~/.zai/teams/{team}/inboxes/{agent}.json` 文件权限 |
| cron 任务没触发 | `cronScheduler.ts:40` CHECK_INTERVAL_MS;`recurringMaxAgeMs` 是否过期;`isKilled()` GrowthBook flag |
| permission request 没弹窗 | `useInboxPoller.ts:356-363` `sendNotification`;`focusedInputDialog` 阻塞 |
| inbox 文件损坏 | `~/.zai/teams/{team}/inboxes/{agent}.json`;`readMailbox` 容错 |

### 13.2 添加新新消息类型 checklist

1. **`enqueuePendingNotification` 调用方**:用 `commandQueue.push` 走默认 priority `'later'`(如需立即,显式传 `'next'`)
2. **filter 决策**:
   - 想要 mid-turn 消费:`priority: 'next'` 或 ` sleepRan=true` 时 `'later'`
   - 想要 turn idle 消费:任意 priority
   - 子 agent 路由:加 `agentId` 字段
3. **附件转换**:`getQueuedCommandAttachments` 已支持 `task-notification` / `prompt` 两种 mode;新 mode 需更新 `INLINE_NOTIFICATION_MODES`
4. **生命周期追踪**:传 `uuid` 让 `notifyCommandLifecycle` 能上报 started/completed
5. **持久化**:`enqueue` / `dequeue` 自动通过 `logOperation` 写 `queue_operations.json`
6. **busy vs idle**:useQueueProcessor 已处理;新 mode 默认走批量路径(如需单条,加 `isSlashCommand` 或 `mode === 'bash'`)

### 13.3 关键文件索引(速查)

| 主题 | 路径 |
|---|---|
| 主循环 | `opencc-src/query.ts:628-2827` |
| 中转状态机 | `opencc-src/utils/QueryGuard.ts`(762 行) |
| 队列管理 | `opencc-src/utils/messageQueueManager.ts`(559 行) |
| 命令处理器 | `opencc-src/utils/queueProcessor.ts:52-87` |
| React 订阅 hook | `opencc-src/hooks/useQueueProcessor.ts` |
| 附件转换 | `opencc-src/utils/attachments.ts:1136, 3260, 3524` |
| 提问链 | `opencc-src/screens/REPL.tsx:3432, 3109, 2915` |
| 输入分发 | `opencc-src/utils/handlePromptSubmit.ts:127, 404` |
| 命令类型 | `opencc-src/types/textInputTypes.ts:301-372` |
| Teammate inbox | `opencc-src/hooks/useInboxPoller.ts`(约 1000 行) |
| 跨 session mailbox | `opencc-src/hooks/useMailboxBridge.ts:12-23` |
| Mailbox 实例 | `opencc-src/utils/mailbox.ts` |
| Mailbox context | `opencc-src/context/mailbox.tsx` |
| 定时调度 | `opencc-src/utils/cronScheduler.ts`(300 行) |
| Scheduled hook | `opencc-src/hooks/useScheduledTasks.ts` |
| vendor bg-daemon mailbox | `opencc-src/utils/daemon/mailbox.ts` |
| vendor bg-daemon inbox | `opencc-src/utils/daemon/inboxSection.ts` |
| pre-API reminder 注册点 | `opencc-src/utils/daemon/preApiCallReminders.ts` |
| 主入口暴露面 | `opencc-src/utils/bundle-entry.ts` |

---

## 14. 子报告索引

| Agent ID | 切面 | 关键产出 |
|---|---|---|
| `ad907c831d03544fe` | messageQueueManager 深度 | 559 行文件完整解析 + 23+ 个调用方 + QueuedCommand 类型 |
| `abeae026b7cb613c8` | query.ts mid-turn drain + queueProcessor 深度 | query.ts:2600-2827 主循环 + 8 种 turn 终止 reason + 完整附件转换链 + 5 个 trace |
| `a71def0f88788bc8a` | useInboxPoller / useMailboxBridge / cronScheduler 深度 | 4 套异步机制 + 4 个 trace + vendor bg-daemon + zai hook |
| `a6fcf464853b4cb77` | vendor 后台任务完整路径 | 16 类消息来源 + 5 个消费者对照表 |

每条结论可追到对应 agent 的子报告(子报告输出文件在 task output 中)。

---

## 文档元信息

- **路径**:`docs/2026-09-06-vendor-message-system.md`
- **编写日期**:2026-09-06
- **覆盖版本**:`opencc-web` 当前 HEAD(opencc vendor 0.20.0 + zai 兼容垫片)
- **调研方法**:4 个独立 Explore agent 并行 + 主对话综合交叉验证,每个 agent 完整读完关键文件全文(不是 grep 摘要)
- **数据源**:13 个关键文件全文(共约 5000+ 行代码)
- **维护建议**:vendor `query.ts` / `messageQueueManager.ts` / `useInboxPoller.ts` 大改时,需重跑四个 agent 并更新本文档对应章节