# B. Streaming Tool Execution

| 字段 | 值 |
|---|---|
| Spec 编号 | 2026-07-19-zai-loop-resilience-b |
| 父 spec | [umbrella](./2026-07-19-zai-loop-resilience-master-design.md) |
| 状态 | 设计中 → 待评审 |
| 目标交付 | 在模型 stream 期间并行执行已闭合的 tool_use |
| 工作量 | 3-5 天 |

## 0. 范围

| 在范围 | 不在范围 |
|---|---|
| StreamingToolExecutor 主体实现 | 重写 toolExecution.ts 公共签名(冻结,Agent 只改内部) |
| 与现有 `runtime.tool_call` / `runtime.tool_result` 事件兼容 | 引入新 RuntimeEvent 类型 |
| 并发上限可配置(默认 4) | 工具组优先级调度(留扩展) |
| `tool_use:error` 流式路径 | 决定是否替换 `tengu_streaming_tool_execution_used` 等遥测字段(留 TODO) |

## 1. 背景与目标

zai `runtime/toolExecution.ts` 当前在 turn 末尾 `message_stop` 后**串行**执行所有 `tool_use`。OpenCC 上游 `StreamingToolExecutor` 在 stream 期间并行触发已闭合的 `tool_use`(等待的 Input JSON 完成 + 闭合后即派发),在长 tool 流场景下显著降低端到端延迟。

本 sub-spec 目标:

1. **新增 `StreamingToolExecutor`**:`submit(toolUse)` / `drain(): Promise<ToolResult[]>` / 持续 yield `runtime.tool_call` / `runtime.tool_result` 事件
2. **并发上限保护**:max parallel 由 `config.runtime.streamingToolExecution.maxParallel`(默认 4)控制
3. **可观测性**:stage 进入时 emit 一次性遥测事件(可选),沿用现有 `runtime.tool_call` w/ `parallel: true` 字段(新增 payload 字段)
4. **与现有 executeToolsStreaming 兼容接口**:集成 PR 阶段把串行调度切到 streaming executor

## 2. 公共契约(冻结)

### 2.1 函数签名

```ts
// runtime/streaming/streamingToolExecutor.ts
export interface StreamingToolExecutorOptions {
  tools: Tool[];                       // 工具注册表
  execute: (tool: Tool, input: unknown) => Promise<ToolResult>; // 与 toolExecution.ts 同签名
  maxParallel?: number;                // 默认 4
  signal: AbortSignal;
  sessionId: string;
}

export interface StreamingToolExecutorHandle {
  submit(toolUse: { id: string; name: string; input: unknown }): void;
  drain(): Promise<ToolResult[]>;
  cancel(): void;
}

export function createStreamingToolExecutor(
  opts: StreamingToolExecutorOptions
): StreamingToolExecutorHandle;

// runtime/streaming/events.ts
export type ParallelToolEvent =
  | { type: 'runtime.tool_call'; payload: { toolUseId: string; toolName: string; input: unknown; sessionId: string; parallel: boolean } }
  | { type: 'runtime.tool_result'; payload: { toolUseId: string; toolName: string; ok: boolean; output: string; sessionId: string } };
```

### 2.2 事件 / 字段 schema

`runtime.tool_call` payload 增加 **`parallel: boolean`** 字段(zod 可选);`runtime.tool_result` 不变。

```ts
// 新增可选字段
runtime.tool_call = {
  type: 'runtime.tool_call',
  payload: {
    toolUseId: string;
    toolName: string;
    input: unknown;     // 注意:与现有 input 字段同语义,只是上层 JSON 解析已完成
    sessionId: string;
    parallel?: boolean; // 本集新增,StreamingToolExecutor 派发的为 true
  }
}
```

### 2.3 配置键(从 umbrella §3.3 引用)

| Key | 类型 | 默认 |
|---|---|---|
| `config.runtime.streamingToolExecution` | `'on' \| 'off'` | `'on'` |
| `config.runtime.streamingToolExecution.maxParallel` | number | 4 |

### 2.4 错误契约

- 工具 execute throw → 不中断 stream,记为 `ok:false`,产出 `runtime.tool_result` w/ `ok:false`
- `cancel()` 调用 → 终止 drain,返回已收结果
- `AbortSignal` abort → 终止 drain,返回已收结果(可能不完整)
- `submit(toolUse)` 后若 tool 不存在 / invalid input → 不抛,记 `runtime.tool_call` w/ invalid,后续 yield `tool_result` w/ `ok:false, output: 'tool not found'`

### 2.5 接入点(hint)

| 位置 | 调用 |
|---|---|
| toolExecution.ts 顶部 | 若 `config.runtime.streamingToolExecution === 'on'`, 把串行循环替换为 `createStreamingToolExecutor({...})` + `submit(drain())` |
| queryLoop.ts for-await 内 | 不变(StreamingExecutor 自身 yield RuntimeEvent,沿用上游事件通道) |

集成 PR 阶段只动 toolExecution.ts 顶部 ~10 行(替换调度)。

## 3. 行为列表

1. `createStreamingToolExecutor` 内部维护 `maxParallel` 个并发 worker 队列
2. `submit(toolUse)` 入队;已达 maxParallel 时阻塞直到 worker 空出
3. 工具 execute 完成后立即 yield `runtime.tool_result`
4. 工具 execute 异常 → 仍 yield `runtime.tool_result` w/ `ok:false, output: <err.message>`
5. `drain()` 等待所有已 submit 的 tool_use 完成后返回结果数组
6. `cancel()` 后 drain() 立即 resolve(可能空数组)
7. 输入 toolUse 不存在于 tools 列表 → yield `runtime.tool_call` w/ invalid,`runtime.tool_result` w/ `ok:false`
8. parallel 字段在 streaming 派发的 tool_call 上恒为 `true`
9. `AbortSignal` abort 后 executor 立刻停接新 submit,正 in-flight 的 worker 留给它们最终化,完成后 drain resolve

## 4. 测试点

```
packages/zai-agent-core/test/integration/agent/resilience/b-streaming-tool-execution.test.ts
  ✓ submit + drain returns results in completion order
  ✓ submit respects maxParallel (4 concurrent at most)
  ✓ submit yields tool_call with parallel:true via event listener
  ✓ submit yields tool_result after each tool completes
  ✓ submit with non-existent tool returns ok:false, output:'tool not found'
  ✓ execute throws → drains with ok:false, output=<err.message>, stream continues
  ✓ cancel() immediately resolves drain even with pending toolUses
  ✓ AbortSignal abort → drain resolves with completed subset
  ✓ full integration: 10 toolUses submitted in burst, all complete within reasonable time
```

## 5. 验收门

1. `pnpm --filter @zn-ai/zai-agent-core typecheck`
2. `pnpm --filter @zn-ai/zai-agent-core test test/integration/agent/resilience/b-*`
3. `pnpm --filter @zn-ai/zai-agent-core test`(全量)— auto-compact-turn-loop.test.ts 仍绿
4. 单测中模拟 10 个并行 tool,end-to-end 时间 < 串行 60%

## 6. 风险与边界场景

1. **信号 abort 与 worker race**:abort 后 in-flight 必须等到自然完成才 resolve(不强行 kill 进程)
2. **JSON 输入校验**:streaming 时 model 给的 input_json 可能不完整,submit 仅接受"已闭合"的 tool_use(input 字段必须已被上游解析为对象)— Agent 决定如何校验(duck-type)
3. **maxParallel=0 或负数**:防御性 default 到 1
4. **可观测遥测**:见 §2.3,Agent 可选实现 `tengu_streaming_tool_execution_used`-类似的事件,本 spec 不强制
5. **与 /compact 串扰**:streaming executor 不影响 transcript 写盘;后者沿 `appendAssistantMessageV2`

## 7. 不锁定

- 内部并发结构(Promise queue / semaphore / rxjs)— 自由
- 队列调度顺序(FIFO / LIFO)— 自由
- 文件命名(`runtime/streaming/streamingToolExecutor.ts` 为建议)
- 测试用 fake timers / real timers — 自由
