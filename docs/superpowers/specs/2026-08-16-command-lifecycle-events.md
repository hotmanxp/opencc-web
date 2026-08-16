# 命令生命周期事件埋点 — Design

**Date:** 2026-08-16
**Status:** Implemented (2026-08-16)
**Author:** 借鉴 deepseek-harness `command/run` + `command/done` 配对事件 + `commandId` 关联

## Goal

`/api/agent/command` 路由发 `command.run` / `command.done` 配对 SSE 事件,带 `commandId` 关联,让会话日志、调试、慢命令分析有可靠埋点。

## Background

现状(`packages/zai/src/server/routes/command.ts`):

```ts
commandRouter.post('/command', async (req, res) => {
  // ...
  if (cmd.type === 'local') {
    const result = await cmd.call(args, context)    // 同步等 handler
    return res.json({ type: 'cleared', payload: null })
  }
  // ...
})
```

问题:
- 跑一个命令在 SSE 事件流里**完全不可见** — 看不到什么时候跑、跑多久、结果类型
- 慢命令(>5s 的 `compact` / `handoff`)没有进度信号,前端只能干等
- 出错时只在 HTTP response 里,没有事件总线记录,排查困难
- 调试会话需要"在哪个 turn 跑了哪个命令"配对信息,目前要靠 session log 反推

deepseek-harness 的做法(`packages/interaction/commands/src/index.ts:296-337`):

```ts
// 进入时
ctx.events.dispatch('log', ['command/run', { commandId, name, args, sessionId }])
// 结束时
ctx.events.dispatch('log', ['command/done', { commandId, result, durationMs, error? }])
```

配对用同一个 `commandId`(自带 id, 不依赖 `seq`),日志客户端通过 `commandId` 关联 `run` 和 `done`。

## Scope

- `packages/zai/src/shared/events.ts` discriminated union 新增 `command.run` / `command.done` 两条
- `packages/zai/src/server/routes/command.ts` 在 handler 前后 emit 这两条事件
- 前端无强制改动(老 EventSource 已订阅所有命名事件;若想 UI 显示可加 `command.run` toast)
- 新增 `commandId` 的生成函数(单进程 `crypto.randomUUID()` 即可)

非目标:
- 进度事件(`command.progress`, 留给 prompt 长任务的 `runtime.*` 通道)
- 客户端 UI 必显(可选:加 toast/状态栏)

## Event Schema

```ts
// packages/zai/src/shared/events.ts 追加
const CommandEvent = z.discriminatedUnion('type', [
  z.object({ ...Base.shape, type: z.literal('command.run'),
             sessionId: z.string(),
             commandId: z.string(),         // uuid, run/done 配对
             name: z.string(),              // 命令名, e.g. 'compact'
             args: z.string(),              // 原始 args 字符串
             trigger: z.enum(['user', 'skill']),  // 'user' = /cmd, 'skill' = skill fallthrough
             ts: z.number() }),             // 触发时刻
  z.object({ ...Base.shape, type: z.literal('command.done'),
             sessionId: z.string(),
             commandId: z.string(),
             name: z.string(),
             result: z.enum(['cleared', 'compacted', 'status', 'message', 'prompt', 'error', 'unknown']),
             durationMs: z.number(),
             error: z.string().optional(),  // 异常时填 message
             ts: z.number() }),
])
```

事件分组归 `system.*` 还是 `command.*`? 选 `command.*`(脱出现有 `system.*` 的杂项,语义集中),并在 `shared/events.ts` 的 `NAMED_EVENT_TYPES` 同步加。

## Wiring

```ts
// packages/zai/src/server/routes/command.ts (示意)
import { eventBus } from '../services/eventBus.js'

commandRouter.post('/command', async (req, res) => {
  const { name, args = '', sessionId } = (req.body ?? {}) as CommandRequestBody
  const commandId = crypto.randomUUID()
  const sid = sessionId ?? getCurrentSessionId() ?? ''

  const startedAt = Date.now()

  eventBus.emit({
    type: 'command.run',
    sessionId: sid,
    commandId,
    name: name ?? '',
    args,
    trigger: 'user',
    ts: startedAt,
  })

  try {
    // ... 现有 resolve + handler 逻辑 ...
    const result = await cmd.call(args, context)
    const resultType = result.kind  // 'cleared' | 'compacted' | ...

    eventBus.emit({
      type: 'command.done',
      sessionId: sid,
      commandId,
      name: name ?? '',
      result: resultType,
      durationMs: Date.now() - startedAt,
      ts: Date.now(),
    })

    return res.json(/* 同现有 */)
  } catch (err) {
    eventBus.emit({
      type: 'command.done',
      sessionId: sid,
      commandId,
      name: name ?? '',
      result: 'error',
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
      ts: Date.now(),
    })
    throw err
  }
})
```

Skill fallthrough 路径(`return res.json({ type: 'prompt', payload: { rendered } })`)也要 emit —— `trigger: 'skill'`, `result: 'prompt'`, 完整覆盖。

## Files

### Edited files (~4)

| Path | Change |
|---|---|
| `packages/zai/src/shared/events.ts` | discriminated union 加 `command.run` / `command.done`;导出 `CommandRunEvent` / `CommandDoneEvent` |
| `packages/zai/src/web/src/lib/eventSource.ts` | `NAMED_EVENT_TYPES` 同步加两条 |
| `packages/zai/src/server/routes/command.ts` | 入口 emit `command.run`;三处出口(resolve success / skill fallthrough / exception)各自 emit `command.done` |
| `packages/zai/src/server/services/eventBus.ts` | emit 工具方法足够用,无需改动(确认 `command.*` 不被 sid 过滤 → 应做"全局事件"广播,跟 `session.*` 一致) |

### New files (~1)

| Path | Purpose |
|---|---|
| `packages/zai/test/server/routes/command.lifecycle.test.ts` | 单测:正常 / 异常 / skill fallthrough 三路径都 emit 配对事件,`commandId` 一致,`durationMs >= 0` |

## Migration Steps

1. **`events.ts` 加 schema** — discriminated union 两条新成员,导出 type
2. **`eventSource.ts` 同步 NAMED_EVENT_TYPES** — 否则前端 EventSource 静默丢
3. **`command.ts` 接入** — 入口 + 三处出口, 先保留 `console.log` 临时观察, 跑 `/compact` 验证
4. **单测** — mock `eventBus.emit`, 跑正常 / 异常 / skill fallthrough 三路径
5. **document** — 更新 `docs/DEVELOPMENT_REFERENCE.md` 的 "command router" 章节

## Trade-offs

| 风险 | 缓解 |
|---|---|
| 事件风暴(命令路由被高频调用) | 单条命令 2 个事件, 跟 `runtime.*` 量级相当, 不会爆;EventBus history 256 够 |
| `command.done` 跟 `result.kind` 枚举漂移 | `shared/events.ts` 用 zod enum 强制, drift 编译期挂 |
| 前端误用 `command.run` 当 toast | `NAMED_EVENT_TYPES` 已经使 EventSource 接收, 是否显示由前端 store 决定;不建议默认 toast |
| `trigger: 'user' \| 'skill'` 是否够 | 当前只有两种入口; 后续 AI 内部主动跑命令(暂无)再加 `'agent'` |
| `args` 可能含敏感内容 | `args` 透传, 跟 session log 一致; 后续要做脱敏走 session log 那条统一方案 |

## Open Questions

- `command.run` 与 `command.done` 的 `ts` 字段: 用 `Date.now()` 触发瞬间还是 `eventBus.emit` 自动填的 `ts`? 建议**手动填**触发瞬间, 这样 `run.ts` 和 `done.ts` 都能算 `durationMs`
- `command.run` 的 `args` 字段要不要做长度截断? 建议 1KB 截断, 防止有人输入 1MB 文本
- 前端 UI 是否默认在命令运行时显示一个 "running…" 指示? 暂不做, 留给后续 UI 优化
