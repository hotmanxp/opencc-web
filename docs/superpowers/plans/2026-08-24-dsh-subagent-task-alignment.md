# DSH Subagent / 后台任务 全面对齐 vendor — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 opencc-web DSH 轨 subagent / 后台任务调用链路全面对齐到 deepseek-harness vendor (`@deepseek-ai/dsh-subagent/*` + `dsh-jobs`) 语义 — 事件 schema、capability 字段、completionDelivery、fork/continuable、状态机、ContentBlock 渲染、vendorSeam 真接线、移动端 — 全部走 vendor 原生路径,小步可逆。

**Architecture:** 三层对齐。
1. **dsh-bridge 内核**:`spawnDshSubagent` / `DshSubagentControlAdapter` / 翻译层真接 vendor,新增 capability 字段透传、continuable 真实现、ContentBlock schema
2. **zai server 桥接**:`seamBinding` / `seamRegistry` 注入 vendorSeam,`kernel/factories/dsh.ts` 改订阅 vendor `subagent/start` / `subagent/end` / `subagent/state` / `subagent/descriptor` / `subagent/message` 多事件,`subagentTasks` 路由去掉 globalThis 改走 seam
3. **zai UI**:`shared/events.ts` 新增 6 个 zod schema(旧 `subagent.changed` 标记 deprecated + 同步发 shim)、`useAgentStore` 新 reducer、`SubagentsTab` 加 Fork toggle + Continue 按钮、`SubagentDetailBody` 加 ContentBlock 渲染、`MobileAgent` 加 subagent 列表

**Tech Stack:** TypeScript / zod / vitest / Node-direct (`tsx` + bun-protocol loader) / Cordis (`@deepseek-ai/cordis` 4.0.1) / 35 个 `@deepseek-ai/dsh-*` 子包 / Express + SSE / React 18 + Zustand 4.5 + AntD 5.22

**Spec:** `docs/superpowers/specs/2026-08-24-dsh-subagent-task-alignment-design.md`

---

## Global Constraints

- **工作目录**:`/Users/ethan/code/opencc-web`(主分支 `main`)
- **范围**:仅 DSH 轨;OpenCC 轨 `DefaultBackgroundRuntime` 保持现状,UI 空态时显示 "DSH 模式专享"
- **事件过渡**:`subagent.changed` 同步发 + deprecation log warning,运行期保留,UI 迁完后通过 feature flag `agent.subagent.eventV2.enabled` 关闭(预计 2026-09-30)
- **vendorSeam 是 zai ↔ dsh-bridge 唯一接口**:zai-side 不再 import `@zn-ai/dsh-bridge` 的 `taskStore` / `vendorSeam` 内部函数,只走 `kernel.getSeam(name)`(去除所有 globalThis 桥)
- **core 不动**:本计划不涉及 `packages/zn-agent-core/`,无需 `pnpm run build:core`
- **测试粒度**:仅跑直接受影响的测试文件;禁止 `pnpm -r test` 全量
- **Node-direct runtime**:`pnpm --filter @zn-ai/zai dev -- --port 8102 --api-port 7715 --kernel=dsh` 启动验证
- **真实浏览器验收**:实施完成后 `/ego-browser` 验证 15 项(见 spec §15.2)
- **CodeGraph 优先**:实施期用 `codegraph_explore` 定位文件 / 字段
- **提交规范**:conventional commits(`feat(zai): ...` / `feat(dsh-bridge): ...` / `fix(zai): ...`)

---

## File Structure

### 新增

| 文件 | 职责 |
|------|------|
| `packages/zai/src/shared/subagentEvents.ts` | 6 个新事件 zod schema(`subagent.start`/`end`/`descriptor`/`state`/`message`/`error`) + `SubagentContentBlockSchema` |
| `packages/zai/src/server/services/kernel/seamRegistry.ts` | `SeamRegistry` 类 + `kernel.getSeam<T>(name)` 接口 |
| `packages/zai/src/server/services/kernel/seamBinding.ts` | kernel factory 启动时把 dsh-bridge 的 vendorSeam 注入 zai services(替代 globalThis 桥) |
| `packages/dsh-bridge/src/subagent/contentBlock.ts` | `SubagentContentBlockSchema` + parse helper(vendor `ContentBlock[]` zod 校验) |
| `packages/dsh-bridge/src/subagent/continuation.ts` | 真实现 `startContinuable`(vendor `SubagentContinuationManager.startContinuable` 包装) |
| `packages/dsh-bridge/src/vendorSeam/eventTranslation.ts` | vendor 原生事件 → zai SSE 事件翻译(deprecation shim:同步发 `subagent.changed`) |
| `packages/zai/test/shared/subagentEvents.test.ts` | 6 个 schema zod 解析 + deprecation 注释验证 |
| `packages/zai/test/server/services/kernel/seamBinding.test.ts` | vendorSeam 注入 + `kernel.getSeam()` 解析 |
| `packages/zai/test/server/services/kernel/seamRegistry.test.ts` | 注册 / 解析 / 缺失抛错 |
| `packages/dsh-bridge/test/subagent/contentBlock.test.ts` | ContentBlock zod 解析(5 种 type + 未知降级) |
| `packages/dsh-bridge/test/subagent/continuation.test.ts` | startContinuable 真实现 + 失败路径 |
| `packages/dsh-bridge/test/vendorSeam/eventTranslation.test.ts` | 翻译函数 + deprecation shim |
| `packages/dsh-bridge/test/vendorSeam/subagent.test.ts` | `DshSubagentControlAdapter` capability 字段透传 + completionDelivery 真接 |
| `packages/zai/test/web/hooks/useSubagentTasks.test.ts` | 多事件 store 更新 |
| `packages/zai/test/web/components/splitPane/SubagentsTab.test.tsx` | Fork toggle + Continue 按钮 + state 渲染 |
| `packages/zai/test/web/components/splitPane/SubagentDetailBody.test.tsx` | ContentBlock[] 5 种 type 渲染 |
| `packages/zai/test/web/pages/m/MobileAgent.test.tsx` | subagent 列表 + detail |

### 修改

| 文件 | 修改点 |
|------|--------|
| `packages/zai/src/shared/events.ts:286-298` | 旧 `subagent.changed` schema 加 `@deprecated` JSDoc;`RuntimeEvent` union 引入 `SubagentEvent`(6 个新事件) |
| `packages/zai/src/server/services/kernel/factories/dsh.ts:570-597` | `onTaskStart` / `onTaskFinish` 改为订阅 vendor `ctx.on('subagent/start' | 'subagent/end' | ...')` 多事件 + 调 `eventTranslation` |
| `packages/zai/src/server/services/kernel/factories/dsh.ts:710-790` | 移除 `__zaiDshSubagentControl` / `__zaiDshSubagentDetail` globalThis 桥 |
| `packages/zai/src/server/services/stateBridge.ts:90-101` | 移除 `subagent.changed` 翻译(改由 dsh-bridge eventTranslation 直接发);订阅 6 个新事件直通 `eventBus.emit` |
| `packages/zai/src/server/services/backgroundRuntime.ts:76-179` | DSH 模式 `initBackgroundRuntime` 改为注入 vendorSeam(而非 return null) |
| `packages/zai/src/server/routes/subagentTasks.ts` | 全部 `tryGetDshBridge()` / `tryGetDshDetailBridge()` 改走 `kernel.getSeam('subagent').xxx(...)` |
| `packages/zai/src/server/routes/subagentTasks.ts:227-267` | send-message 路由:zai-side 调 `kernel.getSeam('subagent').sendMessage(...)` |
| `packages/zai/src/server/routes/subagentTasks.ts`(末尾) | 新增 `POST /api/subagent-tasks/:id/continuable` |
| `packages/zai/src/server/services/kernel/factories/dsh.ts`(registerZaiTools 段) | 透传 capability 字段 + completionDelivery(从 settings.json 读) |
| `packages/zai/src/web/src/store/useAgentStore.ts:2165-2203` | `applySubagentChanged` 标记 deprecated,新增 `applySubagentStart` / `applySubagentEnd` / `applySubagentState` / `applySubagentDescriptor` / `applySubagentMessage` / `applySubagentError` reducer |
| `packages/zai/src/web/src/store/useEventStream.ts:148-152` | `subagent.changed` handler 标记 deprecated,新增 6 个新事件 handler |
| `packages/zai/src/web/src/hooks/useSubagentTasks.ts` | 增加 cold-start REST fallback + 多事件驱动 store 更新 |
| `packages/zai/src/web/src/components/splitPane/SubagentsTab.tsx` | Fork toggle(`provider: 'spawn' | 'fork'`) + Continue 按钮(已结束的子代理) + state 渲染(running/waiting/settled) |
| `packages/zai/src/web/src/components/splitPane/SubagentDetailBody.tsx` | 新增 `ContentBlockRenderer`(thinking/text/tool_use/tool_result/image)+ 未知 type 降级 |
| `packages/zai/src/web/src/components/splitPane/SubagentDetailDrawer.tsx` | continuable 模式渲染(顶部 "多轮对话" 标识 + 消息历史 + Send) |
| `packages/zai/src/web/src/components/SubagentsDrawer.tsx` | 空态 OpenCC 模式显示 "DSH 模式专享" 提示 |
| `packages/zai/src/web/src/pages/m/MobileAgent.tsx` | 新增 `<SubagentList />` 折叠面板(简化版 SubagentsTab) |
| `packages/zai/src/web/src/components/MobileQuickDrawer.tsx` | 末尾新增 "Subagents" 入口 toggle |
| `packages/dsh-bridge/src/subagent/taskStore.ts:319-540` | `spawnDshSubagent` opts 增加 `outputSchema`/`toolFilter`/`persona`/`maxDepth` 字段;真实现 `startContinuable` |
| `packages/dsh-bridge/src/vendorSeam/subagent.ts:125-191` | `dispatch` 透传 capability 字段 + completionDelivery |
| `packages/dsh-bridge/src/vendorSeam/subagent.ts`(末尾) | 新增 `startContinuable` 真实现 + `sendMessage` 委托 vendor `ctx.subagents.followup` |
| `packages/dsh-bridge/src/vendorSeam/subagent.ts:97-123` | cordis 订阅扩展到 5 个 vendor 事件(`subagent/start`/`end`/`state`/`descriptor`/`message`)+ 翻译 |
| `packages/dsh-bridge/src/tools/subagent.ts:131-322` | 删除 `createAgentTool` + `registerAgentTool`(vendor `@deepseek-ai/dsh-tool-subagent` 接管) |
| `packages/dsh-bridge/src/subagent/taskStore.ts:533-588` | 删除 `notifyParentSession` deprecated export |
| `packages/dsh-bridge/src/index.ts` | 删除 `createAgentTool` / `registerAgentTool` / `notifyParentSession` re-export |

---

## Task 1: 新增 zai shared subagentEvents 模块(6 个 zod schema + ContentBlock)

**Files:**
- Create: `packages/zai/src/shared/subagentEvents.ts`
- Test: `packages/zai/test/shared/subagentEvents.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `SubagentStartEvent`, `SubagentEndEvent`, `SubagentDescriptorEvent`, `SubagentStateEvent`, `SubagentMessageEvent`, `SubagentErrorEvent`(zod schemas)
  - `SubagentContentBlockSchema`(zod discriminated union,5 种 type)
  - `SubagentEvent = z.discriminatedUnion('type', [...])`(zod union)

- [ ] **Step 1: 写失败测试**

在 `packages/zai/test/shared/subagentEvents.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  SubagentStartEvent,
  SubagentEndEvent,
  SubagentDescriptorEvent,
  SubagentStateEvent,
  SubagentMessageEvent,
  SubagentErrorEvent,
  SubagentContentBlockSchema,
} from '../../src/shared/subagentEvents.js'

describe('subagentEvents', () => {
  it('parses subagent.start payload', () => {
    const ok = SubagentStartEvent.parse({
      type: 'subagent.start',
      ts: 1700000000,
      sessionId: 's1',
      runId: 'r1',
      provider: 'spawn',
      id: 'dsh-task-xxx',
      local: true,
      parentSessionId: 'p1',
    })
    expect(ok.runId).toBe('r1')
  })

  it('parses subagent.end with lastAssistantMessage', () => {
    const ok = SubagentEndEvent.parse({
      type: 'subagent.end',
      ts: 1700000000,
      sessionId: 's1',
      runId: 'r1',
      provider: 'spawn',
      id: 'dsh-task-xxx',
      local: true,
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'hello' }],
    })
    expect(ok.stopReason).toBe('completed')
  })

  it('rejects subagent.end with invalid stopReason', () => {
    expect(() =>
      SubagentEndEvent.parse({
        type: 'subagent.end', ts: 0, sessionId: 's1', runId: 'r1',
        provider: 'spawn', id: 'x', local: true, stopReason: 'bogus',
      }),
    ).toThrow()
  })

  it('parses subagent.descriptor with mode/persona/toolFilter', () => {
    const ok = SubagentDescriptorEvent.parse({
      type: 'subagent.descriptor',
      ts: 0, sessionId: 's1', runId: 'r1',
      version: 2, mode: 'one-shot', provider: 'spawn',
      label: 'investigate-x', persona: 'you are a tester',
      toolFilter: ['Read', 'Grep'],
    })
    expect(ok.mode).toBe('one-shot')
    expect(ok.toolFilter).toEqual(['Read', 'Grep'])
  })

  it('parses subagent.state with running/waiting/settled', () => {
    for (const state of ['running', 'waiting', 'settled'] as const) {
      const ok = SubagentStateEvent.parse({
        type: 'subagent.state', ts: 0, sessionId: 's1', runId: 'r1', state,
      })
      expect(ok.state).toBe(state)
    }
  })

  it('parses subagent.message with ContentBlock[]', () => {
    const ok = SubagentMessageEvent.parse({
      type: 'subagent.message',
      ts: 0, sessionId: 's1', runId: 'r1',
      blocks: [
        { type: 'thinking', thinking: 'reasoning...' },
        { type: 'text', text: 'final answer' },
        { type: 'tool_use', id: 'tu1', name: 'Read', input: { path: '/a' } },
        { type: 'tool_result', tool_use_id: 'tu1', content: 'contents', is_error: false },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '...' } },
      ],
    })
    expect(ok.blocks).toHaveLength(5)
  })

  it('parses subagent.error payload', () => {
    const ok = SubagentErrorEvent.parse({
      type: 'subagent.error', ts: 0, sessionId: 's1', runId: 'r1',
      message: 'boom', code: 'TIMEOUT',
    })
    expect(ok.code).toBe('TIMEOUT')
  })

  it('SubagentContentBlockSchema rejects unknown type', () => {
    expect(() =>
      SubagentContentBlockSchema.parse({ type: 'bogus', x: 1 }),
    ).toThrow()
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

```bash
pnpm --filter @zn-ai/zai test src/shared/subagentEvents.test.ts
```

期望:FAIL(`subagentEvents.js` 不存在)。

- [ ] **Step 3: 写实现**

在 `packages/zai/src/shared/subagentEvents.ts`:

```ts
import { z } from 'zod'

/**
 * DSH 轨 subagent/后台任务 全面对齐 vendor 事件 schema。
 *
 * 对应 vendor `@deepseek-ai/dsh-subagent` 事件:
 *   - subagent/start → subagent.start
 *   - subagent/end   → subagent.end
 *   - subagent/descriptor → subagent.descriptor
 *   - (continuation ActivationState) → subagent.state
 *   - 子 agent publish message → subagent.message
 *
 * 旧 `subagent.changed`(action='start'|'finish')已 deprecated,保留 shim 至 2026-09-30。
 * 详见 spec §4 事件 Schema 对齐。
 */

const Base = z.object({
  ts: z.number(),
  sessionId: z.string(),
  runId: z.string(),
})

export const SubagentContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('thinking'), thinking: z.string() }),
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.unknown(),
    is_error: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('image'),
    source: z.object({
      type: z.literal('base64'),
      media_type: z.string(),
      data: z.string(),
    }),
  }),
])
export type SubagentContentBlock = z.infer<typeof SubagentContentBlockSchema>

export const SubagentStartEvent = Base.extend({
  type: z.literal('subagent.start'),
  provider: z.string(),
  id: z.string(),
  local: z.boolean(),
  parentSessionId: z.string().optional(),
})

export const SubagentStopReason = z.enum([
  'completed',
  'aborted',
  'error',
  'max-tokens',
  'refusal',
])

export const SubagentEndEvent = Base.extend({
  type: z.literal('subagent.end'),
  provider: z.string(),
  id: z.string(),
  local: z.boolean(),
  stopReason: SubagentStopReason,
  lastAssistantMessage: z.array(SubagentContentBlockSchema).optional(),
  output: z.array(SubagentContentBlockSchema).optional(),
  structured: z.unknown().optional(),
})

export const SubagentDescriptorEvent = Base.extend({
  type: z.literal('subagent.descriptor'),
  version: z.literal(2),
  mode: z.enum(['one-shot', 'continuable']),
  provider: z.string(),
  label: z.string().optional(),
  persona: z.string().optional(),
  toolFilter: z.array(z.string()).optional(),
  agentProvider: z.string().optional(),
  agentModel: z.string().optional(),
})

export const SubagentStateEvent = Base.extend({
  type: z.literal('subagent.state'),
  state: z.enum(['running', 'waiting', 'settled']),
})

export const SubagentMessageEvent = Base.extend({
  type: z.literal('subagent.message'),
  blocks: z.array(SubagentContentBlockSchema),
})

export const SubagentErrorEvent = Base.extend({
  type: z.literal('subagent.error'),
  message: z.string(),
  code: z.string().optional(),
})

export const SubagentEvent = z.discriminatedUnion('type', [
  SubagentStartEvent,
  SubagentEndEvent,
  SubagentDescriptorEvent,
  SubagentStateEvent,
  SubagentMessageEvent,
  SubagentErrorEvent,
])
export type SubagentEventT = z.infer<typeof SubagentEvent>
```

- [ ] **Step 4: 跑测试,确认通过**

```bash
pnpm --filter @zn-ai/zai test src/shared/subagentEvents.test.ts
```

期望:PASS(8 tests)。

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/shared/subagentEvents.ts packages/zai/test/shared/subagentEvents.test.ts
git commit -m "feat(zai): 新增 subagentEvents 共享 schema(6 vendor 原生事件 + ContentBlock)"
```

---

## Task 2: shared/events.ts 集成 SubagentEvent union + 旧 schema 标 deprecated

**Files:**
- Modify: `packages/zai/src/shared/events.ts:286-298`(旧 `subagent.changed` schema)
- Modify: `packages/zai/src/shared/events.ts`(union 引入 `SubagentEvent`)
- Test: `packages/zai/test/shared/events.test.ts`(若存在,补 case;否则新建)

**Interfaces:**
- Consumes: Task 1 的 `SubagentEvent` / 6 个子 schema
- Produces: `RuntimeEvent` discriminated union 包含 `SubagentEvent` 6 个成员;旧 `subagent.changed` schema 加 `@deprecated` JSDoc

- [ ] **Step 1: 写失败测试**

在 `packages/zai/test/shared/events.test.ts`(若不存在则新建):

```ts
import { describe, expect, it } from 'vitest'
import { RuntimeEvent } from '../../src/shared/events.js'

describe('RuntimeEvent union includes subagent events', () => {
  it('parses subagent.start', () => {
    const ok = RuntimeEvent.parse({
      type: 'subagent.start', ts: 0, sessionId: 's1', runId: 'r1',
      provider: 'spawn', id: 'x', local: true,
    })
    expect(ok.type).toBe('subagent.start')
  })

  it('parses subagent.end with stopReason', () => {
    const ok = RuntimeEvent.parse({
      type: 'subagent.end', ts: 0, sessionId: 's1', runId: 'r1',
      provider: 'spawn', id: 'x', local: true, stopReason: 'completed',
    })
    expect(ok.type).toBe('subagent.end')
  })

  it('still parses legacy subagent.changed (deprecated)', () => {
    const ok = RuntimeEvent.parse({
      type: 'subagent.changed', ts: 0, sessionId: 's1', taskId: 'r1',
      description: 'd', status: 'running', action: 'start',
    })
    expect(ok.type).toBe('subagent.changed')
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

```bash
pnpm --filter @zn-ai/zai test src/shared/events.test.ts
```

期望:FAIL(`subagent.start` / `subagent.end` 不在 union 内)。

- [ ] **Step 3: 修改 events.ts**

在 `packages/zai/src/shared/events.ts` 顶部 import 新 schema:

```ts
import {
  SubagentEvent,
  SubagentStartEvent,
  SubagentEndEvent,
  SubagentDescriptorEvent,
  SubagentStateEvent,
  SubagentMessageEvent,
  SubagentErrorEvent,
} from './subagentEvents.js'
```

找到 `subagent.changed` schema(当前 line 288-298),**保留** schema(不删),加 `@deprecated` JSDoc:

```ts
/**
 * @deprecated 自 2026-08-24 起使用 `subagent.start` / `subagent.end` 替代;
 * 旧事件运行期同步发(deprecation shim),2026-09-30 通过 feature flag
 * `agent.subagent.eventV2.enabled` 关闭。详见 spec §4 事件 Schema 对齐。
 */
z.object({
  ...Base.shape,
  type: z.literal('subagent.changed'),
  sessionId: z.string(),
  taskId: z.string(),
  description: z.string(),
  status: z.enum(['running', 'done', 'failed', 'cancelled']),
  result: z.string().optional(),
  error: z.string().optional(),
  action: z.enum(['start', 'finish']),
}),
```

在 `RuntimeEvent` discriminated union(若已是)加入 6 个新成员:

```ts
SubagentStartEvent,
SubagentEndEvent,
SubagentDescriptorEvent,
SubagentStateEvent,
SubagentMessageEvent,
SubagentErrorEvent,
```

- [ ] **Step 4: 跑测试,确认通过**

```bash
pnpm --filter @zn-ai/zai test src/shared/events.test.ts
```

期望:PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/shared/events.ts packages/zai/test/shared/events.test.ts
git commit -m "feat(zai): RuntimeEvent union 新增 6 个 subagent vendor 事件;旧 subagent.changed 标 deprecated"
```

---

## Task 3: dsh-bridge 新增 contentBlock.ts(zod schema + parse helper)

**Files:**
- Create: `packages/dsh-bridge/src/subagent/contentBlock.ts`
- Test: `packages/dsh-bridge/test/subagent/contentBlock.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `SubagentContentBlockSchema` (zod) — 与 zai `SubagentContentBlockSchema` 同构
  - `parseContentBlock(raw: unknown): SubagentContentBlock` — 校验失败 throw + console.warn
  - `parseContentBlocks(raw: unknown): SubagentContentBlock[]`

- [ ] **Step 1: 写失败测试**

在 `packages/dsh-bridge/test/subagent/contentBlock.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  parseContentBlock,
  parseContentBlocks,
  SubagentContentBlockSchema,
} from '../../src/subagent/contentBlock.js'

describe('contentBlock', () => {
  it('parses thinking block', () => {
    const r = parseContentBlock({ type: 'thinking', thinking: 'x' })
    expect(r.type).toBe('thinking')
  })
  it('parses text block', () => {
    const r = parseContentBlock({ type: 'text', text: 'hi' })
    expect(r.type).toBe('text')
  })
  it('parses tool_use block', () => {
    const r = parseContentBlock({ type: 'tool_use', id: 'a', name: 'Read', input: {} })
    expect(r.type).toBe('tool_use')
  })
  it('parses tool_result block', () => {
    const r = parseContentBlock({ type: 'tool_result', tool_use_id: 'a', content: 'r' })
    expect(r.type).toBe('tool_result')
  })
  it('parses image block', () => {
    const r = parseContentBlock({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'abc' },
    })
    expect(r.type).toBe('image')
  })
  it('throws on unknown type with warn', () => {
    expect(() => parseContentBlock({ type: 'bogus' })).toThrow(/contentBlock/i)
  })
  it('parseContentBlocks handles array', () => {
    const r = parseContentBlocks([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ])
    expect(r).toHaveLength(2)
  })
  it('export SubagentContentBlockSchema is exported', () => {
    expect(SubagentContentBlockSchema).toBeDefined()
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

```bash
pnpm --filter @zn-ai/dsh-bridge test src/subagent/contentBlock.test.ts
```

期望:FAIL。

- [ ] **Step 3: 写实现**

在 `packages/dsh-bridge/src/subagent/contentBlock.ts`:

```ts
import { z } from 'zod'

/**
 * SubagentResult.output 元素 — vendor `@deepseek-ai/dsh-subagent/src/types.ts:219`
 * ContentBlock 类型的 zod 校验版。
 *
 * 与 zai `shared/subagentEvents.ts:SubagentContentBlockSchema` 同构(本文件
 * 早期定义,Task 1 是消费侧镜像)。
 */

export const SubagentContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('thinking'), thinking: z.string() }),
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.unknown(),
    is_error: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('image'),
    source: z.object({
      type: z.literal('base64'),
      media_type: z.string(),
      data: z.string(),
    }),
  }),
])
export type SubagentContentBlock = z.infer<typeof SubagentContentBlockSchema>

export function parseContentBlock(raw: unknown): SubagentContentBlock {
  const r = SubagentContentBlockSchema.safeParse(raw)
  if (!r.success) {
    console.warn(
      '[dsh-bridge] contentBlock parse failed:',
      r.error.issues,
      JSON.stringify(raw).slice(0, 200),
    )
    throw new Error(
      `[dsh-bridge] contentBlock parse failed: ${r.error.issues.map((i) => i.message).join('; ')}`,
    )
  }
  return r.data
}

export function parseContentBlocks(raw: unknown): SubagentContentBlock[] {
  if (!Array.isArray(raw)) {
    console.warn('[dsh-bridge] contentBlocks parse: not array, got', typeof raw)
    return []
  }
  const out: SubagentContentBlock[] = []
  for (const item of raw) {
    try {
      out.push(parseContentBlock(item))
    } catch {
      // 单个失败跳过(已 warn)
    }
  }
  return out
}
```

- [ ] **Step 4: 跑测试,确认通过**

```bash
pnpm --filter @zn-ai/dsh-bridge test src/subagent/contentBlock.test.ts
```

期望:PASS(8 tests)。

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-bridge/src/subagent/contentBlock.ts packages/dsh-bridge/test/subagent/contentBlock.test.ts
git commit -m "feat(dsh-bridge): 新增 contentBlock zod schema + parse helper"
```

---

## Task 4: dsh-bridge spawnDshSubagent 扩展 capability 字段

**Files:**
- Modify: `packages/dsh-bridge/src/subagent/taskStore.ts:319-356`(spawnDshSubagent opts)
- Modify: `packages/dsh-bridge/src/subagent/taskStore.ts:357-540`(function body 透传)
- Test: `packages/dsh-bridge/test/subagent/taskStore.test.ts`(补 capability case)

**Interfaces:**
- Consumes: vendor `SubagentStartRequest` 真实字段(`@deepseek-ai/dsh-subagent/src/types.ts:SubagentStartRequest`)
- Produces: `spawnDshSubagent` opts 新增 `outputSchema?` / `toolFilter?` / `persona?` / `maxDepth?`,内部组装成 vendor `SubagentStartRequest.outputSchema` / `toolFilter` / `persona` / `maxDepth`

- [ ] **Step 1: 写失败测试**

在 `packages/dsh-bridge/test/subagent/taskStore.test.ts` 末尾追加:

```ts
describe('spawnDshSubagent capability 字段', () => {
  it('透传 outputSchema 到 vendor request', async () => {
    // mock ctx.subagents.start,验证 request.outputSchema === input.outputSchema
    const captured: unknown[] = []
    const ctx = {
      subagents: {
        start: async (_name: string, req: unknown) => {
          captured.push(req)
          return { id: 'r1', localAgent: undefined, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} }
        },
      },
      agents: { get: () => undefined },
      on: () => () => {},
    } as never
    await spawnDshSubagent(ctx, {
      parentSessionId: 'p1', parentAgent: { id: 'p1' } as never,
      prompt: 'x', cwd: '/tmp',
      outputSchema: { type: 'object', properties: { x: { type: 'string' } } },
    })
    const req = captured[0] as { outputSchema?: unknown }
    expect(req.outputSchema).toEqual({ type: 'object', properties: { x: { type: 'string' } } })
  })

  it('透传 toolFilter / persona / maxDepth', async () => {
    const captured: unknown[] = []
    const ctx = {
      subagents: {
        start: async (_n: string, req: unknown) => {
          captured.push(req)
          return { id: 'r1', localAgent: undefined, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} }
        },
      },
      agents: { get: () => undefined },
      on: () => () => {},
    } as never
    await spawnDshSubagent(ctx, {
      parentSessionId: 'p1', parentAgent: { id: 'p1' } as never,
      prompt: 'x', cwd: '/tmp',
      toolFilter: ['Read'], persona: 'you are X', maxDepth: 2,
    })
    const req = captured[0] as { toolFilter?: string[]; persona?: string; maxDepth?: number }
    expect(req.toolFilter).toEqual(['Read'])
    expect(req.persona).toBe('you are X')
    expect(req.maxDepth).toBe(2)
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

```bash
pnpm --filter @zn-ai/dsh-bridge test src/subagent/taskStore.test.ts
```

期望:FAIL(字段未透传)。

- [ ] **Step 3: 修改 taskStore.ts**

`packages/dsh-bridge/src/subagent/taskStore.ts:319-356` opts 增加:

```ts
/**
 * 子代理输出 JSON Schema(对齐 vendor `SubagentStartRequest.outputSchema`)。
 * 指定后,子代理 output 经结构化校验,`SubagentResult.structured` 字段填值。
 */
outputSchema?: Record<string, unknown>
/** 子代理允许的工具名白名单(对齐 vendor `toolFilter`)。不传 = 全开。 */
toolFilter?: string[]
/** 子代理 persona prompt — 注入到子 agent system prompt 前缀(对齐 vendor `persona`)。 */
persona?: string
/** 嵌套层数上限(对齐 vendor `maxDepth`)。缺省 vendor 默认(2)。 */
maxDepth?: number
```

function body 调用 `ctx.subagents.start(providerName, req)` 的 `req` 对象中增加字段(假设当前已透传 parentSessionId / prompt / cwd / model / provider,补 capability):

```ts
const req = {
  parent: opts.parentAgent,
  prompt: opts.prompt,
  cwd: opts.cwd,
  ...(opts.model !== undefined ? { model: opts.model } : {}),
  ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
  ...(opts.outputSchema !== undefined ? { outputSchema: opts.outputSchema } : {}),
  ...(opts.toolFilter !== undefined ? { toolFilter: opts.toolFilter } : {}),
  ...(opts.persona !== undefined ? { persona: opts.persona } : {}),
  ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
  completionDelivery: opts.completionDelivery ?? 'wakeup',
}
```

- [ ] **Step 4: 跑测试,确认通过**

```bash
pnpm --filter @zn-ai/dsh-bridge test src/subagent/taskStore.test.ts
```

期望:PASS(原 15 tests + 新 2 tests,共 17)。

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-bridge/src/subagent/taskStore.ts packages/dsh-bridge/test/subagent/taskStore.test.ts
git commit -m "feat(dsh-bridge): spawnDshSubagent 支持 capability 字段(outputSchema/toolFilter/persona/maxDepth)"
```

---

## Task 5: dsh-bridge 真实现 startContinuable(vendor SubagentContinuationManager)

**Files:**
- Create: `packages/dsh-bridge/src/subagent/continuation.ts`
- Modify: `packages/dsh-bridge/src/subagent/taskStore.ts:63`(替换 mock `startContinuable`)
- Test: `packages/dsh-bridge/test/subagent/continuation.test.ts`

**Interfaces:**
- Consumes: vendor `@deepseek-ai/dsh-subagent/src/continuation.ts:SubagentContinuationManager`
- Produces:
  - `startContinuable(ctx, opts: { parentSessionId, childId?, prompt, messageId? }): Promise<{ childId, messageId }>`
  - `taskStore.startContinuable` 真转发到上述函数(替换当前 mock)

- [ ] **Step 1: 写失败测试**

在 `packages/dsh-bridge/test/subagent/continuation.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { startContinuable } from '../../src/subagent/continuation.js'

describe('startContinuable', () => {
  it('throws when ctx.subagents unavailable', async () => {
    const ctx = { subagents: undefined, on: () => () => {} } as never
    await expect(
      startContinuable(ctx, { parentSessionId: 'p1', prompt: 'hi' }),
    ).rejects.toThrow(/SubagentContinuationManager/i)
  })

  it('returns childId + messageId on success', async () => {
    const captured: unknown[] = []
    const continuationManager = {
      startContinuable: async (spec: unknown) => {
        captured.push(spec)
        return { childId: 'c1', messageId: 'm1' }
      },
    }
    const ctx = {
      subagents: { continuation: continuationManager },
      agents: { get: () => ({ id: 'p1' }) },
      on: () => () => {},
    } as never
    const r = await startContinuable(ctx, {
      parentSessionId: 'p1', prompt: 'follow-up',
    })
    expect(r.childId).toBe('c1')
    expect(r.messageId).toBe('m1')
    expect(captured[0]).toMatchObject({ parent: { id: 'p1' }, prompt: 'follow-up' })
  })

  it('throws when parent agent missing', async () => {
    const ctx = {
      subagents: { continuation: { startContinuable: async () => ({}) } },
      agents: { get: () => undefined },
      on: () => () => {},
    } as never
    await expect(
      startContinuable(ctx, { parentSessionId: 'missing', prompt: 'x' }),
    ).rejects.toThrow(/parent agent/i)
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

```bash
pnpm --filter @zn-ai/dsh-bridge test src/subagent/continuation.test.ts
```

期望:FAIL。

- [ ] **Step 3: 写实现**

在 `packages/dsh-bridge/src/subagent/continuation.ts`:

```ts
import type { Context, Agent } from '@deepseek-ai/cordis'

/**
 * 启动一个 continuable 子代理(vendor `SubagentContinuationManager.startContinuable`)。
 *
 * 与 one-shot 不同:continuable 子代理拥有持久 Session,支持多轮对话 + 冷恢复。
 * `ctx.subagents.continuation` 由 vendor `@deepseek-ai/dsh-subagent` 注册。
 *
 * 返回的 `childId` 是子 SessionId,`messageId` 是首条消息的 ID。
 * 后续消息走 `sendMessageToDshSubagent(ctx, childId, content)`(已存在)。
 */

export interface ContinuableStartOpts {
  parentSessionId: string
  childId?: string  // 续接已有 child(可选)
  prompt: string
  messageId?: string
}

export interface ContinuableStartResult {
  childId: string
  messageId: string
}

export async function startContinuable(
  ctx: Context,
  opts: ContinuableStartOpts,
): Promise<ContinuableStartResult> {
  const subagentRuntime = (ctx.subagents as unknown as {
    continuation?: {
      startContinuable: (spec: {
        parent: Agent
        childId?: string
        prompt: string
        messageId?: string
      }) => Promise<{ childId: string; messageId: string }>
    }
  } | undefined)
  if (!subagentRuntime?.continuation) {
    throw new Error(
      '[dsh-bridge] startContinuable: ctx.subagents.continuation unavailable — SubagentContinuationManager not loaded',
    )
  }
  const agentsService = ctx.get('agents') as { get: (id: string) => Agent | undefined } | undefined
  const parent = agentsService?.get(opts.parentSessionId)
  if (!parent) {
    throw new Error(
      `[dsh-bridge] startContinuable: parent agent not found for sessionId="${opts.parentSessionId}"`,
    )
  }
  return subagentRuntime.continuation.startContinuable({
    parent,
    ...(opts.childId !== undefined ? { childId: opts.childId } : {}),
    prompt: opts.prompt,
    ...(opts.messageId !== undefined ? { messageId: opts.messageId } : {}),
  })
}
```

修改 `packages/dsh-bridge/src/subagent/taskStore.ts:63`(替换 mock):

```ts
// 替换原 mock 实现为 re-export continuation 真函数
export { startContinuable } from './continuation.js'
```

- [ ] **Step 4: 跑测试,确认通过**

```bash
pnpm --filter @zn-ai/dsh-bridge test src/subagent/continuation.test.ts
```

期望:PASS(3 tests)。

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-bridge/src/subagent/continuation.ts packages/dsh-bridge/src/subagent/taskStore.ts packages/dsh-bridge/test/subagent/continuation.test.ts
git commit -m "feat(dsh-bridge): 真实现 startContinuable(vendor SubagentContinuationManager)"
```

---

## Task 6: dsh-bridge vendorSeam.eventTranslation(vendor 原生 → zai SSE)

**Files:**
- Create: `packages/dsh-bridge/src/vendorSeam/eventTranslation.ts`
- Test: `packages/dsh-bridge/test/vendorSeam/eventTranslation.test.ts`

**Interfaces:**
- Consumes: vendor 原生 event payload(`subagent/start` / `subagent/end` / `subagent/descriptor` / 子 agent publish message / continuation ActivationState);zai `shared/subagentEvents.ts` schema
- Produces:
  - `translateSubagentStart(ctx, info): Record<string, unknown>` — emit zai 同构对象,让 zai-side zod 校验
  - `translateSubagentEnd(ctx, info): Record<string, unknown>`
  - `translateSubagentDescriptor(ctx, info): Record<string, unknown>`
  - `translateSubagentState(ctx, runId, state): Record<string, unknown>`
  - `translateSubagentMessage(ctx, runId, blocks): Record<string, unknown>`
  - `emitLegacyShim(eventBus, newEvent): void`(同步发 `subagent.changed` + console.warn deprecation)

> **重要**:不 import zai 类型(dsh-bridge 不依赖 zai,反向依赖会构建报错)。所有
> translate 函数返回 `Record<string, unknown>`,zai-side `useEventStream` 用
> `SubagentEvent` zod 在收到时校验。

- [ ] **Step 1: 写失败测试**

在 `packages/dsh-bridge/test/vendorSeam/eventTranslation.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import {
  translateSubagentStart,
  translateSubagentEnd,
  translateSubagentDescriptor,
  translateSubagentState,
  translateSubagentMessage,
  emitLegacyShim,
} from '../../src/vendorSeam/eventTranslation.js'

describe('eventTranslation', () => {
  it('translateSubagentStart maps vendor payload to zai', () => {
    const r = translateSubagentStart('s1', {
      runId: 'r1', provider: 'spawn', id: 'dsh-task-x', local: true, parentSessionId: 'p1',
    })
    expect(r.type).toBe('subagent.start')
    expect(r.runId).toBe('r1')
    expect(r.sessionId).toBe('s1')
  })

  it('translateSubagentEnd maps stopReason + lastAssistantMessage', () => {
    const r = translateSubagentEnd('s1', {
      runId: 'r1', provider: 'spawn', id: 'x', local: true,
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'done' }],
    })
    expect(r.stopReason).toBe('completed')
    expect(r.lastAssistantMessage).toHaveLength(1)
  })

  it('translateSubagentDescriptor maps mode/provider/persona/toolFilter', () => {
    const r = translateSubagentDescriptor('s1', 'r1', {
      version: 2, mode: 'continuable', provider: 'fork',
      persona: 'p', toolFilter: ['Read'],
    })
    expect(r.mode).toBe('continuable')
    expect(r.provider).toBe('fork')
    expect(r.toolFilter).toEqual(['Read'])
  })

  it('translateSubagentState maps running/waiting/settled', () => {
    for (const s of ['running', 'waiting', 'settled'] as const) {
      const r = translateSubagentState('s1', 'r1', s)
      expect(r.state).toBe(s)
    }
  })

  it('translateSubagentMessage passes blocks', () => {
    const r = translateSubagentMessage('s1', 'r1', [
      { type: 'text', text: 'hi' },
    ])
    expect(r.blocks).toHaveLength(1)
  })

  it('emitLegacyShim emits subagent.changed and warns', () => {
    const bus = { emit: vi.fn() }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    emitLegacyShim(bus as never, {
      type: 'subagent.start',
      ts: 0, sessionId: 's1', runId: 'r1',
      provider: 'spawn', id: 'x', local: true,
    })
    expect(bus.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'subagent.changed',
      taskId: 'r1',
      status: 'running',
      action: 'start',
    }))
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('emitLegacyShim maps subagent.end stopReason to status', () => {
    const bus = { emit: vi.fn() }
    emitLegacyShim(bus as never, {
      type: 'subagent.end',
      ts: 0, sessionId: 's1', runId: 'r1',
      provider: 'spawn', id: 'x', local: true, stopReason: 'aborted',
    })
    expect(bus.emit).toHaveBeenCalledWith(expect.objectContaining({
      status: 'cancelled',
      action: 'finish',
    }))
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

```bash
pnpm --filter @zn-ai/dsh-bridge test src/vendorSeam/eventTranslation.test.ts
```

期望:FAIL。

- [ ] **Step 3: 写实现**

在 `packages/dsh-bridge/src/vendorSeam/eventTranslation.ts`:

> **重要**:dsh-bridge 不依赖 zai(反向依赖会构建报错)。此文件不 import zai 类型,
> 改 emit **无类型对象**(`Record<string, unknown>`),zai-side zod 在收到时校验。
> 与 Task 3 `subagent/contentBlock.ts` 的 `SubagentContentBlock` 同构(zai 侧
> `shared/subagentEvents.ts` 的 `SubagentContentBlockSchema` 是消费侧镜像)。

```ts
import type { SubagentRunInfo, SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import type { SubagentContentBlock } from '../subagent/contentBlock.js'

/**
 * vendor 原生事件 → zai SSE 事件翻译层。
 *
 * deprecation shim:`emitLegacyShim` 同步发旧 `subagent.changed` 事件,
 * 让旧 UI 在迁移期仍能工作。运行期保留,2026-09-30 通过
 * feature flag `agent.subagent.eventV2.enabled = false` 关闭。
 */

export function translateSubagentStart(
  sessionId: string,
  info: SubagentRunInfo & { parentSessionId?: string },
): Record<string, unknown> {
  return {
    type: 'subagent.start',
    ts: Date.now(),
    sessionId,
    runId: info.runId,
    provider: info.provider,
    id: info.id,
    local: info.local,
    ...(info.parentSessionId !== undefined ? { parentSessionId: info.parentSessionId } : {}),
  }
}

const STOP_REASON_TO_LEGACY_STATUS: Record<string, string> = {
  completed: 'done',
  aborted: 'cancelled',
  error: 'failed',
  'max-tokens': 'failed',
  refusal: 'failed',
}

export function translateSubagentEnd(
  sessionId: string,
  info: SubagentRunEndInfo,
): Record<string, unknown> {
  return {
    type: 'subagent.end',
    ts: Date.now(),
    sessionId,
    runId: info.runId,
    provider: info.provider,
    id: info.id,
    local: info.local,
    stopReason: info.stopReason,
    ...(info.lastAssistantMessage !== undefined ? { lastAssistantMessage: info.lastAssistantMessage as SubagentContentBlock[] } : {}),
  }
}

export function translateSubagentDescriptor(
  sessionId: string,
  runId: string,
  info: {
    version: 2
    mode: 'one-shot' | 'continuable'
    provider: string
    label?: string
    persona?: string
    toolFilter?: string[]
    agentProvider?: string
    agentModel?: string
  },
): Record<string, unknown> {
  return {
    type: 'subagent.descriptor',
    ts: Date.now(),
    sessionId,
    runId,
    version: info.version,
    mode: info.mode,
    provider: info.provider,
    ...(info.label !== undefined ? { label: info.label } : {}),
    ...(info.persona !== undefined ? { persona: info.persona } : {}),
    ...(info.toolFilter !== undefined ? { toolFilter: info.toolFilter } : {}),
    ...(info.agentProvider !== undefined ? { agentProvider: info.agentProvider } : {}),
    ...(info.agentModel !== undefined ? { agentModel: info.agentModel } : {}),
  }
}

export function translateSubagentState(
  sessionId: string,
  runId: string,
  state: 'running' | 'waiting' | 'settled',
): Record<string, unknown> {
  return { type: 'subagent.state', ts: Date.now(), sessionId, runId, state }
}

export function translateSubagentMessage(
  sessionId: string,
  runId: string,
  blocks: SubagentContentBlock[],
): Record<string, unknown> {
  return { type: 'subagent.message', ts: Date.now(), sessionId, runId, blocks }
}

/**
 * deprecation shim:把新事件翻译成旧 `subagent.changed` 同步发到 eventBus。
 * UI 完全迁移后此函数删除。
 */
export function emitLegacyShim(
  eventBus: { emit: (e: unknown) => void },
  newEvent: Record<string, unknown>,
): void {
  if (!process.env.ZAI_SUBAGENT_EVENT_V2_ONLY) {
    console.warn(
      '[deprecation] subagent.changed will be removed after 2026-09-30; migrate to subagent.start/subagent.end',
    )
  }
  let legacy: Record<string, unknown> | null = null
  if (newEvent.type === 'subagent.start') {
    legacy = {
      type: 'subagent.changed',
      ts: newEvent.ts,
      sessionId: newEvent.sessionId,
      taskId: newEvent.runId,
      description: '',
      status: 'running',
      action: 'start',
    }
  } else if (newEvent.type === 'subagent.end') {
    legacy = {
      type: 'subagent.changed',
      ts: newEvent.ts,
      sessionId: newEvent.sessionId,
      taskId: newEvent.runId,
      description: '',
      status: STOP_REASON_TO_LEGACY_STATUS[newEvent.stopReason] ?? 'failed',
      action: 'finish',
    }
  } else if (newEvent.type === 'subagent.error') {
    legacy = {
      type: 'subagent.changed',
      ts: newEvent.ts,
      sessionId: newEvent.sessionId,
      taskId: newEvent.runId,
      description: '',
      status: 'failed',
      error: newEvent.message,
      action: 'finish',
    }
  }
  if (legacy) eventBus.emit(legacy)
}
```

> 注:上面 import `@deepseek-ai/dsh-subagent` 的 `SubagentRunInfo` / `SubagentRunEndInfo` 类型需在 dsh-bridge 内可消费(可能需要查 vendor 实际导出名;若不存在用 `any` 兜底)。可微调。

- [ ] **Step 4: 跑测试,确认通过**

```bash
pnpm --filter @zn-ai/dsh-bridge test src/vendorSeam/eventTranslation.test.ts
```

期望:PASS(7 tests)。

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-bridge/src/vendorSeam/eventTranslation.ts packages/dsh-bridge/test/vendorSeam/eventTranslation.test.ts
git commit -m "feat(dsh-bridge): 新增 vendorSeam eventTranslation 层(vendor 原生 → zai SSE + deprecation shim)"
```

---

## Task 7: dsh-bridge DshSubagentControlAdapter 多事件订阅 + capability 透传

**Files:**
- Modify: `packages/dsh-bridge/src/vendorSeam/subagent.ts:97-123`(扩展 cordis 订阅)
- Modify: `packages/dsh-bridge/src/vendorSeam/subagent.ts:125-191`(dispatch 透传 capability)
- Modify: `packages/dsh-bridge/src/vendorSeam/subagent.ts`(末尾新增 `startContinuable` + `sendMessage`)
- Test: `packages/dsh-bridge/test/vendorSeam/subagent.test.ts`(新建)

**Interfaces:**
- Consumes: vendor `ctx.on('subagent/start' | 'subagent/end' | 'subagent/descriptor' | 'subagent/state' | 'subagent/message')` + `ctx.subagents.continuation` + Task 6 `eventTranslation`
- Produces:
  - `DshSubagentControlAdapter` 多事件订阅后通过 `eventBus.emit(zai 新事件)` + `emitLegacyShim`
  - `dispatch` 透传 `outputSchema` / `toolFilter` / `persona` / `maxDepth` 到 `spawnDshSubagent`
  - `startContinuable(parentSessionId, prompt)` 转发到 Task 5 真实现

- [ ] **Step 1: 写失败测试**

在 `packages/dsh-bridge/test/vendorSeam/subagent.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { DshSubagentControlAdapter } from '../../src/vendorSeam/subagent.js'

describe('DshSubagentControlAdapter 多事件订阅', () => {
  it('订阅 5 个 vendor 事件并在 start 时 emit subagent.start', () => {
    const subs: Record<string, (info: unknown) => void> = {}
    const ctx = {
      on: (name: string, cb: (i: unknown) => void) => {
        subs[name] = cb
        return () => { delete subs[name] }
      },
      subagents: { start: async () => ({ id: 'r1', localAgent: undefined, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} }) },
      agents: { get: () => ({ id: 'p1' }) },
    } as never
    const eventBus = { emit: vi.fn() }
    new DshSubagentControlAdapter({ ctx, getParentAgent: () => ({ id: 'p1' } as never), eventBus: eventBus as never })
    expect(subs['subagent/start']).toBeDefined()
    expect(subs['subagent/end']).toBeDefined()
    expect(subs['subagent/state']).toBeDefined()
    expect(subs['subagent/descriptor']).toBeDefined()
    expect(subs['subagent/message']).toBeDefined()
    subs['subagent/start']!({ runId: 'r1', provider: 'spawn', id: 'd1', local: true })
    expect(eventBus.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'subagent.start' }))
  })

  it('dispatch 透传 capability 到 spawnDshSubagent', async () => {
    let capturedReq: unknown
    const ctx = {
      on: () => () => {},
      subagents: {
        start: async (_n: string, req: unknown) => {
          capturedReq = req
          return { id: 'r1', localAgent: undefined, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} }
        },
      },
      agents: { get: () => ({ id: 'p1' }) },
    } as never
    const a = new DshSubagentControlAdapter({ ctx, getParentAgent: () => ({ id: 'p1' } as never), eventBus: { emit: () => {} } as never })
    await a.dispatch({
      parentSessionId: 'p1', cwd: '/tmp', prompt: 'x',
      backgroundMode: 'async',
      context: 'spawn',
      outputSchema: { type: 'object' },
      toolFilter: ['Read'],
      persona: 'p', maxDepth: 1,
    })
    expect(capturedReq).toMatchObject({ outputSchema: { type: 'object' }, toolFilter: ['Read'], persona: 'p', maxDepth: 1 })
  })

  it('startContinuable 转发到 vendor continuation', async () => {
    const continuation = { startContinuable: vi.fn().mockResolvedValue({ childId: 'c1', messageId: 'm1' }) }
    const ctx = {
      on: () => () => {},
      subagents: { continuation },
      agents: { get: () => ({ id: 'p1' }) },
    } as never
    const a = new DshSubagentControlAdapter({ ctx, getParentAgent: () => ({ id: 'p1' } as never), eventBus: { emit: () => {} } as never })
    const r = await a.startContinuable({ parentSessionId: 'p1', prompt: 'hi' })
    expect(r).toEqual({ childId: 'c1', messageId: 'm1' })
    expect(continuation.startContinuable).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

```bash
pnpm --filter @zn-ai/dsh-bridge test src/vendorSeam/subagent.test.ts
```

期望:FAIL(订阅 5 个未实现;`startContinuable` 方法缺失;constructor 不接 eventBus 参数)。

- [ ] **Step 3: 修改 subagent.ts**

**a. constructor 接受 `eventBus` 参数:**

`packages/dsh-bridge/src/vendorSeam/subagent.ts:76-88`,扩展 opts 加 `eventBus`:

```ts
export interface DshSubagentAdapterOptions {
  ctx: Context
  getParentAgent: (sessionId: string) => Agent | undefined
  eventBus: { emit: (e: unknown) => void }  // 新增
}

export class DshSubagentControlAdapter implements SubagentControlSeam {
  private readonly ctx: Context
  private readonly getParentAgent: (sessionId: string) => Agent | undefined
  private readonly eventBus: { emit: (e: unknown) => void }  // 新增
  // ... (保留 changeListeners + cordisDisposers)

  constructor(opts: DshSubagentAdapterOptions) {
    this.ctx = opts.ctx
    this.getParentAgent = opts.getParentAgent
    this.eventBus = opts.eventBus
    this.installCordisListeners()
  }
```

**b. cordis 订阅扩展到 5 个事件:**

`packages/dsh-bridge/src/vendorSeam/subagent.ts:97-123`:

```ts
private installCordisListeners(): void {
  try {
    const handlers: Array<[string, (info: unknown) => void]> = [
      ['subagent/start', (info) => {
        const startEvt = translateSubagentStart(this.getCurrentSessionId(), info as never)
        this.eventBus.emit(startEvt)
        emitLegacyShim(this.eventBus, startEvt)
      }],
      ['subagent/end', (info) => {
        const endEvt = translateSubagentEnd(this.getCurrentSessionId(), info as never)
        this.eventBus.emit(endEvt)
        emitLegacyShim(this.eventBus, endEvt)
      }],
      ['subagent/descriptor', (info) => {
        const descEvt = translateSubagentDescriptor(
          this.getCurrentSessionId(),
          (info as { runId: string }).runId,
          info as never,
        )
        this.eventBus.emit(descEvt)
      }],
      ['subagent/state', (info) => {
        const stateEvt = translateSubagentState(
          this.getCurrentSessionId(),
          (info as { runId: string }).runId,
          (info as { state: 'running' | 'waiting' | 'settled' }).state,
        )
        this.eventBus.emit(stateEvt)
      }],
      ['subagent/message', (info) => {
        const msgEvt = translateSubagentMessage(
          this.getCurrentSessionId(),
          (info as { runId: string }).runId,
          (info as { blocks: SubagentContentBlock[] }).blocks,
        )
        this.eventBus.emit(msgEvt)
      }],
    ]
    for (const [name, cb] of handlers) {
      const off = this.ctx.on(name, cb as never)
      if (typeof off === 'function') this.cordisDisposers.push(off)
    }
  } catch (err) {
    console.warn(
      '[dsh-bridge] SubagentControlSeam: ctx.on subagent/* 不支持,降级到磁盘 polling — 变更感知延迟 < 500ms',
      err,
    )
  }
}

private getCurrentSessionId(): string {
  // 优先从 ctx.agents 拿当前 sessionId;fallback 走 globalThis
  const agents = this.ctx.get('agents') as { getCurrentSessionId?: () => string | undefined } | undefined
  return agents?.getCurrentSessionId?.() ?? ''
}
```

> 注:`getCurrentSessionId` 实现细节需读 ctx.agents 实际 API;若没有,fallback 用 globalThis `__zaiCurrentSessionId`。

**c. dispatch 透传 capability:**

`packages/dsh-bridge/src/vendorSeam/subagent.ts:165-176`,改 spawnDshSubagent 调用:

```ts
handle = await spawnDshSubagent(this.ctx, {
  parentSessionId: input.parentSessionId,
  parentAgent,
  prompt: input.prompt,
  cwd: input.cwd,
  providerName,
  ...(input.model !== undefined ? { model: input.model } : {}),
  ...(input.provider !== undefined ? { provider: input.provider } : {}),
  ...(input.outputSchema !== undefined ? { outputSchema: input.outputSchema } : {}),
  ...(input.toolFilter !== undefined ? { toolFilter: input.toolFilter } : {}),
  ...(input.persona !== undefined ? { persona: input.persona } : {}),
  ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
})
```

**d. 末尾新增 `startContinuable` 方法:**

```ts
async startContinuable(opts: {
  parentSessionId: string
  childId?: string
  prompt: string
  messageId?: string
}): Promise<{ childId: string; messageId: string }> {
  const { startContinuable: vendorStart } = await import('../subagent/continuation.js')
  return vendorStart(this.ctx, opts)
}
```

> 注:`sendMessage` 已存在(`vendorSeam/subagent.ts:219`),无需新增。

- [ ] **Step 4: 跑测试,确认通过**

```bash
pnpm --filter @zn-ai/dsh-bridge test src/vendorSeam/subagent.test.ts
```

期望:PASS(3 tests)。

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-bridge/src/vendorSeam/subagent.ts packages/dsh-bridge/test/vendorSeam/subagent.test.ts
git commit -m "feat(dsh-bridge): DshSubagentControlAdapter 多事件订阅 + capability 透传 + startContinuable"
```

---

## Task 8: zai 新增 SeamRegistry + seamBinding(kernel.getSeam 接口)

**Files:**
- Modify: `packages/zai/src/server/services/kernel/kernelAdapter.ts:153-...`(扩展 `KernelAdapter` interface 加 `seamRegistry` + `getSeam`)
- Create: `packages/zai/src/server/services/kernel/seamRegistry.ts`
- Create: `packages/zai/src/server/services/kernel/seamBinding.ts`
- Test: `packages/zai/test/server/services/kernel/seamRegistry.test.ts`
- Test: `packages/zai/test/server/services/kernel/seamBinding.test.ts`

> **前置**:现有 `KernelAdapter` interface(`packages/zai/src/server/services/kernel/kernelAdapter.ts:153`)不含 `getSeam` / `seamRegistry` 字段。本 Task 在 interface 上**新增这两个字段**(`seamRegistry?: SeamRegistry` + `getSeam<T>(name): T`),DSH 工厂实现时填,OpenCC 工厂不填(调用时抛 `MissingVendorSeamError`)。

**Interfaces:**
- Consumes: dsh-bridge `DshSubagentControlAdapter` / `DshJobsControlAdapter`(`@zn-ai/dsh-bridge/vendorSeam`)
- Produces:
  - `SeamRegistry` class,提供 `register<T>(name, instance)` / `get<T>(name): T`(缺失抛 `MissingVendorSeamError`)
  - `bindSeams(kernel, ctx, eventBus): void` — 把 dsh-bridge adapters 注入到 kernel

- [ ] **Step 1: 写失败测试**

`packages/zai/test/server/services/kernel/seamRegistry.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { SeamRegistry, MissingVendorSeamError } from '../../../../src/server/services/kernel/seamRegistry.js'

describe('SeamRegistry', () => {
  it('register + get 解析', () => {
    const reg = new SeamRegistry()
    const seam = { foo: () => 'bar' }
    reg.register('test', seam)
    expect(reg.get<typeof seam>('test')).toBe(seam)
  })

  it('get 缺失抛 MissingVendorSeamError', () => {
    const reg = new SeamRegistry()
    expect(() => reg.get('nope')).toThrow(MissingVendorSeamError)
  })

  it('register 同名覆盖', () => {
    const reg = new SeamRegistry()
    const a = { x: 1 }
    const b = { x: 2 }
    reg.register('s', a)
    reg.register('s', b)
    expect(reg.get('s')).toBe(b)
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

```bash
pnpm --filter @zn-ai/zai test src/server/services/kernel/seamRegistry.test.ts
```

期望:FAIL。

- [ ] **Step 3: 写实现**

`packages/zai/src/server/services/kernel/seamRegistry.ts`:

```ts
/**
 * vendorSeam 注册表 — zai 与 dsh-bridge 唯一接口。
 *
 * 替代 globalThis 桥(`__zaiDshSubagentControl` / `__zaiDshSubagentDetail`)。
 * zai-side 不再 import `@zn-ai/dsh-bridge` 内部函数,只通过 `kernel.getSeam(name)`。
 */

export class MissingVendorSeamError extends Error {
  constructor(public readonly seamName: string) {
    super(`[zai] MissingVendorSeamError: seam "${seamName}" not registered`)
    this.name = 'MissingVendorSeamError'
  }
}

export type SeamName = 'subagent' | 'jobs'

export class SeamRegistry {
  private readonly seams = new Map<string, unknown>()

  register<T>(name: SeamName, instance: T): void {
    this.seams.set(name, instance)
  }

  get<T>(name: SeamName): T {
    const seam = this.seams.get(name)
    if (!seam) throw new MissingVendorSeamError(name)
    return seam as T
  }

  has(name: SeamName): boolean {
    return this.seams.has(name)
  }

  /** 测试用 — 清空所有 seam。 */
  clear(): void {
    this.seams.clear()
  }
}
```

`packages/zai/src/server/services/kernel/seamBinding.ts`:

```ts
import type { Context } from '@deepseek-ai/cordis'
import { DshSubagentControlAdapter, DshJobsControlAdapter } from '@zn-ai/dsh-bridge'
import type { SeamRegistry } from './seamRegistry.js'

/**
 * 把 dsh-bridge adapters 绑定到 SeamRegistry。
 *
 * 调用时机:kernel factory 创建 DSH runtime 后(zai-side `factories/dsh.ts`)立即调。
 * 失败 fail loud — 缺失 dsh-bridge adapters 抛 `MissingVendorSeamError`。
 */

export interface BindSeamsOpts {
  registry: SeamRegistry
  ctx: Context
  eventBus: { emit: (e: unknown) => void }
  getParentAgent: (sessionId: string) => import('@deepseek-ai/cordis').Agent | undefined
}

export function bindSeams(opts: BindSeamsOpts): void {
  const subagent = new DshSubagentControlAdapter({
    ctx: opts.ctx,
    getParentAgent: opts.getParentAgent,
    eventBus: opts.eventBus,
  })
  const jobs = new DshJobsControlAdapter({
    ctx: opts.ctx,
    eventBus: opts.eventBus,
  })
  opts.registry.register('subagent', subagent)
  opts.registry.register('jobs', jobs)
}
```

- [ ] **Step 4: 跑测试,确认通过**

```bash
pnpm --filter @zn-ai/zai test src/server/services/kernel/seamRegistry.test.ts
```

期望:PASS(3 tests)。

`packages/zai/test/server/services/kernel/seamBinding.test.ts`(smoke test):

```ts
import { describe, expect, it } from 'vitest'
import { bindSeams } from '../../../../src/server/services/kernel/seamBinding.js'
import { SeamRegistry } from '../../../../src/server/services/kernel/seamRegistry.js'

describe('bindSeams', () => {
  it('registers subagent + jobs', () => {
    const reg = new SeamRegistry()
    bindSeams({
      registry: reg,
      ctx: { on: () => () => {}, get: () => undefined, subagents: {} } as never,
      eventBus: { emit: () => {} },
      getParentAgent: () => undefined,
    })
    expect(reg.has('subagent')).toBe(true)
    expect(reg.has('jobs')).toBe(true)
  })
})
```

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/server/services/kernel/seamRegistry.ts packages/zai/src/server/services/kernel/seamBinding.ts packages/zai/test/server/services/kernel/seamRegistry.test.ts packages/zai/test/server/services/kernel/seamBinding.test.ts
git commit -m "feat(zai): 新增 SeamRegistry + bindSeams(kernel.getSeam 接口)"
```

---

## Task 9: kernel/factories/dsh.ts 注入 seamRegistry + 订阅 vendor 多事件

**Files:**
- Modify: `packages/zai/src/server/services/kernel/factories/dsh.ts`(末尾新增 seamRegistry 实例 + bindSeams 调用 + 移除 globalThis 桥)
- Modify: `packages/zai/src/server/services/kernel/factories/dsh.ts:570-597`(`onTaskStart` / `onTaskFinish` 改为订阅 vendor 多事件)
- Test: `packages/zai/test/server/services/kernel/factories/dsh.test.ts`(新建)

**Interfaces:**
- Consumes: Task 8 `SeamRegistry` + `bindSeams`;vendor `ctx.on('subagent/*')`;Task 4-7 的 capability 透传
- Produces:
  - kernel 实例带 `seamRegistry: SeamRegistry` + `getSeam<T>(name)` 方法
  - DSH factory 不再 emit `subagent.changed`,改由 vendorSeam 自动 emit 新事件
  - 移除 `__zaiDshSubagentControl` / `__zaiDshSubagentDetail` globalThis 写入

- [ ] **Step 1: 写失败测试**

`packages/zai/test/server/services/kernel/factories/dsh.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createDshKernel } from '../../../../../src/server/services/kernel/factories/dsh.js'

describe('DSH kernel factory 注入 seamRegistry', () => {
  it('kernel.getSeam("subagent") 可解析', async () => {
    // 用最小 mock ctx,确认 seamRegistry 注册成功
    const ctx = {
      on: () => () => {}, get: () => undefined,
      plugin: () => () => {},
      scope: () => ({ plugin: () => () => {} }),
    } as never
    const kernel = await createDshKernel({
      ctx, eventBus: { emit: () => {} }, getCurrentSessionId: () => 's1',
      getParentAgent: () => undefined,
      // ... 其他 deps mock
    })
    expect(kernel.getSeam('subagent')).toBeDefined()
    expect(kernel.getSeam('jobs')).toBeDefined()
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

```bash
pnpm --filter @zn-ai/zai test src/server/services/kernel/factories/dsh.test.ts
```

期望:FAIL。

- [ ] **Step 3: 修改 factories/dsh.ts**

**a. factory 末尾新增 seamRegistry 注入:**

找到现有 `factories/dsh.ts` 的 `createDshKernel`(或类似导出函数),在所有初始化完成后(末尾 return 前)加入:

```ts
import { SeamRegistry } from './seamRegistry.js'
import { bindSeams } from './seamBinding.js'

const seamRegistry = new SeamRegistry()
bindSeams({
  registry: seamRegistry,
  ctx: handle.ctx,
  eventBus: getEventBus(),
  getParentAgent: (sessionId) => {
    const agents = handle.ctx.get('agents') as { get: (id: string) => import('@deepseek-ai/cordis').Agent | undefined } | undefined
    return agents?.get(sessionId)
  },
})
```

**b. return 对象加 `getSeam` + `seamRegistry`:**

```ts
return {
  ...existingReturnFields,
  seamRegistry,
  getSeam<T>(name: 'subagent' | 'jobs'): T {
    return seamRegistry.get<T>(name)
  },
}
```

**c. `onTaskStart` / `onTaskFinish` 标记 deprecated:**

`packages/zai/src/server/services/kernel/factories/dsh.ts:570-597`,保留回调函数签名(registerZaiTools opts 仍要这两个 callback),但**不再 emit** `subagent.changed`(vendorSeam 已自动发):

```ts
onTaskStart: ({ taskId, prompt }) => {
  // Deprecated 2026-08-24:不再 emit subagent.changed;
  // vendorSeam DshSubagentControlAdapter 在 ctx.on('subagent/start') 时自动 emit subagent.start
  // + deprecation shim。详见 spec §4 + §10。
  console.debug('[zai] dsh factory onTaskStart (deprecated no-op):', taskId)
},
onTaskFinish: ({ taskId, status, error }) => {
  console.debug('[zai] dsh factory onTaskFinish (deprecated no-op):', taskId, status)
},
```

**d. registerZaiTools 透传 capability:**

找到 `registerZaiTools(...)` 调用段(估计 line 524-624 附近),`spawnSubagent` 函数体内补 capability:

```ts
spawnSubagent: (input) =>
  seamRegistry.get<import('@zn-ai/dsh-bridge').SubagentControlSeam>('subagent').dispatch({
    parentSessionId: input.parentSessionId,
    cwd: input.cwd,
    prompt: input.prompt,
    backgroundMode: input.runInBackground ? 'async' : 'sync',
    context: input.provider ?? 'spawn',  // 'spawn' | 'fork'
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    // 新增透传(Stage 5/7 真接):
    ...(input.outputSchema !== undefined ? { outputSchema: input.outputSchema } : {}),
    ...(input.toolFilter !== undefined ? { toolFilter: input.toolFilter } : {}),
    ...(input.persona !== undefined ? { persona: input.persona } : {}),
    ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
  }),
```

`completionDelivery` 从 settings.json 读(在 factory 初始化时):

```ts
const settings = getSettings()
const defaultCompletionDelivery = settings.agent?.subagent?.completionDelivery ?? 'wakeup'
// 把 defaultCompletionDelivery 闭包进 spawnSubagent;input.completionDelivery ?? default
```

**e. 移除 globalThis 桥:**

`packages/zai/src/server/services/kernel/factories/dsh.ts:710-790`,删除以下:

```ts
// 整段删除
;(globalThis as any).__zaiDshSubagentControl = ...
;(globalThis as any).__zaiDshSubagentDetail = ...
```

- [ ] **Step 4: 跑测试,确认通过**

```bash
pnpm --filter @zn-ai/zai test src/server/services/kernel/factories/dsh.test.ts
```

期望:PASS(1 test)。同时跑 dsh-bridge 既有 subagent 测试,确认未破坏:

```bash
pnpm --filter @zn-ai/dsh-bridge test
```

期望:PASS(原 15 tests + Task 4-7 新增 ~15 tests,共 30+ 全绿)。

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/server/services/kernel/factories/dsh.ts packages/zai/test/server/services/kernel/factories/dsh.test.ts
git commit -m "feat(zai): kernel factory 注入 SeamRegistry + 订阅 vendor 多事件;移除 globalThis 桥"
```

---

## Task 10: zai routes/subagentTasks 改走 seamRegistry(去掉 tryGetDshBridge)

**Files:**
- Modify: `packages/zai/src/server/routes/subagentTasks.ts`(全文,所有 `tryGetDshBridge()` / `tryGetDshDetailBridge()` 改走 `kernel.getSeam('subagent')`)
- Modify: `packages/zai/src/server/routes/subagentTasks.ts`(末尾新增 `POST /:id/continuable`)
- Test: `packages/zai/test/server/routes/subagentTasks.test.ts`(新建)

**Interfaces:**
- Consumes: Task 8 `kernel.getSeam('subagent')` 接口;Task 9 factory 注入
- Produces: 路由 handler 全部走 seam,无 globalThis 桥;新增 `continuable` 端点

- [ ] **Step 1: 写失败测试**

`packages/zai/test/server/routes/subagentTasks.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createSubagentTasksRouter } from '../../../../src/server/routes/subagentTasks.js'

describe('subagentTasks routes 走 seamRegistry', () => {
  it('GET /subagent-tasks 调 seam.list', async () => {
    const seam = { list: vi.fn().mockResolvedValue([]), get: vi.fn(), cancel: vi.fn(), sendMessage: vi.fn(), startContinuable: vi.fn() }
    const router = createSubagentTasksRouter({
      kernel: { getSeam: () => seam } as never,
    })
    // supertest 风格调用 — 实际可能需要 mount 到 fastify/express 实例
    // 此处只验证 seam.list 被调
    await router.handle({ method: 'GET', url: '/subagent-tasks', query: { sessionId: 's1' } } as never, { json: () => {} } as never)
    expect(seam.list).toHaveBeenCalledWith('s1')
  })

  it('POST /:id/continuable 调 seam.startContinuable', async () => {
    const seam = { list: vi.fn(), get: vi.fn(), cancel: vi.fn(), sendMessage: vi.fn(), startContinuable: vi.fn().mockResolvedValue({ childId: 'c1', messageId: 'm1' }) }
    const router = createSubagentTasksRouter({ kernel: { getSeam: () => seam } as never })
    await router.handle({ method: 'POST', url: '/subagent-tasks/abc/continuable', params: { id: 'abc' }, body: { prompt: 'hi' } } as never, { json: () => {}, status: () => ({ json: () => {} }) } as never)
    expect(seam.startContinuable).toHaveBeenCalledWith({ parentSessionId: 'abc', prompt: 'hi' })
  })
})
```

> 注:具体 supertest / fastify.inject 调用形式需匹配项目既有路由测试模式(参考 `packages/zai/test/server/routes/` 已存在的测试)。

- [ ] **Step 2: 跑测试,确认失败**

```bash
pnpm --filter @zn-ai/zai test src/server/routes/subagentTasks.test.ts
```

期望:FAIL。

- [ ] **Step 3: 重写 routes**

`packages/zai/src/server/routes/subagentTasks.ts`:

**a. 删除顶部 `tryGetDshBridge` / `tryGetDshDetailBridge` import 与使用。**

**b. 改为接收 kernel:**

```ts
import { Router, type Request, type Response } from 'express'
import type { Kernel } from '../services/kernel/index.js'
import { MissingVendorSeamError } from '../services/kernel/seamRegistry.js'

export function createSubagentTasksRouter(opts: { kernel: Kernel }): Router {
  const router = Router()
  const seam = () => opts.kernel.getSeam<SubagentControlSeam>('subagent')
  // ... (各 handler)
  return router
}
```

**c. 各 handler 改用 `seam().list(...)` / `seam().get(...)` / `seam().cancel(...)` / `seam().sendMessage(...)`:**

具体替换:
- `bridge.list(sessionId)` → `seam().list(sessionId)`
- `bridge.list(undefined)` → `seam().list(undefined)`
- `detailBridge.readTask(id)` → `seam().get(id)`
- `bridge.list().find(...)` → `seam().list().then(arr => arr.find(...))`
- 中断:`bridge.interrupt(id)` → `seam().cancel(id)`
- send-message:已有 `bridge.sendMessage(id, content)` → `seam().sendMessage(id, content)`

**d. 新增 continuable 端点(末尾):**

```ts
/**
 * POST /api/subagent-tasks/:id/continuable
 *   body: { prompt: string, childId?: string, messageId?: string }
 *   启动一个 continuable 子代理(持久多轮会话)。
 *   返回 { childId, messageId }
 */
router.post('/subagent-tasks/:id/continuable', async (req: Request, res: Response) => {
  try {
    const parentSessionId = req.params.id
    const { prompt, childId, messageId } = req.body as { prompt: string; childId?: string; messageId?: string }
    if (!prompt) return res.status(400).json({ error: 'prompt_required' })
    const result = await seam().startContinuable({
      parentSessionId,
      prompt,
      ...(childId !== undefined ? { childId } : {}),
      ...(messageId !== undefined ? { messageId } : {}),
    })
    return res.json(result)
  } catch (err) {
    if (err instanceof MissingVendorSeamError) {
      return res.status(503).json({ error: 'dsh_subagent_unavailable', message: err.message })
    }
    return res.status(500).json({ error: 'continuable_failed', message: err instanceof Error ? err.message : String(err) })
  }
})
```

**e. 替换原 export:**

把 `export default router` 改为 `export { createSubagentTasksRouter }`,并在 zai app 启动时调:

```ts
// zai server bootstrap(查找位置)
app.use('/api', createSubagentTasksRouter({ kernel: getCurrentKernel() }))
```

- [ ] **Step 4: 跑测试,确认通过**

```bash
pnpm --filter @zn-ai/zai test src/server/routes/subagentTasks.test.ts
```

期望:PASS(2+ tests)。

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/server/routes/subagentTasks.ts packages/zai/test/server/routes/subagentTasks.test.ts
git commit -m "refactor(zai): subagentTasks 路由改走 seamRegistry;新增 /:id/continuable 端点"
```

---

## Task 11: stateBridge 转发 6 个新事件 + 删除 subagent.changed 翻译

**Files:**
- Modify: `packages/zai/src/server/services/stateBridge.ts:90-101`(替换 onSubagentChanged)

**Interfaces:**
- Consumes: Task 1 `SubagentEvent` zod schema
- Produces: stateBridge 监听 6 个新事件类型(`subagent.start` / `end` / `descriptor` / `state` / `message` / `error`),每个转发到 `eventBus.emit` 直通 SSE

- [ ] **Step 1: 写失败测试**

`packages/zai/test/server/services/stateBridge.test.ts`(若不存在则新建):

```ts
import { describe, expect, it, vi } from 'vitest'
import { installStateBridge } from '../../../../src/server/services/stateBridge.js'

describe('stateBridge subagent 事件转发', () => {
  it('subagent.start 直通到 eventBus', () => {
    const eventBus = { emit: vi.fn() }
    const stateChangeBus = { on: (name: string, cb: (e: unknown) => void) => { handlers[name] = cb }, off: () => {} }
    const handlers: Record<string, (e: unknown) => void> = {}
    installStateBridge({ eventBus: eventBus as never, stateChangeBus: stateChangeBus as never })
    handlers['subagent.start']!({ type: 'subagent.start', ts: 0, sessionId: 's1', runId: 'r1', provider: 'spawn', id: 'x', local: true })
    expect(eventBus.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'subagent.start' }))
  })

  it('subagent.end 直通到 eventBus', () => {
    // 类似上
  })

  it('subagent.state 直通到 eventBus', () => {
    // 类似上
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

```bash
pnpm --filter @zn-ai/zai test src/server/services/stateBridge.test.ts
```

期望:FAIL(只注册了 `subagent.changed`,没有 6 个新事件)。

- [ ] **Step 3: 修改 stateBridge.ts**

`packages/zai/src/server/services/stateBridge.ts:90-101`,替换 `onSubagentChanged` 为 6 个 handler:

```ts
// 旧 subagent.changed handler 删除(deprecation shim 由 vendorSeam 处理)
const onSubagentStart = (e: SubagentStartEvent) => eventBus.emit(e)
const onSubagentEnd = (e: SubagentEndEvent) => eventBus.emit(e)
const onSubagentDescriptor = (e: SubagentDescriptorEvent) => eventBus.emit(e)
const onSubagentState = (e: SubagentStateEvent) => eventBus.emit(e)
const onSubagentMessage = (e: SubagentMessageEvent) => eventBus.emit(e)
const onSubagentError = (e: SubagentErrorEvent) => eventBus.emit(e)
stateChangeBus.on('subagent.start', onSubagentStart)
stateChangeBus.on('subagent.end', onSubagentEnd)
stateChangeBus.on('subagent.descriptor', onSubagentDescriptor)
stateChangeBus.on('subagent.state', onSubagentState)
stateChangeBus.on('subagent.message', onSubagentMessage)
stateChangeBus.on('subagent.error', onSubagentError)
```

顶部 import 新增:

```ts
import type {
  SubagentStartEvent,
  SubagentEndEvent,
  SubagentDescriptorEvent,
  SubagentStateEvent,
  SubagentMessageEvent,
  SubagentErrorEvent,
} from '../../shared/subagentEvents.js'
```

`_stateBridgeDispose` 中 off 同步改:

```ts
_stateBridgeDispose = () => {
  stateChangeBus.off('subagent.start', onSubagentStart)
  stateChangeBus.off('subagent.end', onSubagentEnd)
  stateChangeBus.off('subagent.descriptor', onSubagentDescriptor)
  stateChangeBus.off('subagent.state', onSubagentState)
  stateChangeBus.off('subagent.message', onSubagentMessage)
  stateChangeBus.off('subagent.error', onSubagentError)
  // ... (保留其它 off 调用)
}
```

- [ ] **Step 4: 跑测试,确认通过**

```bash
pnpm --filter @zn-ai/zai test src/server/services/stateBridge.test.ts
```

期望:PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/server/services/stateBridge.ts packages/zai/test/server/services/stateBridge.test.ts
git commit -m "feat(zai): stateBridge 转发 6 个 subagent vendor 事件;删除 subagent.changed 翻译"
```

---

## Task 12: useAgentStore 新增 6 个 reducer + applySubagentChanged 标 deprecated

**Files:**
- Modify: `packages/zai/src/web/src/store/useAgentStore.ts:2165-2203`

**Interfaces:**
- Consumes: Task 1 `SubagentEvent` zod schema;Task 11 SSE event handler
- Produces: 6 个 reducer (`applySubagentStart` / `applySubagentEnd` / `applySubagentDescriptor` / `applySubagentState` / `applySubagentMessage` / `applySubagentError`);`subagentTasksBySession[id]` 增加 `state: 'running' | 'waiting' | 'settled'` + `descriptor` 字段

- [ ] **Step 1: 写失败测试**

`packages/zai/test/web/store/useAgentStore.test.ts`(若不存在则新建):

```ts
import { describe, expect, it } from 'vitest'
import { useAgentStore } from '../../../../src/web/src/store/useAgentStore.js'

describe('useAgentStore subagent reducer', () => {
  it('applySubagentStart 在 subagentTasksBySession 添加 running 任务', () => {
    useAgentStore.getState().applySubagentStart({
      type: 'subagent.start', ts: 0, sessionId: 's1', runId: 'r1',
      provider: 'spawn', id: 'x', local: true,
    })
    const t = useAgentStore.getState().subagentTasksBySession['s1']?.find(x => x.taskId === 'r1')
    expect(t?.status).toBe('running')
  })

  it('applySubagentEnd 把任务状态改为 done + lastAssistantMessage', () => {
    useAgentStore.getState().applySubagentStart({
      type: 'subagent.start', ts: 0, sessionId: 's1', runId: 'r2',
      provider: 'spawn', id: 'x', local: true,
    })
    useAgentStore.getState().applySubagentEnd({
      type: 'subagent.end', ts: 0, sessionId: 's1', runId: 'r2',
      provider: 'spawn', id: 'x', local: true, stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'hi' }],
    })
    const t = useAgentStore.getState().subagentTasksBySession['s1']?.find(x => x.taskId === 'r2')
    expect(t?.status).toBe('done')
    expect(t?.lastAssistantMessage).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('applySubagentState 改 running/waiting/settled', () => {
    useAgentStore.getState().applySubagentStart({
      type: 'subagent.start', ts: 0, sessionId: 's1', runId: 'r3',
      provider: 'spawn', id: 'x', local: true,
    })
    useAgentStore.getState().applySubagentState({
      type: 'subagent.state', ts: 0, sessionId: 's1', runId: 'r3', state: 'waiting',
    })
    const t = useAgentStore.getState().subagentTasksBySession['s1']?.find(x => x.taskId === 'r3')
    expect(t?.state).toBe('waiting')
  })

  it('applySubagentDescriptor 写入 descriptor 字段', () => {
    useAgentStore.getState().applySubagentStart({
      type: 'subagent.start', ts: 0, sessionId: 's1', runId: 'r4',
      provider: 'fork', id: 'x', local: true,
    })
    useAgentStore.getState().applySubagentDescriptor({
      type: 'subagent.descriptor', ts: 0, sessionId: 's1', runId: 'r4',
      version: 2, mode: 'one-shot', provider: 'fork', label: 'investigate', persona: 'p', toolFilter: ['Read'],
    })
    const t = useAgentStore.getState().subagentTasksBySession['s1']?.find(x => x.taskId === 'r4')
    expect(t?.descriptor?.provider).toBe('fork')
    expect(t?.descriptor?.persona).toBe('p')
  })

  it('applySubagentMessage 累积 blocks', () => {
    useAgentStore.getState().applySubagentStart({
      type: 'subagent.start', ts: 0, sessionId: 's1', runId: 'r5',
      provider: 'spawn', id: 'x', local: true,
    })
    useAgentStore.getState().applySubagentMessage({
      type: 'subagent.message', ts: 0, sessionId: 's1', runId: 'r5',
      blocks: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: 'answer' }],
    })
    const t = useAgentStore.getState().subagentTasksBySession['s1']?.find(x => x.taskId === 'r5')
    expect(t?.blocks).toHaveLength(2)
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

```bash
pnpm --filter @zn-ai/zai test src/web/store/useAgentStore.test.ts
```

期望:FAIL。

- [ ] **Step 3: 修改 useAgentStore.ts**

`packages/zai/src/web/src/store/useAgentStore.ts:2165-2203`,找到现有 `applySubagentChanged` reducer,标记 deprecated 并新增 6 个:

```ts
/**
 * @deprecated 自 2026-08-24 起使用 6 个 vendor 原生事件 reducer;
 * 旧 subagent.changed handler 保留至 2026-09-30(由 useEventStream 自动转发)。
 */
applySubagentChanged: (event) => {
  // 保留旧逻辑不删
  set((state) => { /* 旧 reducer body */ })
},

applySubagentStart: (event) => {
  set((state) => {
    const sid = event.sessionId
    const list = state.subagentTasksBySession[sid] ?? []
    const existing = list.find(t => t.taskId === event.runId)
    if (existing) {
      return {
        subagentTasksBySession: {
          ...state.subagentTasksBySession,
          [sid]: list.map(t => t.taskId === event.runId
            ? { ...t, status: 'running' as const, provider: event.provider, parentSessionId: event.parentSessionId ?? t.parentSessionId }
            : t),
        },
      }
    }
    return {
      subagentTasksBySession: {
        ...state.subagentTasksBySession,
        [sid]: [...list, {
          taskId: event.runId,
          sessionId: event.id,
          parentSessionId: event.parentSessionId,
          status: 'running' as const,
          provider: event.provider,
          state: 'running' as const,
          startedAt: event.ts,
          blocks: [],
        }],
      },
    }
  })
},

applySubagentEnd: (event) => {
  set((state) => {
    const sid = event.sessionId
    const list = state.subagentTasksBySession[sid] ?? []
    return {
      subagentTasksBySession: {
        ...state.subagentTasksBySession,
        [sid]: list.map(t => t.taskId === event.runId
          ? {
              ...t,
              status: (event.stopReason === 'completed' ? 'done' :
                       event.stopReason === 'aborted' ? 'cancelled' :
                       'failed') as 'done' | 'cancelled' | 'failed',
              stopReason: event.stopReason,
              ...(event.lastAssistantMessage ? { lastAssistantMessage: event.lastAssistantMessage } : {}),
              finishedAt: event.ts,
            }
          : t),
      },
    }
  })
},

applySubagentDescriptor: (event) => {
  set((state) => {
    const sid = event.sessionId
    const list = state.subagentTasksBySession[sid] ?? []
    return {
      subagentTasksBySession: {
        ...state.subagentTasksBySession,
        [sid]: list.map(t => t.taskId === event.runId ? { ...t, descriptor: event } : t),
      },
    }
  })
},

applySubagentState: (event) => {
  set((state) => {
    const sid = event.sessionId
    const list = state.subagentTasksBySession[sid] ?? []
    return {
      subagentTasksBySession: {
        ...state.subagentTasksBySession,
        [sid]: list.map(t => t.taskId === event.runId ? { ...t, state: event.state } : t),
      },
    }
  })
},

applySubagentMessage: (event) => {
  set((state) => {
    const sid = event.sessionId
    const list = state.subagentTasksBySession[sid] ?? []
    return {
      subagentTasksBySession: {
        ...state.subagentTasksBySession,
        [sid]: list.map(t => t.taskId === event.runId
          ? { ...t, blocks: [...(t.blocks ?? []), ...event.blocks] }
          : t),
      },
    }
  })
},

applySubagentError: (event) => {
  set((state) => {
    const sid = event.sessionId
    const list = state.subagentTasksBySession[sid] ?? []
    return {
      subagentTasksBySession: {
        ...state.subagentTasksBySession,
        [sid]: list.map(t => t.taskId === event.runId
          ? { ...t, status: 'failed' as const, error: event.message }
          : t),
      },
    }
  })
},
```

> 注:`subagentTasksBySession[id]` 元素类型需扩展为新 shape(state / descriptor / blocks / lastAssistantMessage / stopReason),需要修改 store 顶部的 `SubagentTaskState` interface。

- [ ] **Step 4: 跑测试,确认通过**

```bash
pnpm --filter @zn-ai/zai test src/web/store/useAgentStore.test.ts
```

期望:PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/web/src/store/useAgentStore.ts packages/zai/test/web/store/useAgentStore.test.ts
git commit -m "feat(zai): useAgentStore 新增 6 个 subagent vendor 事件 reducer + state/descriptor/blocks 字段"
```

---

## Task 13: useEventStream 路由 6 个新事件到对应 reducer

**Files:**
- Modify: `packages/zai/src/web/src/store/useEventStream.ts:148-152`

**Interfaces:**
- Consumes: Task 12 reducer;Task 1 zod schema
- Produces: SSE event handler 分发 6 个新事件到 `applySubagentStart` / `applySubagentEnd` / `applySubagentDescriptor` / `applySubagentState` / `applySubagentMessage` / `applySubagentError`;旧 `subagent.changed` handler 标记 deprecated

- [ ] **Step 1: 写失败测试**

`packages/zai/test/web/store/useEventStream.test.ts`(若不存在则新建):

```ts
import { describe, expect, it, vi } from 'vitest'
import { useEventStream } from '../../../../src/web/src/store/useEventStream.js'
import { useAgentStore } from '../../../../src/web/src/store/useAgentStore.js'

describe('useEventStream subagent 事件分发', () => {
  it('subagent.start 调 applySubagentStart', () => {
    const spy = vi.spyOn(useAgentStore.getState(), 'applySubagentStart')
    useEventStream.handleEvent({
      type: 'subagent.start', ts: 0, sessionId: 's1', runId: 'r1',
      provider: 'spawn', id: 'x', local: true,
    })
    expect(spy).toHaveBeenCalled()
  })

  it('subagent.end 调 applySubagentEnd', () => {
    const spy = vi.spyOn(useAgentStore.getState(), 'applySubagentEnd')
    useEventStream.handleEvent({
      type: 'subagent.end', ts: 0, sessionId: 's1', runId: 'r1',
      provider: 'spawn', id: 'x', local: true, stopReason: 'completed',
    })
    expect(spy).toHaveBeenCalled()
  })

  it('subagent.state 调 applySubagentState', () => {
    // 类似
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

```bash
pnpm --filter @zn-ai/zai test src/web/store/useEventStream.test.ts
```

期望:FAIL。

- [ ] **Step 3: 修改 useEventStream.ts**

`packages/zai/src/web/src/store/useEventStream.ts:148-152`,扩展 switch:

```ts
case 'subagent.start':
  useAgentStore.getState().applySubagentStart(event as SubagentStartEvent)
  break
case 'subagent.end':
  useAgentStore.getState().applySubagentEnd(event as SubagentEndEvent)
  break
case 'subagent.descriptor':
  useAgentStore.getState().applySubagentDescriptor(event as SubagentDescriptorEvent)
  break
case 'subagent.state':
  useAgentStore.getState().applySubagentState(event as SubagentStateEvent)
  break
case 'subagent.message':
  useAgentStore.getState().applySubagentMessage(event as SubagentMessageEvent)
  break
case 'subagent.error':
  useAgentStore.getState().applySubagentError(event as SubagentErrorEvent)
  break
case 'subagent.changed':
  // @deprecated 自 2026-09-30 后由 feature flag 关闭
  useAgentStore.getState().applySubagentChanged(event as never)
  break
```

- [ ] **Step 4: 跑测试,确认通过**

```bash
pnpm --filter @zn-ai/zai test src/web/store/useEventStream.test.ts
```

期望:PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/web/src/store/useEventStream.ts packages/zai/test/web/store/useEventStream.test.ts
git commit -m "feat(zai): useEventStream 分发 6 个 subagent vendor 事件到 reducer"
```

---

## Task 14: SubagentsTab 加 Fork toggle + Continue 按钮 + state 渲染

**Files:**
- Modify: `packages/zai/src/web/src/components/splitPane/SubagentsTab.tsx`
- Test: `packages/zai/test/web/components/splitPane/SubagentsTab.test.tsx`(新建)

**Interfaces:**
- Consumes: Task 12 store 新字段(state / descriptor / provider);`POST /api/subagent-tasks` 接 `provider` 字段;`POST /api/subagent-tasks/:id/continuable` 端点
- Produces:
  - 子代理创建弹窗加 Fork toggle(`provider: 'spawn' | 'fork'`)
  - 已结束子代理行加 "Continue" 按钮 → 调 `/continuable` 端点
  - 每个 subagent 行按 `state` 显示(running → spinner / waiting → 静态 + 提示 / settled → 已结束)

- [ ] **Step 1: 写失败测试**

`packages/zai/test/web/components/splitPane/SubagentsTab.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SubagentsTab } from '../../../../../src/web/src/components/splitPane/SubagentsTab.js'

describe('SubagentsTab Fork toggle + Continue 按钮', () => {
  it('子代理创建弹窗含 Fork toggle', () => {
    render(<SubagentsTab sessionId="s1" />)
    fireEvent.click(screen.getByText('新建子代理'))
    expect(screen.getByLabelText('Fork(携带父上下文)')).toBeInTheDocument()
  })

  it('Fork toggle 切换 provider 状态', () => {
    render(<SubagentsTab sessionId="s1" />)
    fireEvent.click(screen.getByText('新建子代理'))
    const toggle = screen.getByLabelText('Fork(携带父上下文)')
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)
    expect(toggle).toBeChecked()
  })

  it('已结束子代理显示 Continue 按钮', () => {
    // mock store 有 done 状态子代理
    // 验证 Continue 按钮存在
  })

  it('点击 Continue 调 POST /:id/continuable', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{"childId":"c1","messageId":"m1"}'))
    // mock store 有 done 状态子代理
    render(<SubagentsTab sessionId="s1" />)
    fireEvent.click(screen.getByText('Continue'))
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/subagent-tasks/abc/continuable'),
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

```bash
pnpm --filter @zn-ai/zai test src/web/components/splitPane/SubagentsTab.test.tsx
```

期望:FAIL。

- [ ] **Step 3: 修改 SubagentsTab.tsx**

**a. 创建弹窗加 Fork toggle:**

找到现有"新建子代理"弹窗(`Modal` / `Drawer`),在表单中加:

```tsx
<Form.Item label="运行模式" name="provider">
  <Radio.Group>
    <Radio value="spawn">Spawn(独立子代理)</Radio>
    <Radio value="fork">Fork(携带父上下文)</Radio>
  </Radio.Group>
</Form.Item>
```

POST body 增加 `provider` 字段。

**b. subagent 行加 Continue 按钮(仅 done 状态):**

```tsx
{task.status === 'done' && (
  <Button size="small" onClick={() => handleContinue(task.taskId)} aria-label="继续子代理对话">
    Continue
  </Button>
)}
```

```tsx
const handleContinue = async (taskId: string) => {
  await fetch(`/api/subagent-tasks/${taskId}/continuable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '' }),  // 首次续聊 prompt 可空
  })
}
```

**c. state 渲染:**

```tsx
{task.state === 'running' && <Spin size="small" />}
{task.state === 'waiting' && <Tag color="orange">等待子代理回复</Tag>}
{task.state === 'settled' && <Tag color="default">已结束</Tag>}
```

> 注:具体实现需读现有 SubagentsTab.tsx 实际结构,按本计划骨架填充。

- [ ] **Step 4: 跑测试,确认通过**

```bash
pnpm --filter @zn-ai/zai test src/web/components/splitPane/SubagentsTab.test.tsx
```

期望:PASS(4 tests)。

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/web/src/components/splitPane/SubagentsTab.tsx packages/zai/test/web/components/splitPane/SubagentsTab.test.tsx
git commit -m "feat(zai): SubagentsTab 加 Fork toggle + Continue 按钮 + state 渲染"
```

---

## Task 15: SubagentDetailBody 新增 ContentBlockRenderer(5 种 type 渲染)

**Files:**
- Modify: `packages/zai/src/web/src/components/splitPane/SubagentDetailBody.tsx`

**Interfaces:**
- Consumes: Task 12 `blocks: SubagentContentBlock[]` 字段;zai 现有 `ThinkingBlock` / `MarkdownText` / image 渲染组件
- Produces: `ContentBlockRenderer` 组件按 `block.type` 分支渲染;未知 type 降级 `<pre>{JSON}</pre>`

- [ ] **Step 1: 写失败测试**

`packages/zai/test/web/components/splitPane/SubagentDetailBody.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SubagentDetailBody } from '../../../../../src/web/src/components/splitPane/SubagentDetailBody.js'

describe('SubagentDetailBody ContentBlock 渲染', () => {
  it('renders thinking block', () => {
    render(<SubagentDetailBody taskId="r1" blocks={[{ type: 'thinking', thinking: 'reasoning...' }]} />)
    expect(screen.getByText(/reasoning\.\.\./)).toBeInTheDocument()
  })

  it('renders text block via markdown', () => {
    render(<SubagentDetailBody taskId="r1" blocks={[{ type: 'text', text: '**hello**' }]} />)
    expect(screen.getByText('hello')).toBeInTheDocument()
  })

  it('renders tool_use block', () => {
    render(<SubagentDetailBody taskId="r1" blocks={[{ type: 'tool_use', id: 'a', name: 'Read', input: { path: '/x' } }]} />)
    expect(screen.getByText(/Read/)).toBeInTheDocument()
  })

  it('renders tool_result block', () => {
    render(<SubagentDetailBody taskId="r1" blocks={[{ type: 'tool_result', tool_use_id: 'a', content: 'output' }]} />)
    expect(screen.getByText(/output/)).toBeInTheDocument()
  })

  it('renders image block via img tag', () => {
    render(<SubagentDetailBody taskId="r1" blocks={[{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '...' } }]} />)
    expect(screen.getByRole('img')).toBeInTheDocument()
  })

  it('unknown type renders as pre with JSON', () => {
    // @ts-expect-error 测试未知 type
    render(<SubagentDetailBody taskId="r1" blocks={[{ type: 'bogus', x: 1 }]} />)
    expect(screen.getByText(/"type":"bogus"/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

```bash
pnpm --filter @zn-ai/zai test src/web/components/splitPane/SubagentDetailBody.test.tsx
```

期望:FAIL。

- [ ] **Step 3: 修改 SubagentDetailBody.tsx**

新增 `ContentBlockRenderer` 组件,接 `block: SubagentContentBlock`:

```tsx
function ContentBlockRenderer({ block }: { block: SubagentContentBlock }) {
  if (block.type === 'thinking') {
    return <ThinkingBlock content={block.thinking} />
  }
  if (block.type === 'text') {
    return <MarkdownText>{block.text}</MarkdownText>
  }
  if (block.type === 'tool_use') {
    return (
      <div className="border rounded p-2 my-1 bg-gray-50">
        <div className="text-xs font-mono">� {block.name}</div>
        <pre className="text-xs">{JSON.stringify(block.input, null, 2)}</pre>
      </div>
    )
  }
  if (block.type === 'tool_result') {
    return (
      <div className="border-l-2 border-blue-300 pl-2 my-1 text-sm">
        {block.is_error ? '❌ ' : '✅ '}
        <pre className="inline">{typeof block.content === 'string' ? block.content : JSON.stringify(block.content, null, 2)}</pre>
      </div>
    )
  }
  if (block.type === 'image') {
    return (
      <img
        src={`data:${block.source.media_type};base64,${block.source.data}`}
        alt="子代理图片"
        className="max-w-full"
      />
    )
  }
  // 未知 type — 降级 raw JSON
  return (
    <pre className="bg-yellow-50 p-2 text-xs">
      {JSON.stringify(block, null, 2)}
    </pre>
  )
}
```

把 `task.toolCalls` 渲染替换为 `task.blocks` 渲染:

```tsx
{task.blocks?.map((block, i) => <ContentBlockRenderer key={i} block={block} />)}
```

若 `task.lastAssistantMessage` 有值,在末尾显示。

- [ ] **Step 4: 跑测试,确认通过**

```bash
pnpm --filter @zn-ai/zai test src/web/components/splitPane/SubagentDetailBody.test.tsx
```

期望:PASS(6 tests)。

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/web/src/components/splitPane/SubagentDetailBody.tsx packages/zai/test/web/components/splitPane/SubagentDetailBody.test.tsx
git commit -m "feat(zai): SubagentDetailBody 支持 ContentBlock[] 渲染(thinking/text/tool_use/tool_result/image)"
```

---

## Task 16: MobileAgent + MobileQuickDrawer 加 subagent 列表

**Files:**
- Modify: `packages/zai/src/web/src/pages/m/MobileAgent.tsx`
- Modify: `packages/zai/src/web/src/components/MobileQuickDrawer.tsx`
- Test: `packages/zai/test/web/pages/m/MobileAgent.test.tsx`(新建/补)

**Interfaces:**
- Consumes: Task 12 store `subagentTasksBySession`;Task 14 `SubagentsTab` 简化版
- Produces: `<SubagentList />` 折叠面板显示当前 session 的 subagent 任务列表 + state;MobileQuickDrawer 末尾新增 "Subagents" 入口

- [ ] **Step 1: 写失败测试**

`packages/zai/test/web/pages/m/MobileAgent.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MobileAgent } from '../../../../../src/web/src/pages/m/MobileAgent.js'
import { useAgentStore } from '../../../../../src/web/src/store/useAgentStore.js'

describe('MobileAgent subagent 列表', () => {
  it('显示 subagent 折叠面板', () => {
    useAgentStore.getState().applySubagentStart({
      type: 'subagent.start', ts: 0, sessionId: 's1', runId: 'r1',
      provider: 'spawn', id: 'x', local: true,
    })
    render(<MobileAgent sessionId="s1" />)
    expect(screen.getByText(/Subagents/i)).toBeInTheDocument()
  })

  it('点击 Subagents 展开列表', () => {
    // 类似
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

```bash
pnpm --filter @zn-ai/zai test src/web/pages/m/MobileAgent.test.tsx
```

期望:FAIL。

- [ ] **Step 3: 修改 MobileAgent.tsx**

`packages/zai/src/web/src/pages/m/MobileAgent.tsx`:

新增 `<SubagentList />`:

```tsx
function SubagentList({ sessionId }: { sessionId: string }) {
  const tasks = useAgentStore(s => s.subagentTasksBySession[sessionId] ?? [])
  return (
    <Collapse>
      <Collapse.Panel header={`Subagents (${tasks.length})`} key="subagents">
        {tasks.map(task => (
          <div key={task.taskId} className="py-2 border-b">
            <div className="font-medium">{task.taskId.slice(0, 16)}...</div>
            <div className="text-xs text-gray-500">
              {task.state === 'running' && '🔄 运行中'}
              {task.state === 'waiting' && '⏸ 等待'}
              {task.state === 'settled' && '✓ 已结束'}
              {' · '}
              {task.status}
            </div>
            <SubagentDetailBody taskId={task.taskId} blocks={task.blocks ?? []} />
          </div>
        ))}
      </Collapse.Panel>
    </Collapse>
  )
}
```

主页面挂载:

```tsx
<SubagentList sessionId={sessionId} />
```

`MobileQuickDrawer.tsx`:在末尾追加 toggle:

```tsx
<Button onClick={() => setShowSubagents(true)} aria-label="Subagents">
  Subagents
</Button>
{showSubagents && (
  <Drawer open onClose={() => setShowSubagents(false)} title="Subagents">
    <SubagentList sessionId={currentSessionId} />
  </Drawer>
)}
```

- [ ] **Step 4: 跑测试,确认通过**

```bash
pnpm --filter @zn-ai/zai test src/web/pages/m/MobileAgent.test.tsx
```

期望:PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/web/src/pages/m/MobileAgent.tsx packages/zai/src/web/src/components/MobileQuickDrawer.tsx packages/zai/test/web/pages/m/MobileAgent.test.tsx
git commit -m "feat(zai): MobileAgent + MobileQuickDrawer 加 subagent 列表"
```

---

## Task 17: OpenCC 模式 SubagentsTab / SubagentsDrawer / MobileAgent 空态显示 "DSH 模式专享"

**Files:**
- Modify: `packages/zai/src/web/src/components/splitPane/SubagentsTab.tsx`(空态分支)
- Modify: `packages/zai/src/web/src/components/SubagentsDrawer.tsx`(空态分支)
- Modify: `packages/zai/src/web/src/pages/m/MobileAgent.tsx`(空态分支)

**Interfaces:**
- Consumes: zai `useKernel` 或 store 当前 kernel 名称
- Produces: 三处空态显示"当前 kernel=X 不支持 subagent,请切换到 dsh 模式" + 设置页跳转链接

- [ ] **Step 1: 写失败测试**

`packages/zai/test/web/components/splitPane/SubagentsTab.test.tsx` 追加(在 Task 14 测试基础上):

```tsx
it('OpenCC 模式空态显示 DSH 模式专享提示', () => {
  // mock 当前 kernel = 'opencc',subagentTasksBySession 为空
  render(<SubagentsTab sessionId="s1" />)
  expect(screen.getByText(/DSH 模式专享/)).toBeInTheDocument()
})
```

- [ ] **Step 2: 跑测试,确认失败**

```bash
pnpm --filter @zn-ai/zai test src/web/components/splitPane/SubagentsTab.test.tsx
```

期望:FAIL。

- [ ] **Step 3: 修改三处组件**

获取当前 kernel:zai store 或 hook(具体查 `useAgentStore.getCurrentKernel()` 或类似)。

`SubagentsTab.tsx`:

```tsx
const currentKernel = useAgentStore(s => s.currentKernel)
const tasks = useAgentStore(s => s.subagentTasksBySession[sessionId] ?? [])

if (tasks.length === 0) {
  if (currentKernel !== 'dsh') {
    return (
      <Empty description={
        <span>
          当前 kernel = <code>{currentKernel}</code> 不支持 subagent。
          请切换到 <strong>dsh</strong> 模式(
          <a href="/config">配置页</a>)。
        </span>
      } />
    )
  }
  return <Empty description="暂无子代理任务" />
}
```

`SubagentsDrawer.tsx` 和 `MobileAgent.tsx` 同样处理。

- [ ] **Step 4: 跑测试,确认通过**

```bash
pnpm --filter @zn-ai/zai test src/web/components/splitPane/SubagentsTab.test.tsx
```

期望:PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/web/src/components/splitPane/SubagentsTab.tsx packages/zai/src/web/src/components/SubagentsDrawer.tsx packages/zai/src/web/src/pages/m/MobileAgent.tsx packages/zai/test/web/components/splitPane/SubagentsTab.test.tsx
git commit -m "feat(zai): OpenCC 模式 subagent UI 空态显示 DSH 模式专享提示"
```

---

## Task 18: 移除 deprecated:createAgentTool / registerAgentTool / notifyParentSession

**Files:**
- Modify: `packages/dsh-bridge/src/tools/subagent.ts:131-322`(删除 `createAgentTool` + `registerAgentTool`)
- Modify: `packages/dsh-bridge/src/subagent/taskStore.ts:533-588`(删除 `notifyParentSession`)
- Modify: `packages/dsh-bridge/src/index.ts`(删除 re-export)
- Grep: 全仓搜索 import 并删除

**Interfaces:**
- Produces: dsh-bridge 不再导出 deprecated API;zai-side 调用方已全部移除

- [ ] **Step 1: 找 import 方**

```bash
cd /Users/ethan/code/opencc-web
grep -rn "createAgentTool\|registerAgentTool\|notifyParentSession" packages/
```

期望:列出所有 import / 调用位置。

- [ ] **Step 2: 删除 export**

`packages/dsh-bridge/src/tools/subagent.ts`:删除整段 `createAgentTool` + `registerAgentTool` 函数(行 131-322)。

`packages/dsh-bridge/src/subagent/taskStore.ts`:删除 `notifyParentSession` export + 函数体。

`packages/dsh-bridge/src/index.ts`:删除 re-export。

- [ ] **Step 3: 删除调用方**

根据 Step 1 grep 结果,删除每个 import + 调用位置(预计 0-3 处)。

- [ ] **Step 4: 跑测试,确认通过**

```bash
pnpm --filter @zn-ai/dsh-bridge test
pnpm --filter @zn-ai/zai test src/shared src/server/services/kernel src/web/hooks/useSubagentTasks src/web/components/splitPane src/web/pages/m
```

期望:全 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-bridge/src/tools/subagent.ts packages/dsh-bridge/src/subagent/taskStore.ts packages/dsh-bridge/src/index.ts <删除的调用方文件>
git commit -m "refactor(dsh-bridge): 移除 deprecated createAgentTool/registerAgentTool/notifyParentSession"
```

---

## Task 19: 移除 globalThis 桥 `__zaiDshSubagentControl` / `__zaiDshSubagentDetail`

**Files:**
- Modify: `packages/zai/src/server/services/kernel/factories/dsh.ts:710-790`(已部分删除,Task 9 已处理)
- Grep: 全仓搜 globalThis 桥的读侧

**Interfaces:**
- Produces: 无任何 globalThis 桥读写;全部走 seamRegistry

- [ ] **Step 1: 找读侧**

```bash
cd /Users/ethan/code/opencc-web
grep -rn "__zaiDshSubagentControl\|__zaiDshSubagentDetail" packages/
```

期望:列出所有读 globalThis 桥的代码(预计 `subagentTasks.ts`、`backgroundRuntime.ts`、其他)。

- [ ] **Step 2: 删除读侧 + 写侧**

- 写侧:已 Task 9 删除
- 读侧:每个 grep 命中的文件,删除 `globalThis.__zai...` 访问,改走 `kernel.getSeam('subagent')`

- [ ] **Step 3: 跑测试,确认通过**

```bash
pnpm --filter @zn-ai/zai test src/server
pnpm -r test -t "subagent"
```

期望:全 PASS。

- [ ] **Step 4: 验证 grep 为空**

```bash
grep -rn "__zaiDshSubagent" packages/
```

期望:无输出。

- [ ] **Step 5: 提交**

```bash
git add <所有修改文件>
git commit -m "refactor(zai): 移除 globalThis 桥 __zaiDshSubagentControl/Detail,全部走 seamRegistry"
```

---

## Task 20: 全量测试基线 + ego-browser 真实浏览器验收

**Files:** 无新文件,跑现有测试 + ego-browser

**Interfaces:**
- Consumes: Task 1-19 所有产出
- Produces: 验收报告(15 项 ego-browser 检查)

- [ ] **Step 1: dsh-bridge 测试基线**

```bash
pnpm --filter @zn-ai/dsh-bridge test
```

期望:PASS(预计 175+ tests,原 135 + 本计划新增 40+)。若 FAIL,修。

- [ ] **Step 2: zai 测试基线(仅受影响文件)**

```bash
pnpm --filter @zn-ai/zai test src/shared
pnpm --filter @zn-ai/zai test src/server/services/kernel
pnpm --filter @zn-ai/zai test src/server/services/stateBridge
pnpm --filter @zn-ai/zai test src/server/routes/subagentTasks
pnpm --filter @zn-ai/zai test src/web/store/useAgentStore
pnpm --filter @zn-ai/zai test src/web/store/useEventStream
pnpm --filter @zn-ai/zai test src/web/hooks/useSubagentTasks
pnpm --filter @zn-ai/zai test src/web/components/splitPane/SubagentsTab
pnpm --filter @zn-ai/zai test src/web/components/splitPane/SubagentDetailBody
pnpm --filter @zn-ai/zai test src/web/pages/m/MobileAgent
```

期望:全 PASS。

- [ ] **Step 3: typecheck**

```bash
pnpm --filter @zn-ai/zai typecheck
pnpm --filter @zn-ai/dsh-bridge typecheck
```

期望:PASS。

- [ ] **Step 4: 启动 DSH 模式 zai**

```bash
# 确认空闲端口
lsof -i :8102 || echo "8102 free"
lsof -i :7715 || echo "7715 free"

pnpm --filter @zn-ai/zai dev -- --port 8102 --api-port 7715 --kernel=dsh
```

期望:启动成功,日志显示 `kernel=dsh`。

- [ ] **Step 5: ego-browser 真实浏览器验收 15 项**

调用 `/ego-browser` skill,逐项验证(spec §15.2):

1. DSH 模式 subagent.start/end/state/descriptor/message 事件在 SSE 日志可见
2. Fork subagent → "Forked from ..." 标签
3. Spawn subagent 默认
4. capability outputSchema → 结构化 JSON
5. capability toolFilter → 仅指定工具
6. capability persona → persona 行事
7. completionDelivery wakeup → 父 transcript 注入消息
8. completionDelivery quiet → 父静默
9. 状态机切换 → waiting 提示
10. Continuable 续聊 → 多轮对话
11. Send message → 子代理回复
12. Interrupt → UI 显示已中断
13. OpenCC 模式 → "DSH 模式专享" 提示
14. /m 移动端 → subagent 折叠面板
15. /m 移动端 → SubagentDetail full-screen sheet

每项截图 + 验证日志。

- [ ] **Step 6: 提交验收报告**

```bash
git add docs/superpowers/plans/2026-08-24-dsh-subagent-task-alignment-verification.md
git commit -m "docs: DSH subagent 全面对齐 vendor 验收报告(ego-browser 15 项通过)"
```

---

## Self-Review Checklist(实施完后自验)

- [ ] spec §4 事件 schema 对齐:`shared/subagentEvents.ts` + `stateBridge.ts` 6 个事件转发 + `useEventStream.ts` 6 个 handler(任务 1, 2, 11, 13)
- [ ] spec §5 capability 全接:taskStore opts + dispatch 透传 + zai factory 透传(任务 4, 7, 9)
- [ ] spec §6 completionDelivery 真接:taskStore 默认值 + factory 从 settings.json 读(任务 4, 9)
- [ ] spec §7 Fork 真启用:SubagentsTab toggle + POST body 透传(任务 14)
- [ ] spec §7 Continuable 启用:continuation.ts + adapter.startContinuable + 路由端点 + UI 按钮(任务 5, 7, 10, 14)
- [ ] spec §8 状态机透传:`subagent.state` 事件 + reducer + UI 渲染(任务 1, 6, 12, 14)
- [ ] spec §9 ContentBlock 渲染:contentBlock.ts + ContentBlockRenderer(任务 3, 15)
- [ ] spec §10 VendorSeam 真接线:SeamRegistry + bindSeams + factory 注入(任务 8, 9)
- [ ] spec §10 移除 globalThis 桥:任务 19
- [ ] spec §11 移动端:MobileAgent + MobileQuickDrawer(任务 16)
- [ ] spec §13 OpenCC UI 标识:任务 17
- [ ] spec §12 测试:任务 1-17 所有测试 + 任务 20 baseline
- [ ] spec §14 风险缓解:completionDelivery wakeup 失败 → Toast;fork vendor 失败 → 降级 spawn;startContinuable 失败 → 503
- [ ] spec §15 验收:任务 20
- [ ] deprecation 清理:任务 18
