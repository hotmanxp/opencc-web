# zai Session Inbox 机制实施计划(DSH 对齐版)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**状态:** 待实施(2026-08-17,rev 3 — 补充 zn-agent-core 改造任务与并发守卫/边界)

**Goal:** 把 zai 的后台子 Agent / 后台任务完成结果回传主对话,从「单一 fire-and-forget `runtime.query()`」重构为 DSH 同构的 **per-session inbox 队列 + 三种投递语义(followup / steer / inject)+ wakeBudget**,并在 **zn-agent-core 侧**补齐 `subagent-report`(mid-run 上报)与 `subagent-control`(send/interrupt/list)两个工具。分工对齐 DSH capability seam:**core 产生/终止消息,server 负责队列与投递**。

**Architecture:**
- **core(zn-agent-core)**：
  - 新增 `__zaiSessionInbox` globalThis bridge(zai server 注入,zai 端绑定 `sessionInbox`),report / 通知消息从 core 投递到 zai 端 inbox;沿用 `agentTaskBridge.ts` 既有 bridge 范式(`__zaiEventBus` / `__zaiBackgroundRuntime`)。
  - 新增 `subagent-report` 工具:注册进 AgentTool 子上下文(`runAgent.ts` 的 allTools 合并点 / `openccToolDefaults`),子 agent 运行中调 `report(output, {delivery})` → bridge → `sessionInbox.followup/inject(parentSessionId, …)`。
  - 新增 `subagent-control` 工具(注册到主对话上下文):`send_message` → `DefaultBackgroundRuntime.sendMessageToTask(taskId, prompt)`(per-task 排队,子 agent 下一轮消费);`interrupt_agent` → `bg.cancel(taskId)`;`list_agents` → `bg.list({parentSessionId})`。
  - `DefaultBackgroundRuntime` 扩展 `sendMessageToTask`。
- **zai server**:
  - 新增 `server/services/sessionInbox.ts`:module-level 单例 `SessionInbox`(nextTurnQ / nextStepQ / wakeBudget 默认 3 / busy)。
  - `routes/agent.ts` 的 `runNextInQueue` 消费顺序:HTTP 用户 prompt 优先 > inbox next-turn;turn 结束 finally 消费 next-step 合并为下一条 prompt。
  - **并发守卫(防并行 turn 事件风暴)**:所有投递入口收敛到 `runNextInQueue` 单消费者通道;`sessionRunning.has` 入口拦截 + 同步段原子性(add 与首个 await 无间隙)+ `isBusy/setBusy/clearRunning` + `wakeBudget`,保证同一 session 主对话 turn 串行。详见 spec「并发守卫与边界」。
  - `SubagentNotifier.handle` 改走 `sessionInbox.followup`;删 `pendingNotifications` / `flushPendingSubagentNotifications` / `inject()`。
  - SSE 链路复用:`runQueryLoop` → `translateRuntimeEvents` → `eventBus.emit()` → `/api/event`。
  - 通知文本格式不变:`renderTaskNotificationMessage()` 原样使用。

**Tech Stack:** TypeScript ^5.6, Node >=20, Vitest ^4.1, Express + SSE(server side), esbuild bundle(core). 无新依赖。

## File Structure

### Create

| 路径 | 职责 |
|------|------|
| `packages/zn-agent-core/src/compat/inboxBridge.ts` | `__zaiSessionInbox` bridge 读写 helper(`deliverInboxMessage` / `tryGetInboxBridge`;无 bridge 时 no-op,对齐 `tryGetBg`) |
| `packages/zn-agent-core/src/compat/inboxBridge.test.ts` | bridge 单测(subscribe/emit、无 bridge 回退) |
| `packages/zn-agent-core/src/compat/tools/opencc/subagentReport.ts` | `subagent_report` 工具定义(对齐 DSH `tool-subagent-report`) |
| `packages/zn-agent-core/test/unit/compat/subagentReport.test.ts` | report 工具单测(schema、delivery 路由、无 bridge no-op) |
| `packages/zn-agent-core/src/compat/tools/opencc/subagentControl.ts` | `subagent_control` 工具(`send_message` / `interrupt_agent` / `list_agents`) |
| `packages/zn-agent-core/test/unit/compat/subagentControl.test.ts` | control 工具单测 |
| `packages/zai/src/server/services/sessionInbox.ts` | `SessionInbox` 单例(followup/steer/inject、队列、wakeBudget、消费) |
| `packages/zai/src/server/services/sessionInbox.test.ts` | 单测(投递语义、busy 降级、预算会计、消费合并、跨 session 隔离) |

### Modify

| 路径 | 改动 |
|------|------|
| `packages/zn-agent-core/src/opencc-src/tools/AgentTool/runAgent.ts` | 子上下文工具注册点挂入 `subagent_report`(allTools 合并区,L714-737 附近;zai patch 风格) |
| `packages/zn-agent-core/src/compat/background/DefaultBackgroundRuntime.ts` | 新增 `sendMessageToTask(taskId, prompt)`:per-task pending prompt 队列,下一轮 `runOne` / attach 下一轮消费 |
| `packages/zn-agent-core/src/compat/tools/index.ts`(或主对话工具装配处) | 把 `subagent_control` 注册进主对话工具集 |
| `packages/zai/src/server/services/agentRuntime.ts` | init 时注入 `__zaiSessionInbox`(绑定到 `sessionInbox`;对齐现有 `__zaiEventBus` 注入 L75) |
| `packages/zai/src/server/services/subagentNotifier.ts` | `handle()` 走 `sessionInbox.followup`;删 `pendingNotifications` / `flushPendingSubagentNotifications` / `inject()` / `__resetSubagentNotifierPendingForTests` |
| `packages/zai/src/server/routes/agent.ts` | `runNextInQueue` 双队列消费 + finally 消费 next-step;删除 finally 里的 `flushPendingSubagentNotifications`(L1353)与 import(L36) |
| `packages/zai/src/server/services/subagentNotifier.test.ts` | 调整 running 守卫用例 → inbox 行为;删 flush 相关断言 |
| `packages/zai/src/server/routes/agent.queue.test.ts` | 补 inbox 消息经 runNextInQueue 消费 + SSE 输出的集成用例 |

## Global Constraints

- **改 core 后必须 `pnpm run build:core`**(AGENTS.md 强制):`packages/zn-agent-core/` 改动后,zai 进程通过 `node_modules/@zn-ai/zn-agent-core/` 加载,`dist/opencc-core.mjs` 是 esbuild bundle,不重建不会生效。**Task 7 之前所有涉及 core 的验证都以 build:core 为准**。
- **单测用路径过滤**:`pnpm --filter @zn-ai/zai test <path>` 或 `pnpm --filter @zn-ai/zn-agent-core test <path>`,不跑全量。
- **真实浏览器验收**(必须):完成后用 `/ego-browser` skill 走通「子代理完成 / mid-run report 后主对话收到通知且 UI 流式渲染」。zai 正式服务在 920x,验收用独立 `--port 8101`,**不要 kill 920x 端口所在进程**。
- **bridge 范式**:core → server 一律走 globalThis bridge(`__zaiSessionInbox`),不要 import zai server 模块(esbuild 单文件 bundle 会内联成私有实例,事件到不了 SSE —— `agentTaskBridge.ts:13-19` 注释已踩过)。
- **数据路径不可变**:`<task-notification>` 渲染文本(`renderTaskNotificationMessage`)不变;SSE event schema 不变。
- **运行中守卫语义保留**:后台通知不得与主线 query 并行;原「busy 暂存」由 inbox 降级入队承担。
- **消费优先级**:HTTP 用户 prompt 优先于 inbox next-turn。
- **单 session 边界**:本次 inbox 按主 sessionId 组织;子 agent 仍复用父 sessionId(**不引入**独立子会话/独立 inbox)。
- BashNotifier **不在**本次范围。
- commit message:`<type>(<scope>): <subject>`,中文优先。本仓库无 git remote,仅本地 commit,**不 push**。

---

## Task 1: core side — inbox bridge(`__zaiSessionInbox`)

**Files:**
- Create: `packages/zn-agent-core/src/compat/inboxBridge.ts`
- Create: `packages/zn-agent-core/src/compat/inboxBridge.test.ts`

**Interfaces:**
- Consumes: nothing(core 侧零依赖;bridge 由 zai server 注入)
- Produces:
  - `export interface InboxBridgeLike { followup(sessionId, msg): void; inject(sessionId, msg): void; steer?(sessionId, msg): void }`
  - `export function deliverInboxMessage(opts: { parentSessionId: string; content: string; delivery: 'wakeup' | 'quiet'; source: {...} }): boolean` — 通过 `globalThis.__zaiSessionInbox` 投递;无 bridge 返回 false(调用方 no-op)
  - `export function tryGetInboxBridge(): InboxBridgeLike | null` — 测试 seam

- [ ] **Step 1: Write the failing test**

```ts
// packages/zn-agent-core/src/compat/inboxBridge.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { deliverInboxMessage, tryGetInboxBridge } from './inboxBridge'

const FAKE = '__zaiSessionInbox'

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[FAKE]
})

describe('inboxBridge', () => {
  it('有 bridge 时投递 followup(wakeup)', () => {
    const calls: unknown[] = []
    ;(globalThis as Record<string, unknown>)[FAKE] = {
      followup: (sid: string, msg: unknown) => calls.push(['followup', sid, msg]),
      inject: (sid: string, msg: unknown) => calls.push(['inject', sid, msg]),
    }
    const ok = deliverInboxMessage({
      parentSessionId: 's1',
      content: 'hello',
      delivery: 'wakeup',
      source: { kind: 'test', form: 'notice' },
    })
    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('followup')
    expect(calls[0][1]).toBe('s1')
    expect((calls[0][2] as { content: string }).content).toBe('hello')
  })

  it('quiet → inject', () => {
    const calls: unknown[] = []
    ;(globalThis as Record<string, unknown>)[FAKE] = {
      followup: (..._: unknown[]) => calls.push(['followup']),
      inject: (..._: unknown[]) => calls.push(['inject']),
    }
    deliverInboxMessage({ parentSessionId: 's1', content: 'x', delivery: 'quiet', source: {} as never })
    expect(calls).toEqual([['inject']])
  })

  it('无 bridge 返回 false 且不抛', () => {
    expect(tryGetInboxBridge()).toBeNull()
    expect(
      deliverInboxMessage({ parentSessionId: 's1', content: 'x', delivery: 'wakeup', source: {} as never }),
    ).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @zn-ai/zn-agent-core test src/compat/inboxBridge.test.ts
```
Expected: FAIL — `Cannot find module './inboxBridge'`。

- [ ] **Step 3: Implement inboxBridge.ts**

```ts
// packages/zn-agent-core/src/compat/inboxBridge.ts
/**
 * zai server → 子 agent 运行环境(bundle 内)的 inbox 投递桥。
 *
 * 为什么用 globalThis(zai patch,对齐 agentTaskBridge):
 *   opencc-src/server 的 bundle 由 esbuild 单文件打包,import zai server 的
 *   sessionInbox 会把该模块内联成 bundle 私有实例,与 zai server 用的不是
 *   同一个 —— 事件到不了主对话。zai server 在 init 时把真实的
 *   sessionInbox.followup/inject 注入 `globalThis.__zaiSessionInbox`。
 *   纯 zn-agent-core 单测 / vendor CLI 直跑时无桥 → 返回 false,调用方 no-op。
 */
export interface InboxMessageLike {
  id: string
  source: { kind: string; form: string; senderSessionId?: string; agentType?: string; [k: string]: unknown }
  content: string
  createdAt: number
}

export interface InboxBridgeLike {
  followup(sessionId: string, msg: InboxMessageLike): void
  inject(sessionId: string, msg: InboxMessageLike): void
}

export function tryGetInboxBridge(): InboxBridgeLike | null {
  const v = (globalThis as { __zaiSessionInbox?: InboxBridgeLike }).__zaiSessionInbox
  return v ?? null
}

/** core 侧统一投递入口。返回是否真的投出(无 bridge → false)。 */
export function deliverInboxMessage(opts: {
  parentSessionId: string
  senderSessionId: string
  content: string
  delivery: 'wakeup' | 'quiet'
  source: { kind: string; form: string; agentType?: string }
}): boolean {
  const bridge = tryGetInboxBridge()
  if (!bridge) return false
  const msg: InboxMessageLike = {
    id: `${opts.source.kind}-${Date.now()}`,
    source: { ...opts.source, senderSessionId: opts.senderSessionId },
    content: opts.content,
    createdAt: Date.now(),
  }
  if (opts.delivery === 'wakeup') bridge.followup(opts.parentSessionId, msg)
  else bridge.inject(opts.parentSessionId, msg)
  return true
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @zn-ai/zn-agent-core test src/compat/inboxBridge.test.ts
```
Expected: PASS — 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/zn-agent-core/src/compat/inboxBridge.ts \
        packages/zn-agent-core/src/compat/inboxBridge.test.ts
git commit -m "feat(zn-agent-core): inbox bridge(__zaiSessionInbox)

core↔server 新增 globalThis 桥,投递 followup/inject 到 zai 端
sessionInbox;无桥环境返回 false 静默 no-op(对齐 agentTaskBridge
tryGetBg 回退风格)。"
```

---

## Task 2: core side — subagent-report 工具

**Files:**
- Create: `packages/zn-agent-core/src/compat/tools/opencc/subagentReport.ts`
- Create: `packages/zn-agent-core/test/unit/compat/subagentReport.test.ts`
- Modify: `packages/zn-agent-core/src/opencc-src/tools/AgentTool/runAgent.ts`(注册进子上下文)

**Interfaces:**
- Consumes: `deliverInboxMessage` from `../../inboxBridge.js`
- Produces: `subagentReportTool: Tool` — schema `{ output: string; delivery?: 'wakeup'|'quiet' }`;execute 从子上下文取 `parentSessionId`(优先子上下文注入,回退 `__zaiCurrentSessionId` bridge),调 `deliverInboxMessage`

**注意**:`subagent_report` 在 esbuild bundle 内,import compat 模块会被内联 —— 与 `agentTaskBridge` 同款约束,但 `deliverInboxMessage` 读 globalThis,不存在实例隔离问题(读取方只要在同一 bundle 即可,注入方在 zai server 进程,sid/followup 经绑定函数进入真实 sessionInbox)。

- [ ] **Step 1: Write the failing test**

```ts
// packages/zn-agent-core/test/unit/compat/subagentReport.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { subagentReportTool } from '../../src/compat/tools/opencc/subagentReport'

const FAKE = '__zaiSessionInbox'
const SID = '__zaiCurrentSessionId'

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[FAKE]
  delete (globalThis as Record<string, unknown>)[SID]
})

function installBridge(calls: unknown[]) {
  ;(globalThis as Record<string, unknown>)[FAKE] = {
    followup: (...a: unknown[]) => calls.push(['followup', ...a]),
    inject: (...a: unknown[]) => calls.push(['inject', ...a]),
  }
}

describe('subagent_report', () => {
  it('schema 包含 output 必填 + delivery 枚举', () => {
    const params = (subagentReportTool as unknown as { parameters: unknown }).parameters
    expect(params).toBeTruthy()
  })

  it('wakeup → followup 到父 session(经 __zaiCurrentSessionId)', async () => {
    ;(globalThis as Record<string, unknown>)[SID] = 'parent-1'
    const calls: unknown[] = []
    installBridge(calls)
    const execute = (subagentReportTool as unknown as { execute: (...a: unknown[]) => Promise<unknown> }).execute
    const res = await execute({ output: 'progress', delivery: 'wakeup' }, {})
    expect(res).toMatchObject({ delivered: true })
    expect(calls[0][0]).toBe('followup')
    expect(calls[0][1]).toBe('parent-1')
    expect((calls[0][3] as { content: string }).content).toContain('progress')
  })

  it('quiet → inject', async () => {
    ;(globalThis as Record<string, unknown>)[SID] = 'parent-1'
    const calls: unknown[] = []
    installBridge(calls)
    const execute = (subagentReportTool as unknown as { execute: (...a: unknown[]) => Promise<unknown> }).execute
    await execute({ output: 'note', delivery: 'quiet' }, {})
    expect(calls[0][0]).toBe('inject')
  })

  it('无 bridge 不抛,返回 delivered:false', async () => {
    ;(globalThis as Record<string, unknown>)[SID] = 'parent-1'
    const execute = (subagentReportTool as unknown as { execute: (...a: unknown[]) => Promise<unknown> }).execute
    const res = await execute({ output: 'x', delivery: 'wakeup' }, {})
    expect(res).toMatchObject({ delivered: false })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @zn-ai/zn-agent-core test test/unit/compat/subagentReport.test.ts
```
Expected: FAIL — module not found。

- [ ] **Step 3: Implement subagentReport.ts**

```ts
// packages/zn-agent-core/src/compat/tools/opencc/subagentReport.ts
/**
 * subagent_report — 子 agent 主动向父 agent 上报(对齐 DSH tool-subagent-report)。
 * 注册进 AgentTool 子上下文(runAgent.ts allTools 合并点);parentSessionId
 * 优先取子上下文注入值,回退 __zaiCurrentSessionId bridge。
 */
import { deliverInboxMessage } from '../../inboxBridge.js'

export const subagentReportTool = {
  name: 'subagent_report',
  description: '报告当前子任务的进度或移交结果给父 agent。',
  parameters: {
    output: { type: 'string', required: true, description: '上报给父 agent 的内容。' },
    delivery: {
      type: 'string',
      enum: ['wakeup', 'quiet'],
      default: 'wakeup',
      description: 'wakeup:父空闲则开新 turn;quiet:合并到父的下一次交互。',
    },
  },
  async execute(
    input: { output: string; delivery?: 'wakeup' | 'quiet' },
    // 结构类型:子上下文会带 parentSessionId(实现时以 runAgent 实际注入为准)
    context: { parentSessionId?: string },
  ): Promise<{ delivered: boolean }> {
    const delivery = input.delivery ?? 'wakeup'
    const senderSessionId =
      (globalThis as { __zaiCurrentSessionId?: string }).__zaiCurrentSessionId ?? ''
    const parent = context.parentSessionId ?? senderSessionId
    if (!parent) return { delivered: false }
    const ok = deliverInboxMessage({
      parentSessionId: parent,
      senderSessionId,
      content: input.output,
      delivery,
      source: { kind: 'subagent', form: 'report' },
    })
    return { delivered: ok }
  },
}
```

- [ ] **Step 4: 挂入 runAgent.ts 子上下文工具合并点**

Read `packages/zn-agent-core/src/opencc-src/tools/AgentTool/runAgent.ts` L700-780(allTools 合并 + createSubagentContext),在合并数组里追加 `subagentReportTool`(zai patch,注释说明对齐 DSH tool-subagent-report)。若 `openccToolDefaults` 是更合适的主装配点,以该文件现有工具清单结构为准。

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @zn-ai/zn-agent-core test test/unit/compat/subagentReport.test.ts
```
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/zn-agent-core/src/compat/tools/opencc/subagentReport.ts \
        packages/zn-agent-core/test/unit/compat/subagentReport.test.ts \
        packages/zn-agent-core/src/opencc-src/tools/AgentTool/runAgent.ts
git commit -m "feat(zn-agent-core): subagent_report 工具(DSH 对齐)

子 agent 运行中可主动向父上报(wakeup→followup / quiet→inject),
经 inboxBridge 投递到 zai 端 sessionInbox;注册进 AgentTool 子上下文
allTools 合并点。"
```

---

## Task 3: core side — subagent-control + DefaultBackgroundRuntime.sendMessageToTask

**Files:**
- Create: `packages/zn-agent-core/src/compat/tools/opencc/subagentControl.ts`
- Create: `packages/zn-agent-core/test/unit/compat/subagentControl.test.ts`
- Modify: `packages/zn-agent-core/src/compat/background/DefaultBackgroundRuntime.ts`(`sendMessageToTask`)

**Interfaces:**
- Consumes: `BackgroundRuntime`(`compat/background/BackgroundRuntime.ts`)与 `tryGetBg` 风格回退(复用 `agentTaskBridge.ts` 的 globalThis 读法或模块 registry)
- Produces:
  - `subagentControlTool: Tool` — `send_message` / `interrupt_agent` / `list_agents`;执行经 `__zaiBackgroundRuntime` bridge 调 `bg.sendMessageToTask(id, prompt)` / `bg.cancel(id)` / `bg.list({parentSessionId})`
  - `DefaultBackgroundRuntime.sendMessageToTask(taskId: string, prompt: string): Promise<{ ok: boolean }>` — per-task pending 队列;下一轮 `runOne` 时拼到 query prompt 前缀

- [ ] **Step 1: 在 DefaultBackgroundRuntime 加 pending 队列字段 + sendMessageToTask**

Read `DefaultBackgroundRuntime.ts`(已核实全文,records/queue/scheduleNext/runOne)。新增:

```ts
// 每条运行中/排队任务的 pending prompt 队列(父→子 control,send_message)
private readonly taskInbox = new Map<string, string[]>()

async sendMessageToTask(taskId: string, prompt: string): Promise<{ ok: boolean }> {
  const rec = this.records.get(taskId)
  if (!rec) return { ok: false }
  if (isTerminal(rec.task.status)) return { ok: false } // 终态后 no-op(幂等)
  const list = this.taskInbox.get(taskId) ?? []
  list.push(prompt)
  this.taskInbox.set(taskId, list)
  return { ok: true }
}
```

并在 `runOne` 的 queryInput 构造处消费:

```ts
const pending = this.taskInbox.get(id) ?? []
const prompt = pending.length > 0
  ? pending.join('\n\n') + '\n\n' + rec.task.input.prompt
  : rec.task.input.prompt
const queryInput = {
  sessionId: rec.task.parentSessionId ?? `bg-${id}`,
  prompt,
  ...
}
```

- [ ] **Step 2: Write the failing test for sendMessageToTask**

```ts
// packages/zn-agent-core/test/unit/compat/background/sendMessageToTask.test.ts
// 断言:attach 登记后 sendMessageToTask 入队;runOne 消费(prompt 前缀含消息);
// 终态后 sendMessageToTask 返回 ok:false。构造方式:与现有
// DefaultBackgroundRuntime 单测一致的 fake AgentRuntime + 内存 TaskStore。
```

(实现时以仓库既有 `DefaultBackgroundRuntime` 测试基建为准,若已有测试文件则追加 describe。)

- [ ] **Step 3: 实现 subagentControl.ts**

```ts
// packages/zn-agent-core/src/compat/tools/opencc/subagentControl.ts
/**
 * subagent_control — 父 agent 控制后台子 agent(对齐 DSH tool-subagent-control)。
 *   send_message:  → bg.sendMessageToTask(子 agent 下一轮消费)
 *   interrupt_agent: → bg.cancel(taskId)(仅中止当前轮,幂等)
 *   list_agents:    → bg.list({ parentSessionId })
 */
export const subagentControlTool = {
  name: 'subagent_control',
  description: '向后台子 agent 发消息、中止或列举。',
  parameters: {
    action: { type: 'string', enum: ['send_message', 'interrupt_agent', 'list_agents'], required: true },
    task_id: { type: 'string', description: 'send_message / interrupt_agent 必填。' },
    message: { type: 'string', description: 'send_message 必填。' },
  },
  async execute(input, context) {
    // 经 __zaiBackgroundRuntime bridge 拿 bg(对齐 agentTaskBridge.tryGetBg)
    if (input.action === 'send_message') {
      return { ok: (await bg.sendMessageToTask(input.task_id, input.message)).ok }
    }
    if (input.action === 'interrupt_agent') {
      const res = await bg.cancel(input.task_id)
      return { ok: res.ok }
    }
    const tasks = await bg.list({ parentSessionId: /* 当前 session */ })
    return { agents: tasks.map(t => ({ id: t.id, status: t.status, description: t.description })) }
  },
}
```

- [ ] **Step 4: 挂入主对话工具集(compat/tools 装配处)**

以 `packages/zn-agent-core/src/compat/tools/index.ts`(`buildDefaultTools`)为准,把 `subagentControlTool` 追加进主对话工具列表(zai patch + 注释)。

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @zn-ai/zn-agent-core test test/unit/compat/subagentControl.test.ts \
  test/unit/compat/background/sendMessageToTask.test.ts
```
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/zn-agent-core/src/compat/tools/opencc/subagentControl.ts \
        packages/zn-agent-core/test/unit/compat/subagentControl.test.ts \
        packages/zn-agent-core/src/compat/background/DefaultBackgroundRuntime.ts
git commit -m "feat(zn-agent-core): subagent_control 工具 + sendMessageToTask

send_message 经 DefaultBackgroundRuntime 新 per-task pending 队列投递
(子 agent 下一轮消费);interrupt_agent 复用 cancel(幂等);
list_agents 复用 list({parentSessionId})。对齐 DSH
tool-subagent-control 三件套。"
```

---

## Task 4: zai side — SessionInbox 实现 + 单测

**Files:**
- Create: `packages/zai/src/server/services/sessionInbox.ts`
- Create: `packages/zai/src/server/services/sessionInbox.test.ts`

**Interfaces:**
- Consumes: nothing(零依赖';bridge 在 Task 7 注入)
- Produces:
  - `type InboxDelivery = 'wakeup' | 'quiet'`
  - `interface InboxMessage`(与 spec 一致)
  - `class SessionInbox` — `setWakeHandler` / `followup` / `steer` / `inject` / `consumeNextTurn` / `consumeNextStep` / `peekNextTurnCount` / `isBusy` / `setBusy` / `clearRunning` / `resetWakeBudget`
  - `export const sessionInbox = new SessionInbox()`

- [ ] **Step 1: Write the failing test**

```ts
// packages/zai/src/server/services/sessionInbox.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { SessionInbox, type InboxMessage } from './sessionInbox'

function msg(id: string): InboxMessage {
  return { id, source: { kind: 'test', form: 'notice' }, content: `content-${id}`, createdAt: 1 }
}

describe('SessionInbox', () => {
  let inbox: SessionInbox
  let woken: string[]
  beforeEach(() => {
    inbox = new SessionInbox()
    woken = []
    inbox.setWakeHandler((sid) => woken.push(sid))
  })

  it('followup: idle + 预算内 → 入 next-turn 并唤醒', () => {
    inbox.followup('s1', msg('a'))
    expect(woken).toEqual(['s1'])
    expect(inbox.consumeNextTurn('s1')?.id).toBe('a')
    expect(inbox.consumeNextTurn('s1')).toBeNull()
  })

  it('followup: busy → 不唤醒,降级入 next-step', () => {
    inbox.setBusy('s1')
    inbox.followup('s1', msg('a'))
    expect(woken).toEqual([])
    expect(inbox.consumeNextTurn('s1')).toBeNull()
    expect(inbox.consumeNextStep('s1').map((m) => m.id)).toEqual(['a'])
  })

  it('inject: 永不唤醒,只入 next-step', () => {
    inbox.inject('s1', msg('a'))
    inbox.inject('s1', msg('b'))
    expect(woken).toEqual([])
    expect(inbox.consumeNextStep('s1').map((m) => m.id)).toEqual(['a', 'b'])
    expect(inbox.consumeNextStep('s1')).toEqual([])
  })

  it('steer: idle + 预算内 → 入 next-step 并唤醒', () => {
    inbox.steer('s1', msg('a'))
    expect(woken).toEqual(['s1'])
    expect(inbox.consumeNextStep('s1').map((m) => m.id)).toEqual(['a'])
  })

  it('wakeBudget: 默认 3 后 followup 不再唤醒(先 busy 消耗一轮)', () => {
    inbox.setBusy('s1')
    inbox.followup('s1', msg('a'))  // busy,不耗预算
    inbox.clearRunning('s1')
    inbox.followup('s1', msg('1'))
    inbox.followup('s1', msg('2'))
    inbox.followup('s1', msg('3'))
    expect(woken.length).toBe(3)
    inbox.followup('s1', msg('4'))   // 预算耗尽:入队不唤醒
    expect(woken.length).toBe(3)
    expect(inbox.peekNextTurnCount('s1')).toBe(4)
  })

  it('resetWakeBudget: 用户人工输入后预算恢复', () => {
    inbox.followup('s1', msg('1'))
    inbox.followup('s1', msg('2'))
    inbox.followup('s1', msg('3'))
    inbox.resetWakeBudget('s1')
    inbox.followup('s1', msg('4'))
    expect(woken.length).toBe(4)
  })

  it('clearRunning: 清 busy 并重置预算', () => {
    inbox.setBusy('s1')
    inbox.followup('s1', msg('a'))
    expect(inbox.isBusy('s1')).toBe(true)
    inbox.clearRunning('s1')
    expect(inbox.isBusy('s1')).toBe(false)
    inbox.followup('s1', msg('b'))
    expect(woken.length).toBe(1)
  })

  it('跨 session 隔离', () => {
    inbox.inject('s1', msg('a1'))
    inbox.inject('s2', msg('b1'))
    expect(inbox.consumeNextStep('s1').map((m) => m.id)).toEqual(['a1'])
    expect(inbox.consumeNextStep('s2').map((m) => m.id)).toEqual(['b1'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @zn-ai/zai test src/server/services/sessionInbox.test.ts
```
Expected: FAIL — module not found。

- [ ] **Step 3: Implement sessionInbox.ts**

```ts
// packages/zai/src/server/services/sessionInbox.ts
/**
 * SessionInbox — per-session 后台消息投递队列(移植自 DSH agent-loop 的 inbox)。
 *
 * 语义(对齐 DSH packages/core/agent-loop/src/agent.ts:113-132):
 *   followup = next-turn lane + wake(idle 且预算内)
 *   steer    = next-step lane + wake
 *   inject   = next-step lane,不唤醒
 * busy 时 followup 自动降级入 next-step(不打扰主线),turn 结束后由
 * consumeNextStep 合并为下一条 prompt —— 对齐 DSH「busy owner 被 inject,
 * settle 一起 cost 一步」的 intent。wakeBudget(默认 3)防止后台连环唤醒;
 * 用户人工输入(turn 结束)经 resetWakeBudget / clearRunning 恢复预算。
 */
export type InboxDelivery = 'wakeup' | 'quiet'

export interface InboxMessage {
  id: string
  source: {
    kind: string
    form: string
    senderSessionId?: string
    agentType?: string
    [k: string]: unknown
  }
  content: string
  createdAt: number
}

interface InboxLanes {
  nextTurn: InboxMessage[]
  nextStep: InboxMessage[]
}

export interface InboxWakeHandler {
  (sessionId: string): void
}

export const DEFAULT_WAKE_BUDGET = 3

export class SessionInbox {
  private readonly lanes = new Map<string, InboxLanes>()
  private readonly busy = new Set<string>()
  private readonly wakeBudget = new Map<string, number>()
  private wakeHandler: InboxWakeHandler = () => {}

  setWakeHandler(handler: InboxWakeHandler): void {
    this.wakeHandler = handler
  }

  followup(sessionId: string, msg: InboxMessage): void {
    if (this.busy.has(sessionId)) {
      this.lanesFor(sessionId).nextStep.push(msg)
      return
    }
    this.lanesFor(sessionId).nextTurn.push(msg)
    this.wakeIfBudgeted(sessionId)
  }

  steer(sessionId: string, msg: InboxMessage): void {
    this.lanesFor(sessionId).nextStep.push(msg)
    if (this.busy.has(sessionId)) return
    this.wakeIfBudgeted(sessionId)
  }

  inject(sessionId: string, msg: InboxMessage): void {
    this.lanesFor(sessionId).nextStep.push(msg)
  }

  consumeNextTurn(sessionId: string): InboxMessage | null {
    const m = this.lanesFor(sessionId).nextTurn.shift() ?? null
    this.gc(sessionId)
    return m
  }

  consumeNextStep(sessionId: string): InboxMessage[] {
    const lanes = this.lanesFor(sessionId)
    const out = lanes.nextStep
    lanes.nextStep = []
    this.gc(sessionId)
    return out
  }

  peekNextTurnCount(sessionId: string): number {
    return this.lanesFor(sessionId).nextTurn.length
  }

  isBusy(sessionId: string): boolean {
    return this.busy.has(sessionId)
  }

  setBusy(sessionId: string): void {
    this.busy.add(sessionId)
  }

  clearRunning(sessionId: string): void {
    this.busy.delete(sessionId)
    this.wakeBudget.delete(sessionId)
  }

  resetWakeBudget(sessionId: string): void {
    this.wakeBudget.delete(sessionId)
  }

  private wakeIfBudgeted(sessionId: string): void {
    const spent = this.wakeBudget.get(sessionId) ?? 0
    if (spent >= DEFAULT_WAKE_BUDGET) return
    this.wakeBudget.set(sessionId, spent + 1)
    try {
      this.wakeHandler(sessionId)
    } catch (err) {
      console.warn('[SessionInbox] wake handler threw:', err)
    }
  }

  private lanesFor(sessionId: string): InboxLanes {
    let lanes = this.lanes.get(sessionId)
    if (!lanes) {
      lanes = { nextTurn: [], nextStep: [] }
      this.lanes.set(sessionId, lanes)
    }
    return lanes
  }

  private gc(sessionId: string): void {
    const lanes = this.lanes.get(sessionId)
    if (lanes && lanes.nextTurn.length === 0 && lanes.nextStep.length === 0) {
      this.lanes.delete(sessionId)
    }
  }
}

export const sessionInbox = new SessionInbox()
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @zn-ai/zai test src/server/services/sessionInbox.test.ts
```
Expected: PASS — 8 tests green。

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/server/services/sessionInbox.ts \
        packages/zai/src/server/services/sessionInbox.test.ts
git commit -m "feat(zai): per-session inbox 队列服务(SessionInbox)

对齐 DSH agent-loop inbox 语义 followup/steer/inject;busy 时降级
next-step;wakeBudget 默认 3;clearRunning/resetWakeBudget 恢复预算。"
```

---

## Task 5: zai side — SubagentNotifier 走 inbox 投递

**Files:**
- Modify: `packages/zai/src/server/services/subagentNotifier.ts`
- Modify: `packages/zai/src/server/services/subagentNotifier.test.ts`

**Interfaces:**
- Consumes: `sessionInbox` / `InboxMessage`
- Produces: `handle(task)` 内部不再直呼 `runtime.query()`;删除 `pendingNotifications` / `flushPendingSubagentNotifications` / `inject()` / `__resetSubagentNotifierPendingForTests` 导出

- [ ] **Step 1: Read current subagentNotifier + 引用点**

Read `subagentNotifier.ts`(已核实全文 L36-237)。Grep `flushPendingSubagentNotifications` / `getSubagentNotifier` / `initSubagentNotifier` / `renderTaskNotificationMessage` / `__setSubagentNotifier` 的全部引用点(预期仅 `routes/agent.ts:36,1353` 引 flush,Task 6 一并删)。

- [ ] **Step 2: 改 handle() 走 sessionInbox**

```ts
import { sessionInbox } from './sessionInbox.js'

async handle(task: BackgroundTask): Promise<void> {
  if (
    task.status !== 'completed' &&
    task.status !== 'failed' &&
    task.status !== 'cancelled'
  ) {
    return
  }
  const parentSessionId = task.parentSessionId
  if (!parentSessionId) return
  if (parentSessionId === 'sess-unknown') return

  // 投递到父 session inbox:主线 busy 时由 SessionInbox 自动降级入
  // next-step lane(原 running 守卫 / flushPendingSubagentNotifications 的替代)。
  try {
    sessionInbox.followup(parentSessionId, {
      id: `bg-${task.id}`,
      source: { kind: 'subagent', form: 'notice', senderSessionId: parentSessionId, agentType: task.agentType },
      content: renderTaskNotificationMessage(task),
      createdAt: Date.now(),
    })
  } catch (err) {
    console.warn('[SubagentNotifier] inbox followup failed:', err)
  }
}
```

同时删除 `pendingNotifications` Map / `flushPendingSubagentNotifications()` / `inject()` / `__resetSubagentNotifierPendingForTests`,并移除不再使用的 import(`getRuntime` / `setCurrentSessionId` / `hasActiveQuery` / `resolveModel` / `translateRuntimeEvents` / `eventBus`,以实际剩余导出为准)。

- [ ] **Step 3: 调整测试**

删 `pendingNotifications` / `flush` / `__resetSubagentNotifierPendingForTests` / `hasActiveQuery` 相关断言;新增(用 `vi.mock('./sessionInbox.js')` 断言 `followup` 收到正确 `content` + busy 降级已在 Task 4 单测覆盖,不重复)。

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @zn-ai/zai test \
  src/server/services/subagentNotifier.test.ts \
  src/server/services/sessionInbox.test.ts
```
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/server/services/subagentNotifier.ts \
        packages/zai/src/server/services/subagentNotifier.test.ts
git commit -m "refactor(zai): SubagentNotifier 改走 SessionInbox 投递

handle() 不再 fire-and-forget 直呼 runtime.query();busy 守卫语义由
inbox 降级承担;删 pendingNotifications / flushPendingSubagentNotifications
/ inject()。通知文本(renderTaskNotificationMessage)不变。"
```

---

## Task 6: zai side — agent 调度器双队列消费 + bridge 注入

**Files:**
- Modify: `packages/zai/src/server/routes/agent.ts`
- Modify: `packages/zai/src/server/services/agentRuntime.ts`(注入 `__zaiSessionInbox`)
- Modify: `packages/zai/src/server/routes/agent.queue.test.ts`

**Interfaces:**
- Consumes: `sessionInbox`
- Produces:
  - `runNextInQueue`:HTTP 队列优先 > inbox next-turn;finally `clearRunning` + `consumeNextStep` 合并下一条;用户人工 prompt 入队时 `resetWakeBudget`
  - `agentRuntime.ts` init 时 `(globalThis as any).__zaiSessionInbox = { followup, inject }`(绑定 sessionInbox;对齐 `__zaiEventBus` 注入 L75)
  - `runQueryLoop` finally 删 `flushPendingSubagentNotifications`(L1353)+ import(L36)

- [ ] **Step 1: 写失败测试(追加 agent.queue.test.ts)**

```ts
describe('INBOX: runNextInQueue 消费', () => {
  it('inbox next-turn 在无 HTTP 队列时被消费为一条 prompt', async () => { /* … */ })
  it('HTTP prompt 优先于 inbox next-turn', async () => { /* … */ })
  it('turn 结束后 next-step 合并为下一条 prompt', async () => { /* … */ })
})

// ★ 并发守卫(防"并行 turn 事件风暴",spec「并发守卫与边界」)
// 两次 followup 同 tick 触发 → 只起一个 turn;第二次被 sessionRunning.has 拦截,
// 第二条消息排入 next-turn 队列,等上一 turn 结束后由 finally 的 re-run 消费。
// 断言 eventBus 上本 sid 的 runtime.started 只出现一次(复用真 TCP 基建)。
describe('INBOX: 并发守卫', () => {
  it('同一 tick 两次 followup 只起单 turn,第二条作为下一轮消费', async () => {
    // 1) sessionInbox.followup(sid, msgA) 与 sessionInbox.followup(sid, msgB) 同步连调
    // 2) 断言 runtime.started(或首个 user prompt 消费)恰好 1 次
    // 3) 等待 turn 结束后,断言第二条消息被消费(transcript 出现两条 user 消息)
  })
})
```

(为可测,`routes/agent.ts` 需暴露 wake handler 注册点 —— Step 3 的 setWakeHandler 调用天然可测;断言经 eventBus 观察 `runtime.started`/`queue.changed` 事件序列,复用 `agent.queue.test.ts` 既有真 TCP 基建。上一条已存在的 `agent.queue.test.ts` 并发场景用例(sessionRunning 拦截)可参考其断言风格。)

- [ ] **Step 2: Run test — verify fail**

```bash
pnpm --filter @zn-ai/zai test src/server/routes/agent.queue.test.ts
```
Expected: 新用例 FAIL。

- [ ] **Step 3: 实现 runNextInQueue 双队列消费 + wake handler**

```ts
// 替换现有 runNextInQueue(L781-798)
async function runNextInQueue(sid: string): Promise<void> {
  if (sessionRunning.has(sid)) return

  const httpCmd = nextHttpPrompt(sid)
  const inboxMsg = sessionInbox.consumeNextTurn(sid)

  let cmd: PendingPrompt | null
  if (httpCmd) {
    sessionInbox.resetWakeBudget(sid) // 用户人工输入:重置唤醒预算
    cmd = httpCmd
  } else if (inboxMsg) {
    cmd = inboxToPendingPrompt(sid, inboxMsg)
  } else {
    sessionQueues.delete(sid)
    emitQueueChanged(sid)
    return
  }

  sessionRunning.add(sid)
  sessionInbox.setBusy(sid)
  emitQueueChanged(sid)
  try {
    await runQueryLoop(cmd)
  } finally {
    sessionRunning.delete(sid)
    sessionInbox.clearRunning(sid)
    const nextStep = sessionInbox.consumeNextStep(sid)
    if (nextStep.length > 0) {
      enqueueInboxPrompt(sid, mergeInboxMessages(nextStep))
    }
    void runNextInQueue(sid)
  }
}

/** HTTP 队列队首(shift + emitQueueChanged);空则 null。 */
function nextHttpPrompt(sid: string): PendingPrompt | null { /* … */ }

/** inbox 消息 → PendingPrompt(cwd 需从 session 取;缺则 process.cwd 兜底)。 */
function inboxToPendingPrompt(sid: string, msg: InboxMessage): PendingPrompt {
  return { id: msg.id, sessionId: sid, cwd: resolveInboxCwd(sid), prompt: msg.content }
}

/** 多条 next-step 合并为单条 prompt(对齐 DSH steer 批处理)。 */
function mergeInboxMessages(msgs: InboxMessage[]): string {
  return msgs.map((m) => m.content).join('\n\n')
}

/** 合并消息排到队列顶(HTTP 之后、未来输入之前)。 */
function enqueueInboxPrompt(sid: string, prompt: string): void { /* … */ }
```

注册 wake handler(模块 init 区,两函数声明之后同步执行):

```ts
sessionInbox.setWakeHandler((sid) => {
  void runNextInQueue(sid).catch((err) =>
    console.warn('[agent] inbox wake runNextInQueue failed:', err),
  )
})
```

**并发守卫要点(实现时务必保留)**：
- `sessionRunning.add(sid)`(L890)与 `await runQueryLoop(cmd)`(L894)之间**不得插入任何 await** —— 同步段原子性是「同一 tick 二次触发被 `has(sid)` 拦截」的保证(对齐现有 `agent.ts:1441-1443` 注释)。
- finally 里 `sessionRunning.delete` → `clearRunning` → 再次 `void runNextInQueue` 的链路维持单消费者:HTTP enqueue 与 wake 竞争时,只有一个能通过入口守卫。
- 不要在任何位置绕过 `runNextInQueue` 直呼 `runQueryLoop` / `runtime.query()`(旧 `SubagentNotifier.inject` 的教训;busy 降级由 `SessionInbox.followup` 内部完成)。

- [ ] **Step 4: agentRuntime.ts 注入 __zaiSessionInbox**

在 `agentRuntime.ts` 现有 `__zaiEventBus` 注入(L75)旁:

```ts
;(globalThis as any).__zaiSessionInbox = {
  followup: (sid: string, msg: unknown) => sessionInbox.followup(sid, msg as InboxMessage),
  inject: (sid: string, msg: unknown) => sessionInbox.inject(sid, msg as InboxMessage),
}
```

(import `sessionInbox` + `InboxMessage` from `./sessionInbox.js`;确认注入时机早于任何 runQueryLoop,对齐 `__zaiEventBus` 的 init 位置。)

- [ ] **Step 5: 删除 runQueryLoop finally 的 flush 调用与 import**

`routes/agent.ts:1350-1353` 删除 flush 代码块;`L36` 删 `import { flushPendingSubagentNotifications } from "../services/subagentNotifier.js"`。

- [ ] **Step 6: Run test — verify pass**

```bash
pnpm --filter @zn-ai/zai test \
  src/server/routes/agent.queue.test.ts \
  src/server/services/sessionInbox.test.ts
```
Expected: 全绿。

- [ ] **Step 7: Commit**

```bash
git add packages/zai/src/server/routes/agent.ts \
        packages/zai/src/server/services/agentRuntime.ts \
        packages/zai/src/server/routes/agent.queue.test.ts
git commit -m "feat(zai): agent 调度器双队列消费 + __zaiSessionInbox 注入

runNextInQueue 消费顺序 HTTP 用户 prompt > inbox next-turn;turn 结束
finally 消费 next-step 合并为下一条 prompt;inbox 注册为 wake handler。
agentRuntime init 注入 __zaiSessionInbox(core bridge 消费端)。
删除 flushPendingSubagentNotifications 调用与 import。"
```

---

## Task 7: build:core + 回归 + typecheck

**Files:** (none — verification only)

- [ ] **Step 1: Build core(改了 zn-agent-core 必跑)**

```bash
pnpm run build:core
```
Expected: 成功(无 TS / esbuild 错误)。

- [ ] **Step 2: 相关测试全量重跑**

```bash
pnpm --filter @zn-ai/zn-agent-core test src/compat/inboxBridge.test.ts \
  test/unit/compat/subagentReport.test.ts \
  test/unit/compat/subagentControl.test.ts \
  test/unit/compat/background/sendMessageToTask.test.ts

pnpm --filter @zn-ai/zai test \
  src/server/services/sessionInbox.test.ts \
  src/server/services/subagentNotifier.test.ts \
  src/server/routes/agent.queue.test.ts \
  src/server/routes/agent.test.ts       # 若存在
```
Expected: 全绿。

- [ ] **Step 3: TypeScript 检查**

```bash
pnpm -r exec tsc --noEmit
```
Expected: 0 错误。

- [ ] **Step 4: 确认无残留引用**

```bash
# grep -rn "flushPendingSubagentNotifications\|pendingNotifications" packages/zai/src
# grep -rn "__zaiSessionInbox" packages/zn-agent-core/src packages/zai/src/server
```
Expected:flush/pendingNotifications 无代码引用(仅注释保留历史说明);`__zaiSessionInbox` 两端(注入 + 读取)各至少一处。

- [ ] **Step 5: 修任何失败**

基于错误回到对应 Task 修复;不新增 commit 到本 verification task。

---

## Task 8: 真实浏览器验收(/ego-browser)

**Files:** (none — manual verification only)

- [ ] **Step 1: 启动独立 zai dev 实例(避开 920x)**

```bash
lsof -i :8101 || true
pnpm --filter @zn-ai/zai dev -- --port 8101
```
若 8101 占用,用 8102 显式指定。**不要 kill 920x 端口所在进程**。

- [ ] **Step 2: 验证终态通知回传**

任一 session prompt 模型调用 Agent 工具(或 `POST /api/tasks` 派发带 `parentSessionId` 的测试任务),子代理完成后:
1. 访问 `http://localhost:8101/agent`(PC)或 `/m`(mobile)
2. 截图确认主对话收到 `<task-notification>` 渲染续写(runtime.delta 流式,status idle→running→idle)
3. **busy 场景**:主对话生成中完成子代理,**不**打断主线;主线结束后通知轮次自然出现

- [ ] **Step 3: 验证 mid-run report(core 新工具)**

构造一个子代理在运行中调用 `subagent_report` 的场景(可在专用 agent 定义 prompt 里注入指令,或临时用测试工具触发),确认父对话收到报告(quiet → 合并,不强制开新轮)。

- [ ] **Step 4: 验证 subagent_control(可选 smoke)**

主对话 prompt 引导模型对某后台任务调用 `subagent_control(list_agents)` → 返回任务列表;再对该任务 `send_message`(可选,需长时间任务观察)。

- [ ] **Step 5: 验证并发守卫(防"并行 turn 事件风暴")**

1. **并发通知不打断主线**:主对话正在生成时,同时完成 2 个以上子代理 → 确认 UI 上本 sid **不出现并行新增轮次**(`runtime.started` 不重复叠加);主线结束后通知轮次逐个出现。
2. **多后台不连环唤醒**:连续完成多个后台任务 → 主对话被唤醒次数受 wakeBudget(≤3)约束;第 4 个任务完成时主对话保持 idle,等待用户输入后消费剩余通知(可从对话流时间戳确认没有连发 4 次 wake)。

- [ ] **Step 6: 关停 dev 实例**

```bash
kill %1  # 或 pkill -f "zai dev --port 8101"
```

- [ ] **Step 7: 无 commit(verification only)**

验收通过 → 实施完成。

---

## Self-Review

### 1. Spec coverage checklist

| Spec 段 | 实施任务 |
|---------|----------|
| 分工(core 产生 / server 投递) | Task 1/2/3(core)+ Task 4/5/6(server) |
| 会话模型对照(子 agent 复用父 sessionId) | Task 3(queryInput 消费 sendMessageToTask 时维持 sessionId 语义) |
| `__zaiSessionInbox` bridge | Task 1(core 读)+ Task 6(zai 注入) |
| subagent-report 工具 | Task 2 |
| subagent-control + sendMessageToTask | Task 3 |
| SessionInbox 接口与语义 | Task 4 |
| SubagentNotifier 改造 | Task 5 |
| runNextInQueue 双队列 + finally 合并 | Task 6 |
| **并发守卫(单消费者 / 同步段原子性 / wakeBudget)** | **Task 6 Step 1 并发用例 + Step 3 实现要点**;Task 4(wakeBudget 预算) |
| **守卫边界(子 agent 共享 sessionId 的并发面)** | 声明在 spec「并发守卫与边界」;Task 8 验收 busy 不打断 + 多后台不连环唤醒 |
| 错误处理(bridge 无桥 no-op / 后台回调异常) | Task 1(回退)+ Task 4(wakeHandler catch)+ Task 3(终态 no-op) |
| 测试计划(6 项 + 并发守卫) | Task 1/2/3/4/5/6 对应测试;**Task 7 汇总回归** |
| 后续工作(子代理独立会话 / durable) | 不在本 plan;spec 已注明 |

### 2. Placeholder scan

- `resolveInboxCwd(sid)` — Task 6 注明两种做法(从 session 取 cwd / process.cwd 兜底),实现时二选一并注明;非占位。
- Task 1/2/3 的测试文件路径以仓库既有测试布局为准(实现前 `ls` 对应 test 目录确认),已在步骤内注明「以既有基建为准」。
- 其余每步都有具体代码 / 断言 / command。

### 3. Type consistency

| 符号 | 首次定义 | 后用一致 |
|------|----------|----------|
| `InboxMessageLike`(core bridge) | Task 1 | Task 2 `deliverInboxMessage` ✓ |
| `InboxMessage`(zai) | Task 4 | Task 5 `handle()` 构造 ✓;Task 6 `inboxToPendingPrompt` ✓ |
| `deliverInboxMessage` | Task 1 | Task 2 execute ✓ |
| `sendMessageToTask` | Task 3(bg) | Task 3 control 工具 ✓ |
| `sessionInbox` 单例 | Task 4 | Task 5/6 + Task 6 bridge 注入 ✓ |
| `DEFAULT_WAKE_BUDGET` | Task 4 | Task 4 测试(预算耗尽)✓ |

### 4. Known risk(实现时验证)

- **core bundle 内联**:`subagentReportTool` 若从 `runAgent.ts`(opencc-src)import compat 模块,esbuild 会把它内联进 bundle —— 需确认 `deliverInboxMessage` 读 globalThis 的语义在 bundle 内仍成立(单进程内 bridge 是进程级,成立;同 `agentTaskBridge` 已验证)。若发现 import 路径被 tsconfig 排除(`src/opencc-src` 不参与 compat 编译),改用结构类型 + 动态注入注册(实现时按 `openccToolDefaults.ts` 现有注册结构处理)。
- **子上下文 parentSessionId 注入**:`runAgent.ts` 的 `createSubagentContext` 是否已带 `parentSessionId` 取决于 vendor 版本;若缺失,report 工具回退 `__zaiCurrentSessionId`(已有 bridge,AgentTool 派发时 zai server 已写入)。Task 2 Step 4 实现时确认,缺则补注入(zai patch)。详见 spec「数据流」。

---

## Execution Handoff

Plan 已完成,保存于 `docs/superpowers/plans/2026-08-17-zai-session-inbox-mechanism.md`(rev 3,core + server 双端 + 并发守卫)。

执行顺序建议**先 core(1→3)再 server(4→6)**,Task 7 统一回归(build:core + typecheck + 相关测试),Task 8 浏览器验收。

两种执行方式:
1. **Subagent-Driven(推荐)** — 派 fresh TaskAgent 跑 task-by-task,任务间 review
2. **Inline Execution** — 当前 session 顺序执行,带 checkpoint

哪种?