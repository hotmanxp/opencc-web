# C. Stop Hook 阻断 + Continuation Nudge

| 字段 | 值 |
|---|---|
| Spec 编号 | 2026-07-19-zai-loop-resilience-c |
| 父 spec | [umbrella](./2026-07-19-zai-loop-resilience-master-design.md) |
| 状态 | 设计中 → 待评审 |
| 目标交付 | Stop hook 主动阻断 turn + 续接 nudge |
| 工作量 | 2-3 天 |

## 0. 范围

| 在范围 | 不在范围 |
|---|---|
| `HookRunner.run('Stop', ...)` 加 `blocking: boolean` 字段 | Hook 注册流程改动(冻结,Agent 仅扩展 payload 字段) |
| `analyzeContinuationIntent(text, lastBlockKind)` 检测模型停摆 | 重写 HookRunner 主体 |
| `injectContinuationNudge(events)` 触发下一轮 | OpenCC CLI REPL 才有的 stop hook 阻断 REPL 退出行为(无 server 场景不需要) |
| 累计 max nudge 次数 | Skill skill_loop 等其他 hook 类型 |

## 1. 背景与目标

zai `plugins/HookRunner.run('Stop', ...)` 当前不阻断 — hook 仅观测;且 zai 没有 continuation nudge。模型在 stream 末尾没有出 `tool_use` 但仍在描述后续工作时,需要 nudge 强制下一轮。

本 sub-spec 目标:

1. **Stop hook blocking**:hook 可抛 `HookBlockedError`,wire-in 捕获后 yield `runtime.error` w/ `kind:'hook_blocked'`,跳出 loop
2. **Continuation intent 分析**:`analyzeContinuationIntent(text, lastBlock)` → 'needs-tool' / 'complete'
3. **Nudge 注入**:`injectContinuationNudge(...)` 在 'needs-tool' 时插入一条 assistant message 强制下一轮
4. **max nudge 截断**:累计 nudge 次数达到 `continuationNudgeMax` 后即使 'needs-tool' 也不再 nudge,转 'complete'

## 2. 公共契约(冻结)

### 2.1 函数签名

```ts
// runtime/nudge/analyze.ts
export type LastBlockKind = 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'mixed';

export type ContinuationIntent = 'needs-tool' | 'complete';

export function analyzeContinuationIntent(
  text: string,
  lastBlockKind: LastBlockKind
): ContinuationIntent;

// runtime/nudge/inject.ts
export interface NudgeCounters {
  consecutive: number;       // 连续 nudge 计数
  total: number;            // 全 turn 总数
}

export interface InjectNudgeOptions {
  counters: NudgeCounters;
  max?: number;             // 默认 config.runtime.continuationNudgeMax = 20
  enabled?: boolean;        // 默认 config.runtime.continuationNudgeEnabled
}

export interface InjectNudgeResult {
  inject: boolean;
  reason: 'needs-tool-max' | 'complete' | 'disabled' | 'needs-tool-injected';
  nudgeMessage?: RuntimeEvent; // 要 yield 的 nudge assistant message
  counters: NudgeCounters;     // 更新后的 counter
}

export function injectContinuationNudge(
  intent: ContinuationIntent,
  opts: InjectNudgeOptions
): InjectNudgeResult;

// runtime/nudge/hooks.ts
export interface StopHookBlockingError extends Error {
  name: 'HookBlockedError';
  hookName: string;
  reason?: string;
}

// plugins/HookRunner (扩展 payload 字段,Agent 修改)
export interface StopHookPayload {
  // ... existing fields
  blocking: boolean;      // 本集新增:hook 在阻断时抛 HookBlockedError
}
```

### 2.2 事件 / 字段 schema

`runtime.error` payload 增加 `kind: 'hook_blocked'`(`'hook_blocked'` 已是 A 集 `ErrorKind` union 的成员;见 [`a-errors-design §2.1`](./2026-07-19-zai-loop-resilience-a-errors-design.md))。前端 `useAgentStore.applyRuntimeEvent` 不需改。

```ts
runtime.error = {
  payload: {
    message: string;
    fatal: boolean;
    kind?: ErrorKind;        // A 的 ErrorKind 已包含 'hook_blocked'
    toolUseId?: string;
    hookName?: string;       // kind === 'hook_blocked' 时填
  }
}
```

### 2.3 配置键(从 umbrella §3.3 引用)

| Key | 类型 | 默认 |
|---|---|---|
| `config.runtime.continuationNudgeMax` | number | 20 |
| `config.runtime.continuationNudgeEnabled` | boolean | true |

### 2.4 错误契约

- `analyzeContinuationIntent` **永不抛**, 纯函数
- `injectContinuationNudge` **永不抛**, 纯函数;返回 `InjectNudgeResult`
- Hook 阻断抛 `StopHookBlockingError` → wire-in 捕获,转 `runtime.error`,不抛
- 已 nudge 多次到 max → 不再 nudge(返 `needs-tool-max`);不抛

### 2.5 接入点

| 位置 | 调用 |
|---|---|
| queryLoop.ts turn 末尾(message_stop break 后) | `analyzeContinuationIntent(text, lastBlockKind)` |
| 同一位置 | `injectContinuationNudge(intent, { counters, ... })` → if inject, yield nudgeMessage + continue loop |
| HookRunner.run('Stop', { ...payload, blocking: true }) 处(在 queryLoop.ts) | 捕获 `HookBlockedError` → yield `runtime.error` w/ kind:'hook_blocked' + break loop |

集成 PR 阶段在 queryLoop.ts 顶端加 < 30 行 wire-in。

## 3. 行为列表

1. `analyzeContinuationIntent(text, lastBlock)`:若 lastBlock='tool_use' → 'complete';若 text 含 continuation marker(`'我会继续'` `'下一步'` `'<next>'` 等可配置列表) → 'needs-tool';其它 'complete'
2. `analyzeContinuationIntent` 文本为空 → 'complete'
3. `injectContinuationNudge` intent='complete' → `{ inject: false, reason: 'complete' }`
4. `injectContinuationNudge` intent='needs-tool' + consecutive=0 → nudge,counter.consecutive=1
5. `injectContinuationNudge` intent='needs-tool' + consecutive=10 + max=20 → nudge
6. `injectContinuationNudge` intent='needs-tool' + consecutive=20 + max=20 → `{ inject: false, reason: 'needs-tool-max' }`,不 nudge
7. `injectContinuationNudge` 关闭 (enabled=false) → `{ inject: false, reason: 'disabled' }`
8. Hook 抛 `HookBlockedError` → wire-in 捕获后 yield `runtime.error` w/ kind='hook_blocked', hookName, reason
9. Hook 抛非 HookBlockedError → 不视为阻断,继续(原行为不变)
10. Nudge message 是合法的 assistant RuntimeEvent 块(可被 transcript 正确持久化)

## 4. 测试点

```
packages/zai-agent-core/test/integration/agent/resilience/c-continuation-nudge.test.ts
  ✓ analyzeContinuationIntent with lastBlock=tool_use → 'complete'
  ✓ analyzeContinuationIntent with text containing 'next' marker → 'needs-tool'
  ✓ analyzeContinuationIntent with empty text → 'complete'
  ✓ injectContinuationNudge intent='complete' → inject:false
  ✓ injectContinuationNudge intent='needs-tool' consecutive=0 → inject:true, counter=1
  ✓ injectContinuationNudge consecutive=max → inject:false reason='needs-tool-max'
  ✓ injectContinuationNudge enabled=false → inject:false reason='disabled'
  ✓ counter.total increments even when consecutive resets to 0

packages/zai-agent-core/test/integration/agent/resilience/c-stop-hook-blocking.test.ts
  ✓ hook throws HookBlockedError → wire-in yields runtime.error kind='hook_blocked', breaks loop
  ✓ hook throws non-HookBlockedError → does NOT break loop, treated as warning
  ✓ hook returns normally → no behavior change
  ✓ runtime.error payload includes hookName and reason from throw
```

## 5. 验收门

1. `pnpm --filter @zn-ai/zai-agent-core typecheck`
2. `pnpm --filter @zn-ai/zai-agent-core test test/integration/agent/resilience/c-*`
3. `pnpm --filter @zn-ai/zai-agent-core test`(全量)
4. HookRunner 不破坏现有 Hook 测试

## 6. 风险与边界场景

1. **与现有 HookRunner 兼容**:payload 加 `blocking` 字段是**纯 additive**,不破坏现有 hook 注册
2. **Nudge 触发过频**:consecutive 计数到 max 强制停,避免无限循环 — 已设计
3. **Hook 阻断语义**:本集定义"阻断 = 跳出当前 turn + yield runtime.error";语义与 OpenCC 一致
4. **front-end 无感**:runtime.error.kind 新值无需前端改代码,toast 自动展示 message
5. **counters 持久化**:NudgeCounters 是 loop 内局部状态,turn 跨 session 重置(简单)— 不持久化

## 7. 不锁定

- continuation marker 列表配置 — 自由(可 hardcode 中文 / 英文关键词)
- nudge message 文案 — 自由("continue with the next step" 或 "请继续执行")
- HookRunner 内部 yield 顺序 — 自由
